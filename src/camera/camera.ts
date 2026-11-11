import { spawn, ChildProcess } from "child_process";
import { CameraConfig, CameraModule, FrameSubscriber } from "./types";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import { calculateDelay } from "../lib/retry";
import { terminate } from "../lib/terminate";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor, circuitBreakerRegistry } from "../lib/health";
import { HealthState, ErrorSeverity } from "../lib/health-monitor";

// ffmpeg prints its input URL, password included. The greedy match runs to
// the last "@" before the host, as ffmpeg does, so an "@" in the password is
// also hidden.
function redactRtspCredentials(text: string): string {
  return text.replace(/(rtsps?:\/\/)[^\s/]*@/gi, "$1***@");
}

function discard(): void {}

/** Single exit point for ffmpeg output that reaches logs or error messages. */
export function formatFfmpegLog(text: string): string {
  return redactRtspCredentials(text);
}

const STDERR_TAIL_LINES = 20;

interface StderrTail {
  lines(): string[];
  clear(): void;
}

/** Keeps the last few stderr lines of a process for diagnostics. */
function trackStderrTail(child: ChildProcess): StderrTail {
  let lines: string[] = [];
  let partial = "";
  child.stderr!.on("data", (d: Buffer | string) => {
    const parts = (partial + String(d)).split(/\r?\n|\r/);
    partial = parts.pop()!;
    lines.push(...parts.filter((line) => line.trim() !== ""));
    if (lines.length > STDERR_TAIL_LINES) {
      lines = lines.slice(-STDERR_TAIL_LINES);
    }
  });
  return {
    lines() {
      const all = partial.trim() !== "" ? [...lines, partial] : lines;
      return all.slice(-STDERR_TAIL_LINES);
    },
    clear() {
      lines = [];
      partial = "";
    },
  };
}

