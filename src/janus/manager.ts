import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import WebSocket from "ws";
import { calculateDelay } from "../lib/retry";
import { terminate } from "../lib/terminate";
import {
  resilienceConfig,
  janusDebugLevel,
  janusModeEnv,
} from "../lib/env-config";
import { healthMonitor } from "../lib/health";
import { HealthState, ErrorSeverity } from "../lib/health-monitor";
import { patchJanusConfig } from "./jcfg";

const JANUS_WS_PORT = 8188;

export type JanusMode = "hosted" | "bundled" | "unavailable";

export interface JanusManager {
  /** Start Janus. Resolves true when ready, false if unavailable. */
  start(): Promise<boolean>;
  stop(): void;
  readonly wsUrl: string;
  /** Mode is set once at startup and never changes. */
  readonly mode: JanusMode;
  /**
   * Called whenever Janus becomes available other than through start()'s
   * result: after a restart, a hosted recovery, or a late first availability.
   */
  onAvailable(callback: () => void): void;
}

export function createJanusManager(): JanusManager {
  let proc: ChildProcess | null = null;
  let stopped = false;
  let restartAttempt = 0;
  let availableCallback: (() => void) | null = null;
  let janusBinary: string | null = null;
  let janusMode: JanusMode = "unavailable";
  let externalPollTimer: ReturnType<typeof setTimeout> | null = null;
  let bundledWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped whenever a watchdog (re)starts or stops; a probe still in flight
  // from an older chain sees the mismatch and ends instead of re-arming.
  let watchdogGeneration = 0;
  // Whether the current availability has been reported (start() returning
  // true or the callback). Reset on every bundled spawn and every hosted
  // outage, so each comes back with exactly one report.
  let availableReported = false;
  const wsUrl = `ws://127.0.0.1:${JANUS_WS_PORT}`;

  function findJanusBinary(): string | null {
    const candidates = ["/usr/bin/janus", "/usr/local/bin/janus", "janus"];
    for (const bin of candidates) {
      try {
        if (bin.startsWith("/") && fs.existsSync(bin)) return bin;
      } catch {
        // ignore
      }
    }
    try {
      const { execSync } =
        require("child_process") as typeof import("child_process");
      const result = execSync("which janus 2>/dev/null", {
        encoding: "utf8",
      }).trim();
      if (result) return result;
    } catch {
      // not found
    }
    return null;
  }

  function writeConfig(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-"));

    const projectConfigDir = path.join(
      __dirname,
      "..",
      "..",
      "config",
      "janus"
    );
    const distConfigDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "config",
      "janus"
    );
    const configDir = fs.existsSync(projectConfigDir)
      ? projectConfigDir
      : fs.existsSync(distConfigDir)
        ? distConfigDir
        : null;

    if (configDir) {
      for (const file of fs.readdirSync(configDir)) {
        fs.copyFileSync(path.join(configDir, file), path.join(dir, file));
      }
    } else {
      console.warn(
        `[janus] No Janus config directory found (looked in ${projectConfigDir} and ${distConfigDir}) — starting with an empty config directory`
      );
    }

    const jcfgPath = path.join(dir, "janus.jcfg");
    const hasOverrides =
      !!process.env.JANUS_HOST_IP?.trim() ||
      !!process.env.JANUS_RTP_PORT_RANGE?.trim();
    if (hasOverrides && fs.existsSync(jcfgPath)) {
      const original = fs.readFileSync(jcfgPath, "utf8");
      const { text, warnings } = patchJanusConfig(original, process.env);
      for (const w of warnings) console.warn(`[janus] ${w}`);
      if (text !== original) {
        fs.writeFileSync(jcfgPath, text, "utf8");
        console.log("[janus] janus.jcfg patched from environment");
      }
    }

    return dir;
  }

  function waitForReady(timeoutMs = 10000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;

      function attempt() {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }
        const ws = new WebSocket(wsUrl, "janus-protocol");
        ws.once("open", () => {
          ws.close();
          resolve(true);
        });
        ws.once("error", () => {
          setTimeout(attempt, 500);
        });
      }
      attempt();
    });
  }

  function probeWs(timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, "janus-protocol");
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /** Periodic health check for external Janus — fires every 10s. */
  function startHostedWatchdog(): void {
    const INTERVAL_MS = 10_000;
    const gen = resetWatchdogs();
    function tick() {
      if (stopped || gen !== watchdogGeneration || janusMode !== "hosted")
        return;
      probeWs().then((reachable) => {
        if (stopped || gen !== watchdogGeneration) return;
        if (reachable) {
          // A Janus that came up after start() gave up waiting.
          if (!availableReported) {
            console.log("[janus] Hosted Janus answering late — now available");
            reportReady();
          }
          externalPollTimer = setTimeout(tick, INTERVAL_MS);
          return;
        }
        availableReported = false;
        if (healthMonitor.getHealth().janus !== HealthState.RECOVERING) {
          console.warn("[janus] Hosted Janus unreachable — recovering");
          healthMonitor.setState("janus", HealthState.RECOVERING);
          healthMonitor.pushError(
            "janus",
            "Hosted Janus unreachable",
            ErrorSeverity.ERROR
          );
          healthMonitor.incrementRestarts("janus");
        }
        scheduleRecoveryPoll();
      });
    }

    /** Poll WS until reachable again, then resume the regular ticks. */
    function scheduleRecoveryPoll(): void {
      if (stopped || gen !== watchdogGeneration) return;
      const delay = calculateDelay(restartAttempt, resilienceConfig.retry);
      restartAttempt++;
      externalPollTimer = setTimeout(async () => {
        if (stopped || gen !== watchdogGeneration) return;
        const reachable = await probeWs();
        if (stopped || gen !== watchdogGeneration) return;
        if (reachable) {
          console.log("[janus] Hosted Janus reachable again");
          reportReady();
          externalPollTimer = setTimeout(tick, INTERVAL_MS);
        } else {
          scheduleRecoveryPoll();
        }
      }, delay);
    }

    externalPollTimer = setTimeout(tick, INTERVAL_MS);
  }

  /** Ends any running watchdog chain; returns the generation for a new one. */
  function resetWatchdogs(): number {
    if (externalPollTimer) {
      clearTimeout(externalPollTimer);
      externalPollTimer = null;
    }
    if (bundledWatchdogTimer) {
      clearTimeout(bundledWatchdogTimer);
      bundledWatchdogTimer = null;
    }
    return ++watchdogGeneration;
  }

  function markReady(): void {
    availableReported = true;
    restartAttempt = 0;
    healthMonitor.setState("janus", HealthState.HEALTHY);
  }

  /** Marks Janus available and notifies once per availability. */
  function reportReady(): void {
    if (availableReported) return;
    markReady();
    if (availableCallback) availableCallback();
  }

  /** Spawns the bundled Janus; start() returning true is its report. */
  async function startBundled(): Promise<boolean> {
    janusMode = "bundled";
    spawnEmbedded();
    const ready = await waitForReady(10000);
    if (ready) {
      markReady();
      console.log("[janus] Bundled Janus ready on", wsUrl);
    } else {
      healthMonitor.setState("janus", HealthState.DOWN);
    }
    // Also when not ready: a Janus that hangs from the start never exits.
    startBundledWatchdog();
    return ready;
  }

  /** A hung Janus never exits, so `close` alone can't catch it. */
  function startBundledWatchdog(): void {
    const INTERVAL_MS = 10_000;
    const MAX_MISSED_PROBES = 3;
    const gen = resetWatchdogs();
    let missed = 0;
    async function tick() {
      if (stopped || gen !== watchdogGeneration) return;
      // No process means a restart is pending; the close handler owns it.
      const reachable = proc ? await probeWs() : true;
      if (stopped || gen !== watchdogGeneration) return;
      missed = reachable ? 0 : missed + 1;
      // A Janus that came up after start()/restart gave up waiting.
      if (reachable && proc && !availableReported) {
        console.log("[janus] Bundled Janus answering late — now available");
        reportReady();
      }
      if (missed >= MAX_MISSED_PROBES && proc) {
        console.warn(
          `[janus] No answer on ${wsUrl} for ${MAX_MISSED_PROBES} probes — killing Janus`
        );
        healthMonitor.setState("janus", HealthState.RECOVERING);
        missed = 0;
        terminate(proc);
      }
      bundledWatchdogTimer = setTimeout(tick, INTERVAL_MS);
    }
    bundledWatchdogTimer = setTimeout(tick, INTERVAL_MS);
  }

  function spawnEmbedded(): void {
    if (proc) return;
    availableReported = false;
    const configDir = writeConfig();
    console.log(`[janus] Starting embedded with config dir: ${configDir}`);

    proc = spawn(
      janusBinary!,
      ["--configs-folder", configDir, "--debug-level", String(janusDebugLevel)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    proc.stdout!.on("data", (d: Buffer) =>
      process.stdout.write(`[janus] ${d}`)
    );
    proc.stderr!.on("data", (d: Buffer) =>
      process.stderr.write(`[janus] ${d}`)
    );

    proc.on("close", (code) => {
      proc = null;
      if (stopped) return;
      const msg = `Janus process exited (code ${code})`;
      console.log(`[janus] ${msg} — restarting embedded`);
      healthMonitor.setState("janus", HealthState.RECOVERING);
      healthMonitor.pushError("janus", msg, ErrorSeverity.ERROR);
      healthMonitor.incrementRestarts("janus");
      const delay = calculateDelay(restartAttempt, resilienceConfig.retry);
      restartAttempt++;
      setTimeout(async () => {
        if (stopped) return;
        spawnEmbedded();
        if (await waitForReady()) reportReady();
      }, delay);
    });

    proc.on("error", (err) => {
      console.error("[janus] Failed to spawn:", err.message);
      proc = null;
    });
  }

  return {
    get wsUrl() {
      return wsUrl;
    },

    get mode(): JanusMode {
      return janusMode;
    },

    onAvailable(callback: () => void): void {
      availableCallback = callback;
    },

    async start(): Promise<boolean> {
      stopped = false;
      // A watchdog from an earlier start() must not report the Janus this
      // start() is waiting for; start() arms a new one.
      resetWatchdogs();

      // Explicit mode override via JANUS_MODE env var
      if (janusModeEnv === "bundled") {
        janusBinary = findJanusBinary();
        if (!janusBinary) {
          console.error(
            "[janus] JANUS_MODE=bundled but no binary found — unavailable"
          );
          janusMode = "unavailable";
          return false;
        }
        console.log(`[janus] Bundled mode (explicit) — binary: ${janusBinary}`);
        return startBundled();
      }

      if (janusModeEnv === "hosted") {
        janusMode = "hosted";
        console.log(
          "[janus] Hosted mode (explicit) — waiting for Janus on",
          wsUrl
        );
        const ready = await waitForReady(15000);
        if (ready) {
          markReady();
        } else {
          availableReported = false;
          healthMonitor.setState("janus", HealthState.DOWN);
        }
        // Also when not ready: its recovery poll reports a Janus that comes
        // up later.
        startHostedWatchdog();
        return ready;
      }

      // auto: 1. quick probe → hosted. Skipped once bundled: our own Janus
      // would answer it and be mistaken for a hosted one.
      const quickProbe = janusMode !== "bundled" && (await probeWs(2000));
      if (quickProbe) {
        janusMode = "hosted";
        console.log("[janus] Hosted Janus detected on", wsUrl);
        markReady();
        startHostedWatchdog();
        return true;
      }

      // auto: 2. local binary → bundled
      janusBinary = findJanusBinary();
      if (janusBinary) {
        console.log(`[janus] Bundled mode — binary: ${janusBinary}`);
        return startBundled();
      }

      // auto: 3. no binary — wait longer for slow-starting hosted sidecar
      console.log("[janus] No local binary — waiting for hosted Janus…");
      const hostedReady = await waitForReady(15000);
      if (hostedReady) {
        janusMode = "hosted";
        console.log("[janus] Hosted Janus became ready on", wsUrl);
        markReady();
        startHostedWatchdog();
        return true;
      }

      janusMode = "unavailable";
      console.log("[janus] Unavailable — falling back to MJPEG only");
      return false;
    },

    stop(): void {
      stopped = true;
      resetWatchdogs();
      if (proc) {
        terminate(proc);
        proc = null;
      }
      healthMonitor.setState("janus", HealthState.DOWN);
    },
  };
}
