import { EventEmitter } from "events";

jest.mock("child_process");
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: (p: string) =>
    mockJanusConfigDirExists || !/config[\\/]janus$/.test(p),
  mkdtempSync: () => "/tmp/janus-test",
  readdirSync: () => [],
}));
jest.mock("ws");
let mockJanusMode = "bundled";
let mockJanusConfigDirExists = true;
jest.mock("../lib/env-config", () => ({
  ...jest.requireActual("../lib/env-config"),
  get janusModeEnv() {
    return mockJanusMode;
  },
}));

import * as cp from "child_process";
import WebSocket from "ws";
import { createJanusManager } from "../janus/manager";
import { healthMonitor } from "../lib/health";
import { HealthState } from "../lib/health-monitor";

const mockSpawn = cp.spawn as jest.MockedFunction<typeof cp.spawn>;
const MockWebSocket = WebSocket as unknown as jest.Mock;

function makeProcess(): cp.ChildProcess {
  const proc = new EventEmitter() as cp.ChildProcess;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc.stdout = new EventEmitter() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc.stderr = new EventEmitter() as any;
  proc.kill = jest.fn();
  return proc;
}

// Every socket reports `open` or `error` on the next tick.
let janusAnswers = true;
function fakeSocket() {
  const ws = new EventEmitter() as EventEmitter & {
    close: jest.Mock;
    terminate: jest.Mock;
  };
  ws.close = jest.fn();
  ws.terminate = jest.fn();
  setImmediate(() => {
    if (janusAnswers) ws.emit("open");
    else ws.emit("error", new Error("refused"));
  });
  return ws;
}

