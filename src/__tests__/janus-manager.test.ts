import { EventEmitter } from "events";

jest.mock("child_process");
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: () => true,
  readdirSync: () => [],
}));
jest.mock("ws");
jest.mock("../lib/env-config", () => ({
  ...jest.requireActual("../lib/env-config"),
  janusModeEnv: "bundled",
}));

import * as cp from "child_process";
import WebSocket from "ws";
import { createJanusManager } from "../janus/manager";

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

  it("tolerates a single missed probe", async () => {
    const { manager, proc } = await startManager();
    janusAnswers = false;
    await tick(10_000);
    janusAnswers = true;
    await tick(30_000);
    expect(proc.kill).not.toHaveBeenCalled();
    manager.stop();
  });
});
