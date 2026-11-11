import { Router, Request, Response } from "express";
import { loadConfig, Config } from "../config/config";
import { toPublicConfig, SecretFallbackError } from "../config/secrets";
import { resolveSetup, saveSetup, SetupError } from "./setup";
import { createPrusaLinkClient } from "../prusalink/client";
import { createCamera } from "../camera/camera";
import { getCameraInstance } from "../camera/registry";
import { startBridge } from "../bridge";
import { healthMonitor, janusMode } from "../lib/health";
import { HealthState } from "../lib/health-monitor";

const router = Router();

// ── Config read: GET /api/config ──────────────────────────────────────────

router.get("/config", (_req: Request, res: Response) => {
  try {
    res.json(toPublicConfig(loadConfig()));
  } catch {
    res.status(404).json({ message: "Not configured" });
  }
});

// ── SSE: /api/status/stream ────────────────────────────────────────────────

router.get("/status/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async function poll() {
    try {
      const config = loadConfig();
      const client = createPrusaLinkClient({
        baseUrl: config.prusalink.url,
        username: config.prusalink.username,
        password: config.prusalink.password,
      });

      const [connectionResult, status, job] = await Promise.allSettled([
        client.testConnection(),
        client.getStatus(),
        client.getJob(),
      ]);

      const health = healthMonitor.getHealth();
      send("status", {
        prusalink: {
          connected:
            connectionResult.status === "fulfilled" &&
            connectionResult.value.ok,
          error:
            connectionResult.status === "fulfilled"
              ? connectionResult.value.error
              : "Request failed",
        },
        obico: {
          connected: health.obico_ws === HealthState.HEALTHY,
        },
        camera: {
          connected: health.camera === HealthState.HEALTHY,
        },
        janus: {
          connected: health.janus_relay === HealthState.HEALTHY,
          available:
            health.janus !== HealthState.DOWN ||
            health.rtp_stream !== HealthState.DOWN,
          mode: janusMode,
        },
        printer:
          status.status === "fulfilled"
            ? {
                state: status.value.state,
                tempNozzle: status.value.tempNozzle,
                targetNozzle: status.value.targetNozzle,
                tempBed: status.value.tempBed,
                targetBed: status.value.targetBed,
              }
            : null,
        job:
          job.status === "fulfilled" && job.value
            ? {
                fileName: job.value.fileName,
                displayName: job.value.displayName,
                progress: job.value.progress,
                timePrinting: job.value.timePrinting,
                timeRemaining: job.value.timeRemaining,
              }
            : null,
      });
    } catch {
      send("status", {
        prusalink: { connected: false, error: "Config not available" },
        obico: { connected: false },
        printer: null,
        job: null,
      });
    }
  }

  poll();
  const interval = setInterval(poll, 5000);
  req.on("close", () => clearInterval(interval));
});

// ── Printer info: GET /api/printer/info ───────────────────────────────────

router.get("/printer/info", async (_req: Request, res: Response) => {
  try {
    const config = loadConfig();
    if (config.name) {
      res.json({ name: config.name });
      return;
    }
    const client = createPrusaLinkClient({
      baseUrl: config.prusalink.url,
      username: config.prusalink.username,
      password: config.prusalink.password,
    });
    const info = await client.getInfo();
    res.json({ name: info.hostname });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch printer info";
    res.status(502).json({ message });
  }
});

// ── Camera snapshot: /api/camera/snapshot ─────────────────────────────────

// The running stream delivers several frames a second; older than this means
// it is stalled or reconnecting.
const SNAPSHOT_MAX_AGE_MS = 15_000;

router.get("/camera/snapshot", async (_req: Request, res: Response) => {
  try {
    const live = getCameraInstance()?.latestFrame(SNAPSHOT_MAX_AGE_MS);
    if (live) {
      res.setHeader("Content-Type", "image/jpeg");
      res.send(live);
      return;
    }
    const config = loadConfig();
    const camera = createCamera({
      rtspUrl: config.camera.rtspUrl,
      frameIntervalSeconds: config.camera.frameIntervalSeconds,
    });
    const frame = await camera.testStream();
    res.setHeader("Content-Type", "image/jpeg");
    res.send(frame);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Snapshot failed";
    res.status(502).json({ message });
  }
});

// ── Printer control: POST /api/control ────────────────────────────────────

router.post("/control", async (req: Request, res: Response) => {
  const { action } = req.body as { action?: string };

  if (!action || !["pause", "resume", "cancel"].includes(action)) {
    res.status(400).json({ message: "action must be pause, resume or cancel" });
    return;
  }

  try {
    const config = loadConfig();
    const client = createPrusaLinkClient({
      baseUrl: config.prusalink.url,
      username: config.prusalink.username,
      password: config.prusalink.password,
    });

    if (action === "pause") await client.pause();
    else if (action === "resume") await client.resume();
    else await client.cancel();

    res.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Control action failed";
    res.status(502).json({ message });
  }
});

// ── Config save: POST /api/setup/save ─────────────────────────────────────

router.post("/setup/save", (req: Request, res: Response) => {
  let config: Config;
  try {
    config = resolveSetup(req.body as Partial<Config>);
  } catch (err) {
    if (err instanceof SetupError || err instanceof SecretFallbackError) {
      res.status(400).json({ message: err.message });
      return;
    }
    throw err;
  }

  try {
    saveSetup(config);
    res.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to save config";
    res.status(500).json({ message });
  }
});

export { router as dashboardRouter };