async function tick(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe("Janus manager, bundled mode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    janusAnswers = true;
    mockJanusMode = "bundled";
    mockJanusConfigDirExists = true;
    MockWebSocket.mockImplementation(fakeSocket);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function startManager() {
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    const manager = createJanusManager();
    const started = manager.start();
    await tick(0);
    expect(await started).toBe(true);
    return { manager, proc };
  }

  it("warns when no Janus config directory is found", async () => {
    mockJanusConfigDirExists = false;
    const { manager } = await startManager();
    const warned = (console.warn as jest.Mock).mock.calls.flat().join("\n");
    expect(warned).toMatch(/no janus config directory/i);
    manager.stop();
  });

  it("leaves a responsive Janus alone", async () => {
    const { manager, proc } = await startManager();
    await tick(60_000);
    expect(proc.kill).not.toHaveBeenCalled();
    manager.stop();
  });

  it("kills a Janus that is running but no longer answers", async () => {
    const { manager, proc } = await startManager();
    janusAnswers = false;
    await tick(30_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("stops probing after stop()", async () => {
    const { manager } = await startManager();
    manager.stop();
    MockWebSocket.mockClear();
    await tick(60_000);
    expect(MockWebSocket).not.toHaveBeenCalled();
  });

  it("tolerates a single missed probe", async () => {
    const { manager, proc } = await startManager();
    janusAnswers = false;
    await tick(10_000);
    janusAnswers = true;
    await tick(30_000);
    expect(proc.kill).not.toHaveBeenCalled();
    manager.stop();
  });

  it("probes once per interval after start() is called again", async () => {
    const { manager } = await startManager();
    const restarted = manager.start();
    await tick(0);
    expect(await restarted).toBe(true);
    MockWebSocket.mockClear();
    await tick(10_000);
    expect(MockWebSocket).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("keeps its own Janus in bundled mode when auto start() runs again", async () => {
    mockJanusMode = "auto";
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    // The quick probe for a hosted Janus fails, so the binary gets spawned.
    janusAnswers = false;
    const manager = createJanusManager();
    const started = manager.start();
    await tick(0);
    await tick(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    janusAnswers = true;
    await tick(1_000);
    expect(await started).toBe(true);
    expect(manager.mode).toBe("bundled");

    // Now our own Janus answers the quick probe; it must not look hosted.
    const restarted = manager.start();
    await tick(0);
    expect(await restarted).toBe(true);
    expect(manager.mode).toBe("bundled");

    // The bundled watchdog, not the hosted one, still guards the process.
    janusAnswers = false;
    await tick(30_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("kills a Janus that never answered after start", async () => {
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    janusAnswers = false;
    const manager = createJanusManager();
    const started = manager.start();
    await tick(11_000);
    expect(await started).toBe(false);
    await tick(30_000);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("does not report a Janus that start() already returned as ready", async () => {
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    const manager = createJanusManager();
    const available = jest.fn();
    manager.onAvailable(available);
    const started = manager.start();
    await tick(0);
    expect(await started).toBe(true);
    await tick(60_000);
    expect(available).not.toHaveBeenCalled();
    manager.stop();
  });

  it("reports a restarted Janus once, even when the watchdog sees it first", async () => {
    const first = makeProcess();
    const second = makeProcess();
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = createJanusManager();
    const available = jest.fn();
    manager.onAvailable(available);
    const started = manager.start();
    await tick(0);
    expect(await started).toBe(true);

    first.emit("close", 1);
    await tick(60_000);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(available).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("reports a Janus that answers only after start() gave up, once", async () => {
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    janusAnswers = false;
    const manager = createJanusManager();
    const available = jest.fn();
    manager.onAvailable(available);
    const started = manager.start();
    await tick(11_000);
    expect(await started).toBe(false);
    expect(available).not.toHaveBeenCalled();

    janusAnswers = true;
    await tick(10_000);
    expect(available).toHaveBeenCalledTimes(1);
    expect(healthMonitor.getHealth().janus).toBe(HealthState.HEALTHY);

    await tick(60_000);
    expect(available).toHaveBeenCalledTimes(1);
    expect(proc.kill).not.toHaveBeenCalled();
    manager.stop();
  });

  it("reports a Janus that answers during a second start() only through start()", async () => {
    const proc = makeProcess();
    mockSpawn.mockReturnValue(proc);
    janusAnswers = false;
    const manager = createJanusManager();
    const available = jest.fn();
    manager.onAvailable(available);
    const first = manager.start();
    await tick(11_250);
    expect(await first).toBe(false);

    // Janus comes up while the second start() is still waiting for it and
    // just before that start() would probe again.
    const second = manager.start();
    await tick(9_050);
    janusAnswers = true;
    await tick(1_000);
    expect(await second).toBe(true);
    expect(available).not.toHaveBeenCalled();

    await tick(60_000);
    expect(available).not.toHaveBeenCalled();
    manager.stop();
  });
});

describe("Janus manager, hosted mode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    janusAnswers = true;
    mockJanusMode = "hosted";
    MockWebSocket.mockImplementation(fakeSocket);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("probes once per interval after start() is called again", async () => {
    const manager = createJanusManager();
    const first = manager.start();
    await tick(0);
    expect(await first).toBe(true);
    const second = manager.start();
    await tick(0);
    expect(await second).toBe(true);
    MockWebSocket.mockClear();
    await tick(10_000);
    expect(MockWebSocket).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it("detects and recovers from every outage, not just the first", async () => {
    const manager = createJanusManager();
    const recovered = jest.fn();
    manager.onAvailable(recovered);
    const started = manager.start();
    await tick(0);
    expect(await started).toBe(true);

    for (let outage = 1; outage <= 3; outage++) {
      janusAnswers = false;
      await tick(10_000);
      janusAnswers = true;
      await tick(5_000);
      expect(recovered).toHaveBeenCalledTimes(outage);
    }
    manager.stop();
  });

  it("keeps watching when Janus drops while already marked recovering", async () => {
    const manager = createJanusManager();
    const recovered = jest.fn();
    manager.onAvailable(recovered);
    const started = manager.start();
    await tick(0);
    expect(await started).toBe(true);

    healthMonitor.setState("janus", HealthState.RECOVERING);
    janusAnswers = false;
    await tick(10_000);
    janusAnswers = true;
    await tick(5_000);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(healthMonitor.getHealth().janus).toBe(HealthState.HEALTHY);
    manager.stop();
  });

  it("reports a hosted Janus that comes up only after start() gave up", async () => {
    janusAnswers = false;
    const manager = createJanusManager();
    const available = jest.fn();
    manager.onAvailable(available);
    const started = manager.start();
    await tick(16_000);
    expect(await started).toBe(false);
    expect(available).not.toHaveBeenCalled();

    janusAnswers = true;
    await tick(30_000);
    expect(available).toHaveBeenCalledTimes(1);
    expect(healthMonitor.getHealth().janus).toBe(HealthState.HEALTHY);
    manager.stop();
  });
});
