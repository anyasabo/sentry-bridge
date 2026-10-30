import { ChildProcess } from "child_process";

const SIGKILL_DELAY_MS = 5_000;

// A process can't act on SIGTERM while it is blocked in a write. Restarts hang
// off the `close` event, so one that never exits would never be replaced.
export function terminate(child: ChildProcess): void {
  child.kill();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_DELAY_MS);
  killTimer.unref();
  child.once("close", () => clearTimeout(killTimer));
}
