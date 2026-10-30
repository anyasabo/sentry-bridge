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

const JANUS_WS_PORT = 8188;

export type JanusMode = "hosted" | "bundled" | "unavailable";

export interface JanusManager {
  /** Start Janus. Resolves true when ready, false if unavailable. */
  start(): Promise<boolean>;
  stop(): void;
  readonly wsUrl: string;
  /** Mode is set once at startup and never changes. */
  readonly mode: JanusMode;
  /** Called by bridge when Janus becomes ready after a crash. */
  onCrash(callback: () => void): void;
}

export function createJanusManager(): JanusManager {
  let proc: ChildProcess | null = null;
  let stopped = false;
  let restartAttempt = 0;
  let crashCallback: (() => void) | null = null;
  let janusBinary: string | null = null;
  let janusMode: JanusMode = "unavailable";
  let externalPollTimer: ReturnType<typeof setTimeout> | null = null;
  let bundledWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
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
    }

    // Patch nat_1_1_mapping with the host LAN IP so Janus advertises a reachable
    // ICE candidate. Without this, Janus defaults to 127.0.0.1 which is unreachable
    // from the Obico server / browser outside the container.
    const hostIp = process.env.JANUS_HOST_IP?.trim();
    if (hostIp) {
      const jcfgPath = path.join(dir, "janus.jcfg");
      if (fs.existsSync(jcfgPath)) {
        const original = fs.readFileSync(jcfgPath, "utf8");
        const patched = original.replace(
          /nat_1_1_mapping\s*=\s*"[^"]*"/,
          `nat_1_1_mapping = "${hostIp}"`
        );
        fs.writeFileSync(jcfgPath, patched, "utf8");
        console.log(`[janus] nat_1_1_mapping set to ${hostIp}`);
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
    function tick() {
      if (stopped || janusMode !== "hosted") return;
      probeWs().then((reachable) => {
        if (stopped) return;
        if (
          !reachable &&
          healthMonitor.getHealth().janus !== HealthState.RECOVERING
        ) {
          console.warn("[janus] Hosted Janus unreachable — recovering");
          healthMonitor.setState("janus", HealthState.RECOVERING);
          healthMonitor.pushError(
            "janus",
            "Hosted Janus unreachable",
            ErrorSeverity.ERROR
          );
          healthMonitor.incrementRestarts("janus");
          scheduleExternalRecoveryPoll();
        } else if (reachable) {
          externalPollTimer = setTimeout(tick, INTERVAL_MS);
        }
      });
    }
    externalPollTimer = setTimeout(tick, INTERVAL_MS);
  }

  /** Poll WS until reachable again — only used in external mode. */
  function scheduleExternalRecoveryPoll(): void {
    if (stopped) return;
    const delay = calculateDelay(restartAttempt, resilienceConfig.retry);
    restartAttempt++;
    externalPollTimer = setTimeout(async () => {
      if (stopped) return;
      const reachable = await probeWs();
      if (reachable) {
        console.log("[janus] Hosted Janus reachable again");
        restartAttempt = 0;
        healthMonitor.setState("janus", HealthState.HEALTHY);
        if (crashCallback) crashCallback();
      } else {
        scheduleExternalRecoveryPoll();
      }
    }, delay);
  }

  /** A hung Janus never exits, so `close` alone can't catch it. */
  function startBundledWatchdog(): void {
    const INTERVAL_MS = 10_000;
    const MAX_MISSED_PROBES = 3;
    let missed = 0;
    async function tick() {
      if (stopped) return;
      // No process means a restart is pending; the close handler owns it.
      const reachable = proc ? await probeWs() : true;
      if (stopped) return;
      missed = reachable ? 0 : missed + 1;
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
        const ready = await waitForReady();
        if (ready) {
          restartAttempt = 0;
          healthMonitor.setState("janus", HealthState.HEALTHY);
          if (crashCallback) crashCallback();
        }
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

    onCrash(callback: () => void): void {
      crashCallback = callback;
    },

    async start(): Promise<boolean> {
      stopped = false;

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
        janusMode = "bundled";
        console.log(`[janus] Bundled mode (explicit) — binary: ${janusBinary}`);
        spawnEmbedded();
        const ready = await waitForReady(10000);
        if (ready) {
          restartAttempt = 0;
          healthMonitor.setState("janus", HealthState.HEALTHY);
          console.log("[janus] Bundled Janus ready on", wsUrl);
          startBundledWatchdog();
        } else {
          healthMonitor.setState("janus", HealthState.DOWN);
        }
        return ready;
      }

      if (janusModeEnv === "hosted") {
        janusMode = "hosted";
        console.log(
          "[janus] Hosted mode (explicit) — waiting for Janus on",
          wsUrl
        );
        const ready = await waitForReady(15000);
        if (ready) {
          healthMonitor.setState("janus", HealthState.HEALTHY);
          startHostedWatchdog();
        } else {
          healthMonitor.setState("janus", HealthState.DOWN);
        }
        return ready;
      }

      // auto: 1. quick probe → hosted
      const quickProbe = await probeWs(2000);
      if (quickProbe) {
        janusMode = "hosted";
        console.log("[janus] Hosted Janus detected on", wsUrl);
        healthMonitor.setState("janus", HealthState.HEALTHY);
        startHostedWatchdog();
        return true;
      }

      // auto: 2. local binary → bundled
      janusBinary = findJanusBinary();
      if (janusBinary) {
        janusMode = "bundled";
        console.log(`[janus] Bundled mode — binary: ${janusBinary}`);
        spawnEmbedded();
        const ready = await waitForReady(10000);
        if (ready) {
          restartAttempt = 0;
          healthMonitor.setState("janus", HealthState.HEALTHY);
          console.log("[janus] Bundled Janus ready on", wsUrl);
          startBundledWatchdog();
        } else {
          healthMonitor.setState("janus", HealthState.DOWN);
        }
        return ready;
      }

      // auto: 3. no binary — wait longer for slow-starting hosted sidecar
      console.log("[janus] No local binary — waiting for hosted Janus…");
      const hostedReady = await waitForReady(15000);
      if (hostedReady) {
        janusMode = "hosted";
        console.log("[janus] Hosted Janus became ready on", wsUrl);
        healthMonitor.setState("janus", HealthState.HEALTHY);
        startHostedWatchdog();
        return true;
      }

      janusMode = "unavailable";
      console.log("[janus] Unavailable — falling back to MJPEG only");
      return false;
    },

    stop(): void {
      stopped = true;
      if (externalPollTimer) {
        clearTimeout(externalPollTimer);
        externalPollTimer = null;
      }
      if (bundledWatchdogTimer) {
        clearTimeout(bundledWatchdogTimer);
        bundledWatchdogTimer = null;
      }
      if (proc) {
        terminate(proc);
        proc = null;
      }
      healthMonitor.setState("janus", HealthState.DOWN);
    },
  };
}