export function createCamera(config: CameraConfig): CameraModule {
  let proc: ChildProcess | null = null;
  let rtpProc: ChildProcess | null = null;
  let frameCallback: ((frame: Buffer) => void) | null = null;
  const subscribers = new Map<symbol, FrameSubscriber>();

  let mjpegStopped = false;
  let mjpegGeneration = 0;
  let mjpegRestartAttempt = 0;
  let mjpegRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let mjpegWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let mjpegStderr: StderrTail | null = null;
  const MJPEG_WATCHDOG_MS = 10_000;
  // RTSP connect plus first decoded frame can take well over the frame gap.
  const MJPEG_FIRST_FRAME_MS = 30_000;
  const MJPEG_OPEN_RETRY_MARGIN_MS = 1_000;

  let rtpStopped = false;
  let rtpRestartAttempt = 0;
  let rtpRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let rtpPort: number | null = null;
  let rtpGeneration = 0;
  let rtpRecoverCallback: (() => void) | null = null;
  let rtpWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const RTP_WATCHDOG_MS = 30_000;

  // Registered on start(): a camera used only for testStream() must not
  // replace the running stream's breaker in the health view.
  const cb = createCircuitBreaker(resilienceConfig.circuitBreaker);

  let lastFrame: Buffer | null = null;
  let lastFrameAt = 0;

  function emitFrame(frame: Buffer): void {
    lastFrame = frame;
    lastFrameAt = Date.now();
    if (frameCallback) frameCallback(frame);
    for (const sub of subscribers.values()) sub.onFrame(frame);
  }

  function endSubscriptions(): void {
    const ended = [...subscribers.values()];
    subscribers.clear();
    for (const sub of ended) sub.onEnd();
  }

  // Every pipe must be read: once one is full, ffmpeg blocks on its next write
  // to it. Blocked on stderr, ffmpeg stops producing output at its next log
  // message, which can take hours to arrive.
  function spawnFfmpeg(args: string[]): ChildProcess {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", discard);
    return child;
  }

  // Clears the tail once logged, so a watchdog kill and the exit that follows
  // don't print the same lines twice.
  function logMjpegStderr(): void {
    const lines = mjpegStderr?.lines() ?? [];
    if (lines.length === 0) return;
    mjpegStderr!.clear();
    console.warn(
      formatFfmpegLog(`[camera] MJPEG ffmpeg stderr:\n${lines.join("\n")}`)
    );
  }

  function resetMjpegWatchdog(timeoutMs = MJPEG_WATCHDOG_MS): void {
    if (mjpegWatchdogTimer) clearTimeout(mjpegWatchdogTimer);
    mjpegWatchdogTimer = setTimeout(() => {
      if (mjpegStopped) return;
      const msg = `MJPEG watchdog: no frame for ${timeoutMs / 1000}s`;
      console.warn(`[camera] ${msg} — killing ffmpeg`);
      logMjpegStderr();
      healthMonitor.setState("camera", HealthState.RECOVERING);
      healthMonitor.pushError("camera", msg, ErrorSeverity.ERROR);
      if (proc) {
        terminate(proc);
        proc = null;
      }
    }, timeoutMs);
  }

  function spawnMjpeg(): void {
    const gen = ++mjpegGeneration;
    let spawned = false;
    cb.execute(
      () =>
        new Promise<void>((resolve, reject) => {
          spawned = true;
          proc = spawnFfmpeg([
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "warning",
            "-rtsp_transport",
            "tcp",
            "-i",
            config.rtspUrl,
            "-vf",
            "fps=5",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ]);
          mjpegStderr = trackStderrTail(proc);
          // Without a listener, a spawn failure (e.g. ENOENT) crashes the
          // process. The `close` that follows schedules the restart.
          proc.on("error", (err) => {
            if (gen !== mjpegGeneration) return;
            const msg = `MJPEG ffmpeg error: ${err.message}`;
            console.error(`[camera] ${msg}`);
            healthMonitor.pushError("camera", msg, ErrorSeverity.ERROR);
          });
          // Armed before the first frame too: ffmpeg can hang while connecting.
          resetMjpegWatchdog(MJPEG_FIRST_FRAME_MS);

          let firstFrameSeen = false;
          const chunks: Buffer[] = [];

          proc.stdout!.on("data", (chunk: Buffer) => {
            if (gen !== mjpegGeneration) return; // output of a replaced process
            chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
            if (end !== -1) {
              const frame = buf.subarray(0, end + 2);
              chunks.length = 0;
              const remainder = buf.subarray(end + 2);
              if (remainder.length > 0) chunks.push(remainder);
              mjpegRestartAttempt = 0;
              healthMonitor.setState("camera", HealthState.HEALTHY);
              resetMjpegWatchdog();
              if (!firstFrameSeen) {
                firstFrameSeen = true;
                resolve();
              }
              emitFrame(frame);
            }
          });

          proc.on("close", (code) => {
            if (gen !== mjpegGeneration) {
              // stale close event from a superseded process
              if (!firstFrameSeen) resolve();
              return;
            }
            if (mjpegWatchdogTimer) {
              clearTimeout(mjpegWatchdogTimer);
              mjpegWatchdogTimer = null;
            }
            proc = null;
            if (mjpegStopped) {
              if (!firstFrameSeen) resolve(); // clean shutdown before first frame — do not count as CB failure
              return;
            }
            if (code !== 0) logMjpegStderr();
            const msg = `MJPEG stream exited (code ${code})`;
            console.log(`[camera] ${msg} — restarting`);
            healthMonitor.setState("camera", HealthState.RECOVERING);
            healthMonitor.pushError("camera", msg, ErrorSeverity.ERROR);
            healthMonitor.incrementRestarts("camera");
            const delay = calculateDelay(
              mjpegRestartAttempt,
              resilienceConfig.retry
            );
            mjpegRestartAttempt++;
            mjpegRestartTimer = setTimeout(() => spawnMjpeg(), delay);
            if (!firstFrameSeen) {
              reject(new Error(msg));
            }
          });
        })
    ).catch(() => {
      // A failed connect already scheduled its restart in the `close` handler.
      if (spawned || mjpegStopped || gen !== mjpegGeneration) return;
      // The breaker is OPEN and refused the spawn: retry once it should let a
      // probe through. The margin keeps the retry clear of the breaker's own
      // timing and bounds the retry rate if the breaker still refuses.
      const delay =
        (cb.stats.timeUntilHalfOpenMs ?? 0) + MJPEG_OPEN_RETRY_MARGIN_MS;
      mjpegRestartTimer = setTimeout(() => spawnMjpeg(), delay);
    });
  }

  function resetRtpWatchdog(gen: number): void {
    if (rtpWatchdogTimer) clearTimeout(rtpWatchdogTimer);
    rtpWatchdogTimer = setTimeout(() => {
      if (gen !== rtpGeneration) return;
      const msg = `RTP watchdog: no output for ${RTP_WATCHDOG_MS / 1000}s`;
      console.warn(`[camera] ${msg} — killing ffmpeg`);
      healthMonitor.setState("rtp_stream", HealthState.RECOVERING);
      healthMonitor.pushError("rtp_stream", msg, ErrorSeverity.ERROR);
      if (rtpProc) {
        terminate(rtpProc);
        rtpProc = null;
      }
    }, RTP_WATCHDOG_MS);
  }

  function spawnRtp(port: number, isRestart = false): void {
    const gen = ++rtpGeneration;
    rtpProc = spawnFfmpeg([
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "warning",
      // Progress reports on stdout every 0.5 s are the watchdog's sign of life.
      "-progress",
      "pipe:1",
      "-rtsp_transport",
      "tcp",
      "-i",
      config.rtspUrl,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-g",
      "30",
      "-b:v",
      "1500k",
      "-maxrate",
      "2000k",
      "-bufsize",
      "2000k",
      "-f",
      "rtp",
      `rtp://127.0.0.1:${port}?pkt_size=1300`,
    ]);
    rtpProc.stdout!.on("data", () => {
      if (gen !== rtpGeneration) return;
      resetRtpWatchdog(gen);
    });
    rtpProc.stderr!.on("data", (d: Buffer) => {
      if (gen !== rtpGeneration) return;
      process.stderr.write(`[camera/rtp] ${formatFfmpegLog(String(d))}`);
    });
    rtpProc.on("close", (code) => {
      if (gen !== rtpGeneration) return; // stale close event from a superseded process
      if (rtpWatchdogTimer) {
        clearTimeout(rtpWatchdogTimer);
        rtpWatchdogTimer = null;
      }
      rtpProc = null;
      if (rtpStopped) return;
      const msg = `RTP stream exited (code ${code})`;
      console.log(`[camera] ${msg} — restarting`);
      healthMonitor.setState("rtp_stream", HealthState.RECOVERING);
      healthMonitor.pushError("rtp_stream", msg, ErrorSeverity.ERROR);
      healthMonitor.incrementRestarts("rtp_stream");
      const delay = calculateDelay(rtpRestartAttempt, resilienceConfig.retry);
      rtpRestartAttempt++;
      rtpRestartTimer = setTimeout(() => spawnRtp(port, true), delay);
    });
    healthMonitor.setState("rtp_stream", HealthState.HEALTHY);
    if (isRestart && rtpRecoverCallback) {
      rtpRecoverCallback();
    }
    resetRtpWatchdog(gen);
  }

  return {
    onFrame(callback: (frame: Buffer) => void): void {
      frameCallback = callback;
    },

    start(): void {
      if (proc) return;
      circuitBreakerRegistry.set("camera", cb);
      mjpegStopped = false;
      mjpegRestartAttempt = 0;
      spawnMjpeg();
    },

    stop(): void {
      mjpegStopped = true;
      if (mjpegRestartTimer) {
        clearTimeout(mjpegRestartTimer);
        mjpegRestartTimer = null;
      }
      if (mjpegWatchdogTimer) {
        clearTimeout(mjpegWatchdogTimer);
        mjpegWatchdogTimer = null;
      }
      if (proc) {
        terminate(proc);
        proc = null;
      }
      lastFrame = null;
      healthMonitor.setState("camera", HealthState.DOWN);
      endSubscriptions();
    },

    stopGracefully(timeoutMs: number): Promise<void> {
      mjpegStopped = true;
      if (mjpegRestartTimer) {
        clearTimeout(mjpegRestartTimer);
        mjpegRestartTimer = null;
      }
      if (mjpegWatchdogTimer) {
        clearTimeout(mjpegWatchdogTimer);
        mjpegWatchdogTimer = null;
      }
      lastFrame = null;
      healthMonitor.setState("camera", HealthState.DOWN);
      endSubscriptions();
      const p = proc;
      proc = null;
      if (!p) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const fallback = setTimeout(() => {
          try {
            p.kill("SIGKILL");
          } catch {
            /* already dead */
          }
          resolve();
        }, timeoutMs);
        p.once("close", () => {
          clearTimeout(fallback);
          resolve();
        });
        try {
          p.kill("SIGINT");
        } catch {
          clearTimeout(fallback);
          resolve();
        }
      });
    },

    subscribe(id: symbol, subscriber: FrameSubscriber): void {
      subscribers.set(id, subscriber);
    },

    unsubscribe(id: symbol): void {
      subscribers.delete(id);
    },

    startRtpStream(port: number): void {
      if (rtpProc) return;
      rtpStopped = false;
      rtpPort = port;
      rtpRestartAttempt = 0;
      console.log(`[camera] Starting H.264 RTP stream → 127.0.0.1:${port}`);
      spawnRtp(port);
    },

    onRtpRecover(callback: () => void): void {
      rtpRecoverCallback = callback;
    },

    stopRtpStream(): void {
      rtpStopped = true;
      rtpPort = null;
      rtpGeneration++; // invalidate any pending close handlers or restart timers
      if (rtpRestartTimer) {
        clearTimeout(rtpRestartTimer);
        rtpRestartTimer = null;
      }
      if (rtpWatchdogTimer) {
        clearTimeout(rtpWatchdogTimer);
        rtpWatchdogTimer = null;
      }
      if (rtpProc) {
        terminate(rtpProc);
        rtpProc = null;
      }
      healthMonitor.setState("rtp_stream", HealthState.DOWN);
    },

    latestFrame(maxAgeMs: number): Buffer | null {
      if (!lastFrame || Date.now() - lastFrameAt > maxAgeMs) return null;
      return lastFrame;
    },

    testStream(timeoutMs = 10_000): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const p = spawnFfmpeg([
          "-rtsp_transport",
          "tcp",
          "-timeout",
          "8000000", // 8s RTSP-Socket-Timeout (Mikrosekunden) — innerer Wächter
          "-i",
          config.rtspUrl,
          "-frames:v",
          "1",
          "-update",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ]);

        const stderrTail = trackStderrTail(p);
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          terminate(p);
          reject(new Error(`testStream timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const chunks: Buffer[] = [];
        p.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));

        p.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`ffmpeg error: ${err.message}`));
        });

        p.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          if (code !== 0 && buf.length === 0) {
            const lastLine = stderrTail.lines().pop();
            const detail = lastLine ? `: ${lastLine}` : "";
            reject(
              new Error(
                formatFfmpegLog(`ffmpeg exited with code ${code}${detail}`)
              )
            );
            return;
          }
          resolve(buf);
        });
      });
    },
  };
}
