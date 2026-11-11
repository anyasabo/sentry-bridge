import * as http from "http";

jest.mock("../camera/camera");
jest.mock("../camera/registry");
jest.mock("../obico/agent");
jest.mock("../janus/manager");
jest.mock("../janus/relay");
jest.mock("../prusalink/client");
jest.mock("../obico/print-start-store");
jest.mock("../config/config", () => ({
  loadConfig: jest.fn(() => ({
    name: "test",
    prusalink: { url: "http://printer", username: "u", password: "p" },
    camera: { rtspUrl: "rtsp://printer/live", frameIntervalSeconds: 2 },
    obico: { serverUrl: "http://obico", apiKey: "key" },
    polling: { statusIntervalMs: 5000 },
  })),
  isConfigured: jest.fn().mockReturnValue(true),
  getBridgeUrl: jest.fn().mockReturnValue("http://bridge:3000"),
  configEmitter: { removeAllListeners: jest.fn(), on: jest.fn() },
}));

const flush = () => new Promise((r) => setImmediate(r));

const server = {
  close: jest.fn((cb?: () => void) => cb?.()),
  closeAllConnections: jest.fn(),
} as unknown as http.Server;

/**
 * Starts a fresh bridge (its module state allows one start per load) whose
 * Janus manager reports `janusStart` as the result of its first start().
 */
async function startBridgeWith(janusStart: Promise<boolean>) {
  jest.resetModules();
  const bridge = await import("../bridge");
  const { createCamera } = await import("../camera/camera");
  const { createObicoAgent } = await import("../obico/agent");
  const { createJanusManager } = await import("../janus/manager");
  const { createJanusRelay } = await import("../janus/relay");
  const { createPrusaLinkClient } = await import("../prusalink/client");

  const camera = {
    start: jest.fn(),
    onFrame: jest.fn(),
    startRtpStream: jest.fn(),
    stopRtpStream: jest.fn(),
    stopGracefully: jest.fn().mockResolvedValue(undefined),
  };
  const agent = {
    connect: jest.fn((onOpen: () => Promise<void>) => void onOpen()),
    disconnect: jest.fn(),
    updateAgentInfo: jest.fn().mockResolvedValue(undefined),
    setJanusUrl: jest.fn(),
    fetchPrinterId: jest.fn().mockResolvedValue(42),
    sendStatus: jest.fn(),
  };
  let available: () => void = () => {
    throw new Error("no availability handler registered");
  };
  const janusManager = {
    start: jest.fn().mockReturnValueOnce(janusStart).mockResolvedValue(false),
    stop: jest.fn(),
    wsUrl: "ws://127.0.0.1:8188",
    mode: "bundled",
    onAvailable: jest.fn((cb: () => void) => {
      available = cb;
    }),
  };
  const relay = { start: jest.fn(), stop: jest.fn() };

  (createCamera as jest.Mock).mockReturnValue(camera);
  (createObicoAgent as jest.Mock).mockReturnValue(agent);
  (createJanusManager as jest.Mock).mockReturnValue(janusManager);
  (createJanusRelay as jest.Mock).mockReturnValue(relay);
  (createPrusaLinkClient as jest.Mock).mockReturnValue({
    getStatus: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue({}),
  });

  await bridge.startBridge(3000);
  await flush();
  return {
    bridge,
    camera,
    agent,
    janusManager,
    createJanusRelay: createJanusRelay as jest.Mock,
    relay,
    janusAvailable: () => available(),
  };
}

describe("bridge — Janus that becomes available after a failed first start", () => {
  let stop: () => Promise<void> = async () => {};

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await stop();
    stop = async () => {};
    jest.restoreAllMocks();
  });

  async function startUnavailable() {
    const ctx = await startBridgeWith(Promise.resolve(false));
    stop = () => ctx.bridge.stopBridge(server);
    return ctx;
  }

  it("starts no video path while Janus is unavailable", async () => {
    const { janusManager, camera, createJanusRelay } = await startUnavailable();
    expect(janusManager.start).toHaveBeenCalledTimes(1);
    expect(camera.startRtpStream).not.toHaveBeenCalled();
    expect(createJanusRelay).not.toHaveBeenCalled();
  });

  it("starts RTP stream and Janus relay once Janus comes up", async () => {
    const { bridge, agent, camera, createJanusRelay, relay, janusAvailable } =
      await startUnavailable();
    janusAvailable();
    await flush();

    expect(agent.setJanusUrl).toHaveBeenCalledWith("ws://127.0.0.1:8188");
    expect(camera.startRtpStream).toHaveBeenCalledWith(bridge.JANUS_RTP_PORT);
    expect(createJanusRelay).toHaveBeenCalledWith(
      "ws://127.0.0.1:8188",
      "http://obico",
      42,
      "key"
    );
    expect(relay.start).toHaveBeenCalled();
  });

  it("does not register another availability handler when Janus is started again on reconnect", async () => {
    const { bridge, janusManager } = await startUnavailable();
    await bridge.reconnectComponent("obico");
    await flush();

    expect(janusManager.start).toHaveBeenCalledTimes(2);
    expect(janusManager.onAvailable).toHaveBeenCalledTimes(1);
  });

  it("stops the RTP stream on shutdown", async () => {
    const { bridge, camera } = await startUnavailable();
    await bridge.stopBridge(server);
    expect(camera.stopRtpStream).toHaveBeenCalled();
  });
});

describe("bridge — Janus that becomes available during shutdown", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts no RTP stream once shutdown has begun", async () => {
    let resolveStart: (ready: boolean) => void = () => {};
    const { bridge, camera, createJanusRelay } = await startBridgeWith(
      new Promise((r) => (resolveStart = r))
    );

    await bridge.stopBridge(server);
    resolveStart(true);
    await flush();

    expect(camera.startRtpStream).not.toHaveBeenCalled();
    expect(createJanusRelay).not.toHaveBeenCalled();
  });

  it("starts no Janus relay once shutdown has begun", async () => {
    const { bridge, agent, createJanusRelay, janusAvailable } =
      await startBridgeWith(Promise.resolve(false));
    let resolvePrinterId: (id: number) => void = () => {};
    agent.fetchPrinterId.mockReturnValue(
      new Promise((r) => (resolvePrinterId = r))
    );

    janusAvailable();
    await flush();
    await bridge.stopBridge(server);
    resolvePrinterId(42);
    await flush();

    expect(createJanusRelay).not.toHaveBeenCalled();
  });
});
