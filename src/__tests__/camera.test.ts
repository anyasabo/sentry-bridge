import { EventEmitter } from "events";
import { createCamera, formatFfmpegLog } from "../camera/camera";
import { CameraConfig } from "../camera/types";
import { healthMonitor } from "../lib/health";
import { ErrorSeverity, HealthState } from "../lib/health-monitor";

jest.mock("child_process");
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

// Also restores real timers when a test fails before reaching its end.
afterEach(() => {
  jest.useRealTimers();
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
      const { circuitBreakerRegistry } = require("../lib/health");
      circuitBreakerRegistry.delete("camera");
    });

    it("registers a circuit breaker under 'camera' when the camera is created", () => {
      const { circuitBreakerRegistry } = require("../lib/health");
      const { CircuitState } = require("../lib/circuit-breaker");
      createCamera(config);
      const cb = circuitBreakerRegistry.get("camera");
      expect(cb).toBeDefined();
      expect(cb!.state).toBe(CircuitState.CLOSED);
    });

    it("allows reset() on the registered breaker to leave state CLOSED", () => {
      const { circuitBreakerRegistry } = require("../lib/health");
      const { CircuitState } = require("../lib/circuit-breaker");
      createCamera(config);
      const cb = circuitBreakerRegistry.get("camera")!;
      cb.reset();
      expect(cb.state).toBe(CircuitState.CLOSED);
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

      jest.advanceTimersByTime(10_000);
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

    it("quiets the MJPEG ffmpeg but leaves RTP stats on", () => {
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
      expect(rtpArgs).not.toContain("-nostats");
      expect(rtpArgs).not.toContain("-loglevel");
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
