import {
  loadConfig,
  isConfigured,
  getBridgeUrl,
  Config,
} from "./config/config";
import { configEmitter } from "./config/config";
import { createPrusaLinkClient } from "./prusalink/client";
import { createCamera } from "./camera/camera";
import { setCameraInstance } from "./camera/registry";
import { createObicoAgent } from "./obico/agent";
import {
  createFilePrintStartStore,
  printStartStorePath,
} from "./obico/print-start-store";
import { HttpFetcher } from "./obico/types";
import { createJanusManager } from "./janus/manager";
import { createJanusRelay } from "./janus/relay";
import {
  setJanusMode,
  healthMonitor,
  circuitBreakerRegistry,
} from "./lib/health";
import { HealthState } from "./lib/health-monitor";
import type { ComponentName } from "./lib/health-monitor";

const httpFetcher: HttpFetcher = { fetch: (url, opts) => fetch(url, opts) };

let running = false;
let currentConfig: Config | null = null;
let currentPort = 3000;

type BridgeState = {
  prusaClient: ReturnType<typeof createPrusaLinkClient> | null;
  camera: ReturnType<typeof createCamera> | null;
  agent: ReturnType<typeof createObicoAgent> | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  janusManager: ReturnType<typeof createJanusManager> | null;
  janusRelay: ReturnType<typeof createJanusRelay> | null;
  janusStarted: boolean;
};

const state: BridgeState = {
  prusaClient: null,
  camera: null,
  agent: null,
  pollHandle: null,
  janusManager: null,
  janusRelay: null,
  janusStarted: false,
};

let shuttingDown = false;

// Test-only helper — resets shutdown state + allows state injection
export function __setStateForTest(patch: Partial<BridgeState>): void {
  Object.assign(state, patch);
  shuttingDown = false;
}

// Test-only helper — injects a partial shutdown config (ffmpegKillTimeoutSeconds)
export function __setCurrentConfigForTest(
  shutdown: { ffmpegKillTimeoutSeconds: number } | null
): void {
  if (shutdown !== null) {
    currentConfig = {
      name: "test",
      prusalink: { url: "", username: "", password: "" },
      camera: { rtspUrl: "", frameIntervalSeconds: 2 },
      obico: { serverUrl: "", apiKey: "" },
      polling: { statusIntervalMs: 5000 },
      shutdown,
    };
  } else {
    currentConfig = null;
  }
  shuttingDown = false;
}

export async function stopBridge(server: import("http").Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const timeoutSec = currentConfig?.shutdown?.ffmpegKillTimeoutSeconds ?? 3;

  const hardTimeout = setTimeout(() => process.exit(0), 8000);
  hardTimeout.unref();

  try {
    // 1. HTTP server
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      server.closeAllConnections();
    } catch {
      /* older Node */
    }

    // 2. Obico WS — code 1001 going away
    try {
      state.agent?.disconnect(1001);
    } catch (e) {
      console.error("[shutdown] agent:", e);
    }

    // 3. Camera / ffmpeg — SIGINT → SIGKILL
    try {
      await state.camera?.stopGracefully(timeoutSec * 1000);
    } catch (e) {
      console.error("[shutdown] camera:", e);
    }

    // 4. Timers
    if (state.pollHandle) {
      clearInterval(state.pollHandle);
      state.pollHandle = null;
    }

    // 5. Janus — relay first, then manager (dependency order)
    try {
      state.janusRelay?.stop();
    } catch (e) {
      console.error("[shutdown] janusRelay:", e);
    }
    try {
      state.janusManager?.stop();
    } catch (e) {
      console.error("[shutdown] janusManager:", e);
    }
  } finally {
    clearTimeout(hardTimeout);
  }
}

export function diffConfig(prev: Config, next: Config) {
  return {
    prusalink:
      prev.prusalink.url !== next.prusalink.url ||
      prev.prusalink.username !== next.prusalink.username ||
      prev.prusalink.password !== next.prusalink.password,
    obico:
      prev.obico.serverUrl !== next.obico.serverUrl ||
      prev.obico.apiKey !== next.obico.apiKey,
    camera:
      prev.camera.rtspUrl !== next.camera.rtspUrl ||
      prev.camera.frameIntervalSeconds !== next.camera.frameIntervalSeconds,
    polling:
      (prev.polling?.statusIntervalMs ?? 5000) !==
      (next.polling?.statusIntervalMs ?? 5000),
  };
}

