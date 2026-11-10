import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import { terminate } from "../lib/terminate";

function makeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = jest.fn();
  return child;
}

describe("terminate()", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("sends SIGTERM, then SIGKILL when the process does not exit", () => {
    const child = makeChild();
    terminate(child);
    expect(child.kill).toHaveBeenLastCalledWith();
    jest.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("leaves a process alone that has already exited", () => {
    const child = makeChild();
    Object.assign(child, { exitCode: 0, signalCode: null });
    terminate(child);
    jest.advanceTimersByTime(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("leaves a process alone that was already killed by a signal", () => {
    const child = makeChild();
    Object.assign(child, { exitCode: null, signalCode: "SIGKILL" });
    terminate(child);
    jest.advanceTimersByTime(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  // `close` waits for every stdio stream; a grandchild holding one open would
  // keep it from firing although the process itself is gone.
  it("does not SIGKILL once the process has exited, even without close", () => {
    const child = makeChild();
    terminate(child);
    child.emit("exit", null, "SIGTERM");
    jest.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
