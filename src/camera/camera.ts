import { spawn, ChildProcess } from "child_process";
import { CameraConfig, CameraModule } from "./types";
import { createCircuitBreaker } from "../lib/circuit-breaker";
import { calculateDelay } from "../lib/retry";
import { resilienceConfig } from "../lib/env-config";
import { healthMonitor, circuitBreakerRegistry } from "../lib/health";
import { HealthState, ErrorSeverity } from "../lib/health-monitor";

// ffmpeg prints its input URL, password included. The greedy match runs to
// the last "@" before the host, as ffmpeg does, so an "@" in the password is
// also hidden.
function redactRtspCredentials(text: string): string {
  return text.replace(/(rtsps?:\/\/)[^\s/]*@/gi, "$1***@");
}

export function createCamera(config: CameraConfig): CameraModule {
  let proc: ChildProcess | null = null;
  let rtpProc: ChildProcess | null = null;
  let frameCallback: ((frame: Buffer) => void) | null = null;
  const subscribers = new Map<symbol, (frame: Buffer) => void>();

  let mjpegStopped = false;
  let mjpegRestartAttempt = 0;
  let mjpegRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let mjpegWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const MJPEG_WATCHDOG_MS = 10_000;

  let rtpStopped = false;
  let rtpRestartAttempt = 0;
  let rtpRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let rtpPort: number | null = null;
  let rtpGeneration = 0;
  let rtpRecoverCallback: (() => void) | null = null;
  let rtpWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const RTP_WATCHDOG_MS = 30_000;

  const cb = createCircuitBreaker(resilienceConfig.circuitBreaker);
  circuitBreakerRegistry.set("camera", cb);

  function emitFrame(frame: Buffer): void {
    if (frameCallback) frameCallback(frame);
    for (const cb of subscribers.values()) cb(frame);
  }

  function spawnFfmpeg(args: string[]): ChildProcess {
    return spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  }

  function resetMjpegWatchdog(): void {
    if (mjpegWatchdogTimer) clearTimeout(mjpegWatchdogTimer);
    mjpegWatchdogTimer = setTimeout(() => {
      if (mjpegStopped) return;
      console.warn(
        "[camera] MJPEG watchdog: no frame for 30s — killing ffmpeg"
      );
      if (proc) {
        proc.kill();
        proc = null;
      }
    }, MJPEG_WATCHDOG_MS);
  }

  function spawnMjpeg(): void {
    cb.execute(
      () =>
        new Promise<void>((resolve, reject) => {
          proc = spawnFfmpeg([
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

          let firstFrameSeen = false;
          const chunks: Buffer[] = [];

          proc.stdout!.on("data", (chunk: Buffer) => {
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
            if (mjpegWatchdogTimer) {
              clearTimeout(mjpegWatchdogTimer);
              mjpegWatchdogTimer = null;
            }
            proc = null;
            if (mjpegStopped) {
              if (!firstFrameSeen) resolve(); // clean shutdown before first frame — do not count as CB failure
              return;
            }
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
      // CB opened or connect failed — restart scheduling is already handled
      // by the `close` handler above. Swallow to prevent unhandled rejection.
    });
  }

  function resetRtpWatchdog(gen: number): void {
    if (rtpWatchdogTimer) clearTimeout(rtpWatchdogTimer);
    rtpWatchdogTimer = setTimeout(() => {
      if (gen !== rtpGeneration) return;
      console.warn("[camera] RTP watchdog: no output for 30s — killing ffmpeg");
      if (rtpProc) {
        rtpProc.kill();
        rtpProc = null;
      }
    }, RTP_WATCHDOG_MS);
  }

  function spawnRtp(port: number, isRestart = false): void {
    const gen = ++rtpGeneration;
    rtpProc = spawnFfmpeg([
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
    rtpProc.stderr!.on("data", (d: Buffer) => {
      if (gen !== rtpGeneration) return;
      process.stderr.write(`[camera/rtp] ${redactRtspCredentials(String(d))}`);
      resetRtpWatchdog(gen);
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
        proc.kill();
        proc = null;
      }
      healthMonitor.setState("camera", HealthState.DOWN);
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
      healthMonitor.setState("camera", HealthState.DOWN);
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

    subscribe(id: symbol, callback: (frame: Buffer) => void): void {
      subscribers.set(id, callback);
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
        rtpProc.kill();
        rtpProc = null;
      }
      healthMonitor.setState("rtp_stream", HealthState.DOWN);
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

        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          p.kill();
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
            reject(new Error(`ffmpeg exited with code ${code}`));
            return;
          }
          resolve(buf);
        });
      });
    },
  };
}
