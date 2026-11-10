import { ChildProcess } from "child_process";

const SIGKILL_DELAY_MS = 5_000;

// SIGTERM reaches the process, but ffmpeg's handler only sets a flag; a thread
// blocked in write() resumes the write and never checks it. Restarts hang off
// the process exiting, so one that ignores SIGTERM would never be replaced.
export function terminate(child: ChildProcess): void {
  // Already gone: nothing to signal, and no `exit` would cancel the timer.
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_DELAY_MS);
  killTimer.unref();
  child.once("exit", () => clearTimeout(killTimer));
}
