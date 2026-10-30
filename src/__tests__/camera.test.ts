import { EventEmitter } from "events";
import { createCamera, formatFfmpegLog } from "../camera/camera";
import { CameraConfig } from "../camera/types";
import { healthMonitor, circuitBreakerRegistry } from "../lib/health";
import { metricsRegistry } from "../lib/metrics";
import { ErrorSeverity, HealthState } from "../lib/health-monitor";
import * as circuitBreakerModule from "../lib/circuit-breaker";
import { CircuitState } from "../lib/circuit-breaker";

jest.mock("child_process");
// Wrap the real factory in a jest.fn so single tests can override it
// (ES module exports are not redefinable, so jest.spyOn cannot patch them).
jest.mock("../lib/circuit-breaker", () => {
  const actual = jest.requireActual("../lib/circuit-breaker");
  return {
    ...actual,
    createCircuitBreaker: jest.fn(actual.createCircuitBreaker),
  };
});
import * as cp from "child_process";

const mockSpawn = cp.spawn as jest.MockedFunction<typeof cp.spawn>;

const config: CameraConfig = {
  rtspUrl: "rtsp://192.168.178.65/live",
  frameIntervalSeconds: 10,
};

function makeMockProcess(options: {
  stdoutData?: Buffer[];
  stderrData?: string[];
  exitCode?: number;
  errorOnSpawn?: Error;
}): cp.ChildProcess {
  const proc = new EventEmitter() as cp.ChildProcess;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc.stdout = new EventEmitter() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc.stderr = new EventEmitter() as any;
  proc.kill = jest.fn();

  setImmediate(() => {
    if (options.stderrData) {
      for (const line of options.stderrData) {
        proc.stderr!.emit("data", line);
      }
    }
    if (options.stdoutData) {
      for (const chunk of options.stdoutData) {
        proc.stdout!.emit("data", chunk);
      }
      proc.stdout!.emit("end");
    }
    if (options.exitCode !== undefined) {
      proc.emit("close", options.exitCode);
    }
  });

  return proc;
}

// Minimal valid JPEG (SOI + EOI markers)
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

beforeEach(() => {
  jest.clearAllMocks();
});