export function registerFrameForwarding(
  camera: ReturnType<typeof createCamera>,
  agent: ReturnType<typeof createObicoAgent>,
  uploadIntervalMs: number
): void {
  let lastUpload = 0;
  let uploadFailing = false;
  camera.onFrame(async (frame) => {
    const now = Date.now();
    if (now - lastUpload < uploadIntervalMs) return;
    lastUpload = now;
    try {
      await agent.sendFrame(frame);
      if (uploadFailing) console.log("[bridge] Frame uploads recovered");
      uploadFailing = false;
    } catch (err) {
      // non-fatal, but without frames Obico detects nothing, so say so once
      if (!uploadFailing) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[bridge] Frame upload failing: ${reason}`);
      }
      uploadFailing = true;
    }
  });
}

async function applyConfigChange(newConfig: Config): Promise<void> {
  if (!currentConfig) return;

  let validated: Config;
  try {
    validated = loadConfig();
  } catch (err) {
    console.warn("[bridge] Config reload skipped — invalid JSON on disk:", err);
    return;
  }

  const diff = diffConfig(currentConfig, validated);
  if (!diff.prusalink && !diff.obico && !diff.camera && !diff.polling) return;

  console.log("[bridge] Applying config change:", diff);

  if (diff.prusalink) {
    state.prusaClient = createPrusaLinkClient({
      baseUrl: validated.prusalink.url,
      username: validated.prusalink.username,
      password: validated.prusalink.password,
    });
  }

  if (diff.camera && state.camera && state.agent) {
    state.camera.stop();
    state.camera = createCamera({
      rtspUrl: validated.camera.rtspUrl,
      frameIntervalSeconds: validated.camera.frameIntervalSeconds,
    });
    setCameraInstance(state.camera);
    state.camera.start();
    registerFrameForwarding(
      state.camera,
      state.agent,
      validated.camera.frameIntervalSeconds * 1000
    );
  }

  if ((diff.obico || diff.prusalink) && state.agent && state.camera) {
    state.agent.disconnect();
    state.janusStarted = false;
    if (state.janusRelay) {
      state.janusRelay.stop();
      state.janusRelay = null;
    }
    state.agent = createObicoAgent(
      {
        serverUrl: validated.obico.serverUrl,
        apiKey: validated.obico.apiKey,
        streamUrl: `${getBridgeUrl(validated, currentPort)}/stream`,
        localPort: currentPort,
      },
      httpFetcher,
      state.prusaClient!,
      createFilePrintStartStore(printStartStorePath())
    );
    registerFrameForwarding(
      state.camera,
      state.agent,
      validated.camera.frameIntervalSeconds * 1000
    );
    state.agent.connect(onOpenCallback);
  }

  if (diff.polling) {
    if (state.pollHandle) clearInterval(state.pollHandle);
    state.pollHandle = setInterval(
      pollAndSend,
      validated.polling?.statusIntervalMs ?? 5000
    );
  }

  currentConfig = validated;
}

export type ReconnectTarget = "prusalink" | "obico" | "camera";

export async function reconnectComponent(
  component: ReconnectTarget
): Promise<void> {
  console.log("[bridge] Reconnecting component:", component);

  if (!currentConfig) {
    throw new Error("Bridge not running");
  }
  if (!state.camera || !state.agent || !state.prusaClient) {
    throw new Error("Bridge state not initialised");
  }

  const CB_NAME_MAP: Record<ReconnectTarget, ComponentName> = {
    prusalink: "prusalink",
    obico: "obico_ws",
    camera: "camera",
  };
  const cbName = CB_NAME_MAP[component];
  const cb = circuitBreakerRegistry.get(cbName);
  if (cb) cb.reset();

  healthMonitor.setState(cbName, HealthState.RECOVERING);
  healthMonitor.incrementRestarts(cbName);

  if (component === "prusalink") {
    state.prusaClient = createPrusaLinkClient({
      baseUrl: currentConfig.prusalink.url,
      username: currentConfig.prusalink.username,
      password: currentConfig.prusalink.password,
    });
    // Also reconnect the agent so it observes the new prusaClient
    state.agent.disconnect();
    state.janusStarted = false;
    if (state.janusRelay) {
      state.janusRelay.stop();
      state.janusRelay = null;
    }
    state.agent = createObicoAgent(
      {
        serverUrl: currentConfig.obico.serverUrl,
        apiKey: currentConfig.obico.apiKey,
        streamUrl: `${getBridgeUrl(currentConfig, currentPort)}/stream`,
        localPort: currentPort,
      },
      httpFetcher,
      state.prusaClient,
      createFilePrintStartStore(printStartStorePath())
    );
    registerFrameForwarding(
      state.camera,
      state.agent,
      currentConfig.camera.frameIntervalSeconds * 1000
    );
    state.agent.connect(onOpenCallback);
  } else if (component === "obico") {
    state.agent.disconnect();
    state.janusStarted = false;
    if (state.janusRelay) {
      state.janusRelay.stop();
      state.janusRelay = null;
    }
    state.agent = createObicoAgent(
      {
        serverUrl: currentConfig.obico.serverUrl,
        apiKey: currentConfig.obico.apiKey,
        streamUrl: `${getBridgeUrl(currentConfig, currentPort)}/stream`,
        localPort: currentPort,
      },
      httpFetcher,
      state.prusaClient,
      createFilePrintStartStore(printStartStorePath())
    );
    registerFrameForwarding(
      state.camera,
      state.agent,
      currentConfig.camera.frameIntervalSeconds * 1000
    );
    state.agent.connect(onOpenCallback);
  } else if (component === "camera") {
    state.camera.stop();
    state.camera = createCamera({
      rtspUrl: currentConfig.camera.rtspUrl,
      frameIntervalSeconds: currentConfig.camera.frameIntervalSeconds,
    });
    setCameraInstance(state.camera);
    state.camera.start();
    registerFrameForwarding(
      state.camera,
      state.agent,
      currentConfig.camera.frameIntervalSeconds * 1000
    );
  }
}

async function pollAndSend(): Promise<void> {
  if (!state.prusaClient || !state.agent) return;
  try {
    const [status, job] = await Promise.all([
      state.prusaClient.getStatus(),
      state.prusaClient.getJob(),
    ]);
    state.agent.sendStatus(status, job);
  } catch {
    // non-fatal
  }
}

async function onOpenCallback(): Promise<void> {
  if (!state.agent) return;
  await state.agent.updateAgentInfo();
  if (!state.janusStarted) {
    state.janusStarted = true;
    await startJanus();
  } else {
    if (state.janusRelay) await startJanusRelay();
  }
  pollAndSend();
}

async function startJanusRelay(): Promise<void> {
  if (!state.agent || !state.janusManager) return;
  const printerId = await state.agent.fetchPrinterId();
  if (!printerId) {
    console.warn(
      "[bridge] Could not fetch printer ID — Janus relay not started"
    );
    return;
  }
  if (state.janusRelay) {
    state.janusRelay.stop();
    state.janusRelay = null;
  }
  const config = currentConfig!;
  state.janusRelay = createJanusRelay(
    state.janusManager.wsUrl,
    config.obico.serverUrl,
    printerId,
    config.obico.apiKey
  );
  state.janusRelay.start();
  console.log(`[bridge] Janus relay active for printer ${printerId}`);
}

async function startJanus(): Promise<void> {
  if (!state.janusManager || !state.agent || !state.camera) return;
  const RTP_PORT = 17732;
  const available = await state.janusManager.start();
  setJanusMode(state.janusManager.mode);
  if (!available) return;

  state.agent.setJanusUrl(state.janusManager.wsUrl);
  state.camera.startRtpStream(RTP_PORT);

  state.janusManager.onCrash(async () => {
    console.log("[bridge] Janus restarted — rebuilding RTP stream and relay");
    state.camera!.stopRtpStream();
    state.camera!.startRtpStream(RTP_PORT);
    await startJanusRelay();
  });

  await startJanusRelay();
}

export async function startBridge(port = 3000): Promise<void> {
  if (!isConfigured()) {
    console.log("[bridge] Not configured — skipping start");
    return;
  }

  if (running) return;
  running = true;
  currentPort = port;

  const config = loadConfig();
  currentConfig = config;
  const bridgeUrl = getBridgeUrl(config, port);
  console.log(
    `[bridge] Starting — PrusaLink: ${config.prusalink.url}, Obico: ${config.obico.serverUrl}, Bridge: ${bridgeUrl}`
  );

  state.prusaClient = createPrusaLinkClient({
    baseUrl: config.prusalink.url,
    username: config.prusalink.username,
    password: config.prusalink.password,
  });

  state.camera = createCamera({
    rtspUrl: config.camera.rtspUrl,
    frameIntervalSeconds: config.camera.frameIntervalSeconds,
  });

  setCameraInstance(state.camera);

  state.agent = createObicoAgent(
    {
      serverUrl: config.obico.serverUrl,
      apiKey: config.obico.apiKey,
      streamUrl: `${bridgeUrl}/stream`,
      localPort: port,
    },
    httpFetcher,
    state.prusaClient,
    createFilePrintStartStore(printStartStorePath())
  );

  registerFrameForwarding(
    state.camera,
    state.agent,
    config.camera.frameIntervalSeconds * 1000
  );

  state.camera.start();
  state.janusManager = createJanusManager();

  state.agent.connect(onOpenCallback);

  const intervalMs = config.polling?.statusIntervalMs ?? 5000;
  state.pollHandle = setInterval(pollAndSend, intervalMs);

  configEmitter.removeAllListeners("config-changed");
  configEmitter.on("config-changed", (newCfg: Config) => {
    applyConfigChange(newCfg).catch((err) =>
      console.error("[bridge] applyConfigChange failed:", err)
    );
  });

  console.log("[bridge] Running");
}