// Also restores real timers and spies when a test fails before its end.
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("Camera", () => {
  describe("testStream()", () => {
    it("spawns ffmpeg with correct args and returns a Buffer", async () => {
      mockSpawn.mockReturnValue(
        makeMockProcess({ stdoutData: [fakeJpeg], exitCode: 0 })
      );
      const camera = createCamera(config);
      const frame = await camera.testStream();
      expect(frame).toBeInstanceOf(Buffer);
      expect(frame.length).toBeGreaterThan(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining([
          "-rtsp_transport",
          "tcp",
          "-i",
          config.rtspUrl,
          "-frames:v",
          "1",
        ]),
        expect.anything()
      );
    });

    it("passes the RTSP socket timeout under its current FFmpeg name", async () => {
      mockSpawn.mockReturnValue(
        makeMockProcess({ stdoutData: [fakeJpeg], exitCode: 0 })
      );
      await createCamera(config).testStream();
      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain("-timeout");
      expect(args).not.toContain("-stimeout"); // removed in FFmpeg 5.0
    });

    it("rejects when ffmpeg exits with non-zero code", async () => {
      mockSpawn.mockReturnValue(
        makeMockProcess({ stdoutData: [], exitCode: 1 })
      );
      const camera = createCamera(config);
      await expect(camera.testStream()).rejects.toThrow();
    });

    it("rejects when ffmpeg emits an error event", async () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      setImmediate(() =>
        proc.emit("error", new Error("ENOENT: ffmpeg not found"))
      );
      const camera = createCamera(config);
      await expect(camera.testStream()).rejects.toThrow(/ffmpeg/i);
    });

    it("rejects with timeout error when ffmpeg does not close within timeoutMs", async () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({}); // emittiert nie "close"
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      const promise = camera.testStream(5000);
      jest.advanceTimersByTime(5001);
      await Promise.resolve(); // Microtask-Queue drainieren
      await expect(promise).rejects.toThrow(/timed out/i);
      expect(proc.kill).toHaveBeenCalled();
    });
  });

  describe("circuit breaker registration", () => {
    beforeEach(() => {
      // Ensure clean registry state
      circuitBreakerRegistry.delete("camera");
    });

    it("registers its circuit breaker under 'camera' once the stream starts", () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      camera.start();
      const cb = circuitBreakerRegistry.get("camera");
      expect(cb).toBeDefined();
      expect(cb!.state).toBe(CircuitState.CLOSED);
      camera.stop();
    });

    it("allows reset() on the registered breaker to leave state CLOSED", () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      camera.start();
      const cb = circuitBreakerRegistry.get("camera")!;
      cb.reset();
      expect(cb.state).toBe(CircuitState.CLOSED);
      camera.stop();
    });

    it("leaves the running stream's breaker alone when a one-off camera is created", async () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const streaming = createCamera(config);
      streaming.start();
      const streamingCb = circuitBreakerRegistry.get("camera");

      mockSpawn.mockReturnValue(
        makeMockProcess({ stdoutData: [fakeJpeg], exitCode: 0 })
      );
      await createCamera(config).testStream();

      expect(circuitBreakerRegistry.get("camera")).toBe(streamingCb);
      streaming.stop();
    });
  });

  describe("subscribe()", () => {
    it("ends every subscription on stop()", () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      camera.start();
      const onEnd = jest.fn();
      camera.subscribe(Symbol("a"), { onFrame: jest.fn(), onEnd: onEnd });
      camera.stop();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("ends every subscription on stopGracefully()", async () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      const onEnd = jest.fn();
      camera.subscribe(Symbol("a"), { onFrame: jest.fn(), onEnd: onEnd });
      await camera.stopGracefully(10);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("delivers no frames to an ended subscription", () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      const onFrame = jest.fn();
      camera.subscribe(Symbol("a"), { onFrame, onEnd: jest.fn() });
      camera.stop();
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      expect(onFrame).not.toHaveBeenCalled();
      camera.stop();
    });

    it("does not end a subscription that was removed", () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      const id = Symbol("a");
      const onEnd = jest.fn();
      camera.subscribe(id, { onFrame: jest.fn(), onEnd: onEnd });
      camera.unsubscribe(id);
      camera.stop();
      expect(onEnd).not.toHaveBeenCalled();
    });
  });

  describe("latestFrame()", () => {
    it("returns null before the stream delivered a frame", () => {
      mockSpawn.mockReturnValue(makeMockProcess({}));
      const camera = createCamera(config);
      camera.start();
      expect(camera.latestFrame(15_000)).toBeNull();
      camera.stop();
    });

    it("returns the last frame of the running stream", () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      expect(camera.latestFrame(15_000)).toEqual(fakeJpeg);
      camera.stop();
    });

    it("returns null once the last frame is older than maxAgeMs", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      jest.advanceTimersByTime(9_000);
      expect(camera.latestFrame(10_000)).toEqual(fakeJpeg);
      jest.advanceTimersByTime(2_000);
      expect(camera.latestFrame(10_000)).toBeNull();
      camera.stop();
    });

    it("returns null after stop()", () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      camera.stop();
      expect(camera.latestFrame(15_000)).toBeNull();
    });
  });

  describe("start() / stop() / onFrame()", () => {
    it("calls onFrame callback when ffmpeg emits stdout data", (done) => {
      mockSpawn.mockReturnValue(
        makeMockProcess({ stdoutData: [fakeJpeg], exitCode: 0 })
      );
      const camera = createCamera(config);
      camera.onFrame((frame: Buffer) => {
        expect(frame).toBeInstanceOf(Buffer);
        camera.stop();
        done();
      });
      camera.start();
    });

    it("spawns ffmpeg with interval-based fps filter", () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      expect(mockSpawn).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining([`fps=5`]),
        expect.anything()
      );
      camera.stop();
    });

    it("kills the ffmpeg process on stop()", () => {
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      camera.stop();
      expect(proc.kill).toHaveBeenCalled();
    });

    it("escalates to SIGKILL when ffmpeg ignores the watchdog's SIGTERM", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);

      jest.advanceTimersByTime(10_000);
      expect(proc.kill).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenLastCalledWith();

      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");

      camera.stop();
    });

    it("does not SIGKILL when ffmpeg exits after the watchdog's SIGTERM", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);

      jest.advanceTimersByTime(10_000);
      proc.emit("exit", 255, null);
      proc.emit("close", 255);
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenCalledTimes(1);

      camera.stop();
    });

    it("escalates to SIGKILL when ffmpeg ignores SIGTERM on stop()", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      camera.stop();
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
    });

    it("escalates to SIGKILL when the RTP ffmpeg ignores the watchdog", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);

      jest.advanceTimersByTime(30_000);
      expect(proc.kill).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");

      camera.stopRtpStream();
    });

    it("keeps an RTP ffmpeg alive while it reports progress on stdout", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);

      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(10_000);
        proc.stdout!.emit("data", Buffer.from("progress=continue\n"));
      }
      expect(proc.kill).not.toHaveBeenCalled();

      camera.stopRtpStream();
    });

    it("escalates to SIGKILL when the RTP ffmpeg ignores SIGTERM on stop", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);
      camera.stopRtpStream();
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
    });

    it("escalates to SIGKILL when ffmpeg ignores testStream()'s timeout", async () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const pending = createCamera(config).testStream(1000);
      jest.advanceTimersByTime(1000);
      await expect(pending).rejects.toThrow("timed out");
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
    });

    it("reports the camera as recovering as soon as the watchdog fires", () => {
      jest.useFakeTimers();
      const setState = jest.spyOn(healthMonitor, "setState");
      const pushError = jest.spyOn(healthMonitor, "pushError");
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      setState.mockClear();

      jest.advanceTimersByTime(10_000);
      expect(setState).toHaveBeenCalledWith("camera", HealthState.RECOVERING);
      expect(pushError).toHaveBeenCalledWith(
        "camera",
        expect.stringContaining("no frame"),
        ErrorSeverity.ERROR
      );

      camera.stop();
      setState.mockRestore();
      pushError.mockRestore();
    });

    it("reports the RTP stream as recovering as soon as its watchdog fires", () => {
      jest.useFakeTimers();
      const setState = jest.spyOn(healthMonitor, "setState");
      const pushError = jest.spyOn(healthMonitor, "pushError");
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);
      setState.mockClear();

      jest.advanceTimersByTime(30_000);
      expect(setState).toHaveBeenCalledWith(
        "rtp_stream",
        HealthState.RECOVERING
      );
      expect(pushError).toHaveBeenCalledWith(
        "rtp_stream",
        expect.stringContaining("no output"),
        ErrorSeverity.ERROR
      );

      camera.stopRtpStream();
      setState.mockRestore();
      pushError.mockRestore();
    });

    it("keeps tracking the new ffmpeg when the old one closes late", () => {
      const oldProc = makeMockProcess({});
      const newProc = makeMockProcess({});
      mockSpawn.mockReturnValueOnce(oldProc).mockReturnValueOnce(newProc);
      const camera = createCamera(config);
      camera.start();
      camera.stop();
      camera.start();

      oldProc.emit("close", 0);
      camera.stop();

      expect(newProc.kill).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it("terminates an ffmpeg that hangs before its first frame", () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();

      // A slow RTSP connect gets a grace period before the first frame.
      jest.advanceTimersByTime(10_000);
      expect(proc.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(19_000);
      expect(proc.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);
      expect(proc.kill).toHaveBeenCalledTimes(1);

      camera.stop();
      warn.mockRestore();
    });

    it("ignores frames from a replaced ffmpeg", () => {
      const oldProc = makeMockProcess({});
      const newProc = makeMockProcess({});
      mockSpawn.mockReturnValueOnce(oldProc).mockReturnValueOnce(newProc);
      const onFrame = jest.fn();
      const camera = createCamera(config);
      camera.onFrame(onFrame);
      camera.start();
      camera.stop();
      camera.start();

      oldProc.stdout!.emit("data", fakeJpeg);
      expect(onFrame).not.toHaveBeenCalled();

      newProc.stdout!.emit("data", fakeJpeg);
      expect(onFrame).toHaveBeenCalledTimes(1);
      camera.stop();
    });

    it("removes RTSP credentials from the RTP ffmpeg's forwarded log", async () => {
      const stderrWrite = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const proc = makeMockProcess({
        stderrData: [
          "Input #0, rtsp, from 'rtsp://user:s3cret@10.0.0.1/live':\n",
          "rtsps://admin:p@ssw0rd@cam.local:322/live: Connection refused\n",
        ],
      });
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);
      await new Promise((resolve) => setImmediate(resolve));

      const logged = stderrWrite.mock.calls.map(([chunk]) => chunk).join("");
      stderrWrite.mockRestore();
      camera.stopRtpStream();
      expect(logged).toContain("rtsp://***@10.0.0.1/live");
      expect(logged).toContain("rtsps://***@cam.local:322/live");
      expect(logged).not.toContain("s3cret");
      expect(logged).not.toContain("ssw0rd");
    });

    it("delivers frames again on its own after the circuit breaker opened", async () => {
      jest.useFakeTimers();
      jest.spyOn(console, "log").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const procs: cp.ChildProcess[] = [];
      mockSpawn.mockImplementation(() => {
        const p = makeMockProcess({});
        procs.push(p);
        return p;
      });
      const onFrame = jest.fn();
      const camera = createCamera(config);
      camera.onFrame(onFrame);
      camera.start();

      // RTSP unreachable: every ffmpeg exits before its first frame until the
      // breaker (threshold 5) opens and refuses further spawns.
      const breaker = circuitBreakerRegistry.get("camera")!;
      for (let i = 0; i < 20 && breaker.state !== CircuitState.OPEN; i++) {
        procs[procs.length - 1].emit("close", 1);
        await jest.advanceTimersByTimeAsync(30_000);
      }
      expect(breaker.state).toBe(CircuitState.OPEN);
      const spawnsWhileOpen = procs.length;

      // RTSP is back: once the breaker lets a probe through, ffmpeg is
      // spawned again and its frame gets through.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(procs.length).toBe(spawnsWhileOpen + 1);
      procs[procs.length - 1].stdout!.emit("data", fakeJpeg);
      await jest.advanceTimersByTimeAsync(0);

      expect(breaker.state).toBe(CircuitState.CLOSED);
      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(healthMonitor.getComponentStats("camera").state).toBe(
        HealthState.HEALTHY
      );
      camera.stop();
    });

    it("does not retry in a tight loop while the breaker still refuses", async () => {
      jest.useFakeTimers();
      jest.spyOn(console, "log").mockImplementation(() => {});
      // A breaker that claims to be due for HALF_OPEN but keeps refusing, as
      // when the retry timer fires just before the breaker's own reset timer.
      const execute = jest
        .fn()
        .mockRejectedValue(new Error("Circuit breaker is OPEN"));
      jest
        .mocked(circuitBreakerModule.createCircuitBreaker)
        .mockReturnValueOnce({
          state: CircuitState.OPEN,
          stats: {
            state: CircuitState.OPEN,
            failureCount: 5,
            totalFailures: 5,
            totalSuccesses: 0,
            openedAt: 0,
            timeUntilHalfOpenMs: 0,
          },
          execute,
          reset: jest.fn(),
        });
      const camera = createCamera(config);
      camera.start();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(execute.mock.calls.length).toBeLessThanOrEqual(2);
      camera.stop();
    });

    it("reports a MJPEG ffmpeg that fails to spawn instead of crashing", () => {
      const pushError = jest.spyOn(healthMonitor, "pushError");
      jest.spyOn(console, "error").mockImplementation(() => {});
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();

      expect(() =>
        proc.emit("error", new Error("spawn ffmpeg ENOENT"))
      ).not.toThrow();
      expect(pushError).toHaveBeenCalledWith(
        "camera",
        expect.stringContaining("ENOENT"),
        ErrorSeverity.ERROR
      );

      camera.stop();
    });

    it("records camera frames in the metrics", async () => {
      const lastFrame = async () =>
        (
          await metricsRegistry
            .getSingleMetric(
              "sentry_bridge_camera_last_frame_timestamp_seconds"
            )!
            .get()
        ).values[0].value;
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      const before = Date.now() / 1000;
      proc.stdout!.emit("data", fakeJpeg);
      expect(await lastFrame()).toBeGreaterThanOrEqual(Math.floor(before));
      camera.stop();
    });

    it("does not crash if stop() is called before start()", () => {
      const camera = createCamera(config);
      expect(() => camera.stop()).not.toThrow();
    });
  });

  describe("ffmpeg diagnostics", () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => `stderr-line-${String(i + 1).padStart(2, "0")}`
    );

    function loggedText(spy: jest.SpyInstance): string {
      return spy.mock.calls.map((args) => args.join(" ")).join("\n");
    }

    it("redacts RTSP credentials in formatFfmpegLog", () => {
      expect(
        formatFfmpegLog("Opening 'rtsp://user:s3cret@10.0.0.1/live'")
      ).toBe("Opening 'rtsp://***@10.0.0.1/live'");
    });

    it.each([
      ["a slash", "pa/ss"],
      ["a space", "pa ss"],
      ["a single quote", "pa'ss"],
      ["a double quote", 'pa"ss'],
      ["an @", "pa@ss"],
    ])("redacts a password containing %s", (_, pw) => {
      expect(formatFfmpegLog(`Opening 'rtsp://user:${pw}@10.0.0.1/live'`)).toBe(
        "Opening 'rtsp://***@10.0.0.1/live'"
      );
    });

    it.each([
      ["p@x/y", "p@x/y"],
      ["a quote", "pa'ss"],
      ["percent-encoding", "p%40x%2Fy"],
    ])(
      "never logs the configured password (%s), whatever its shape",
      async (_, pw) => {
        const decoded = decodeURIComponent(pw);
        mockSpawn.mockReturnValue(
          makeMockProcess({
            stderrData: [
              `Opening rtsp://user:${decoded}@10.0.0.1/live; auth ${decoded} and ${pw} rejected\n`,
            ],
            exitCode: 1,
          })
        );
        const err = (await createCamera({
          ...config,
          rtspUrl: `rtsp://user:${pw}@10.0.0.1/live`,
        })
          .testStream()
          .catch((e: Error) => e)) as Error;
        expect(err.message).toContain("10.0.0.1/live");
        expect(err.message).not.toContain(pw);
        expect(err.message).not.toContain(decoded);
      }
    );

    it("redacts two URLs on one line independently", () => {
      expect(
        formatFfmpegLog(
          "rtsp://a:x@10.0.0.1/live -> rtsps://b:y@cam.local:8554/s 'end'"
        )
      ).toBe("rtsp://***@10.0.0.1/live -> rtsps://***@cam.local:8554/s 'end'");
    });

    it("keeps host and path of an unquoted URL followed by an ffmpeg tag", () => {
      expect(
        formatFfmpegLog("rtsp://u:p@10.0.0.1/live [h264 @ 0x55] error")
      ).toBe("rtsp://***@10.0.0.1/live [h264 @ 0x55] error");
    });

    it("leaves a URL without credentials unchanged", () => {
      const line = "Opening rtsp://10.0.0.1/live [h264 @ 0x55] error";
      expect(formatFfmpegLog(line)).toBe(line);
    });

    it("redacts an IPv6 host URL", () => {
      expect(formatFfmpegLog("rtsp://u:p@[fe80::1]:554/live")).toBe(
        "rtsp://***@[fe80::1]:554/live"
      );
    });

    it("flushes an over-long stderr line without a newline", async () => {
      const long = "x".repeat(9000);
      mockSpawn.mockReturnValue(
        makeMockProcess({ stderrData: [long, "TAIL"], exitCode: 1 })
      );
      const err = await createCamera(config)
        .testStream()
        .catch((e: Error) => e);
      expect((err as Error).message).toContain("TAIL");
      expect((err as Error).message).not.toContain(long);
    });

    it("includes the pending stderr line in the testStream timeout error", async () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const promise = createCamera(config).testStream(1000);
      proc.stderr!.emit(
        "data",
        "Connection to rtsp://u:s3cret@10.0.0.1/live hangs"
      );
      jest.advanceTimersByTime(1001);
      const err = (await promise.catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/timed out/);
      expect(err.message).toContain("rtsp://***@10.0.0.1/live hangs");
      expect(err.message).not.toContain("s3cret");
    });

    it("redacts passwords containing '/' or spaces", () => {
      const out = formatFfmpegLog(
        "[rtsp @ 0x1] Opening 'rtsp://user:pa/ss wo@rd@10.0.0.1/live' failed"
      );
      expect(out).toBe(
        "[rtsp @ 0x1] Opening 'rtsp://***@10.0.0.1/live' failed"
      );
    });

    it("redacts a URL split across stderr chunks in testStream errors", async () => {
      mockSpawn.mockReturnValue(
        makeMockProcess({
          stderrData: [
            "Opening 'rtsp://user:s3c",
            "ret@10.0.0.1/live' failed: 401",
          ],
          exitCode: 1,
        })
      );
      const camera = createCamera(config);
      const err = await camera.testStream().catch((e: Error) => e);
      expect((err as Error).message).toContain("rtsp://***@10.0.0.1/live");
      expect((err as Error).message).not.toContain("s3c");
    });

    it("logs RTP ffmpeg stderr line by line with credentials redacted", () => {
      const spy = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.startRtpStream(5004);
      proc.stderr!.emit("data", "Opening 'rtsp://user:s3");
      proc.stderr!.emit("data", "cret@10.0.0.1/live'\n");
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      spy.mockRestore();
      camera.stop();
      expect(written).toContain("rtsp://***@10.0.0.1/live");
      expect(written).not.toContain("s3");
    });

    it("quiets both ffmpeg processes and reads RTP liveness from -progress", () => {
      mockSpawn.mockImplementation(() => makeMockProcess({}));
      const camera = createCamera(config);
      camera.start();
      camera.startRtpStream(5004);
      const [mjpegArgs, rtpArgs] = mockSpawn.mock.calls.map(
        (call) => call[1] as string[]
      );
      expect(mjpegArgs.slice(0, 4)).toEqual([
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "warning",
      ]);
      expect(rtpArgs.slice(0, 6)).toEqual([
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "warning",
        "-progress",
        "pipe:1",
      ]);
      camera.stop();
      camera.stopRtpStream();
    });

    it("logs the last 20 stderr lines when the MJPEG ffmpeg exits non-zero", () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      // Split across chunks the way a pipe delivers it.
      proc.stderr!.emit("data", Buffer.from(lines.slice(0, 3).join("\n")));
      proc.stderr!.emit("data", Buffer.from("\n" + lines.slice(3).join("\n")));
      proc.emit("close", 1);

      const logged = loggedText(warn);
      expect(logged).toContain("stderr-line-06");
      expect(logged).toContain("stderr-line-25");
      expect(logged).not.toContain("stderr-line-05");

      camera.stop();
      warn.mockRestore();
    });

    it("logs the stderr tail when the MJPEG watchdog fires", () => {
      jest.useFakeTimers();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);
      proc.stderr!.emit("data", Buffer.from("[h264] error while decoding\n"));

      jest.advanceTimersByTime(10_000);
      expect(loggedText(warn)).toContain("[h264] error while decoding");

      camera.stop();
      warn.mockRestore();
    });

    it("includes the last stderr line in testStream()'s exit error", async () => {
      mockSpawn.mockReturnValue(
        makeMockProcess({
          stderrData: ["first line\n", "Unrecognized option 'stimeout'.\n"],
          stdoutData: [],
          exitCode: 1,
        })
      );
      await expect(createCamera(config).testStream()).rejects.toThrow(
        "ffmpeg exited with code 1: Unrecognized option 'stimeout'."
      );
    });
  });
});
