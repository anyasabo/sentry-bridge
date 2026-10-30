import { EventEmitter } from "events";
import { createCamera } from "../camera/camera";
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
      jest.useRealTimers();
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
      jest.useRealTimers();
    });

    it("does not SIGKILL when ffmpeg exits after the watchdog's SIGTERM", () => {
      jest.useFakeTimers();
      const proc = makeMockProcess({});
      mockSpawn.mockReturnValue(proc);
      const camera = createCamera(config);
      camera.start();
      proc.stdout!.emit("data", fakeJpeg);

      jest.advanceTimersByTime(10_000);
      proc.emit("close", 255);
      jest.advanceTimersByTime(5_000);
      expect(proc.kill).toHaveBeenCalledTimes(1);

      camera.stop();
      jest.useRealTimers();
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
      jest.useRealTimers();
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
      jest.useRealTimers();
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
      jest.useRealTimers();
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
      jest.useRealTimers();
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
      jest.useRealTimers();
    });

    it("removes RTSP credentials from the RTP ffmpeg's forwarded log", async () => {
      const stderrWrite = jest
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const proc = makeMockProcess({
        stderrData: [
          "Input #0, rtsp, from 'rtsp://user:s3cret@10.0.0.1/live':",
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
      expect(logged).not.toContain("s3cret");
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

    it("does not crash if stop() is called before start()", () => {
      const camera = createCamera(config);
      expect(() => camera.stop()).not.toThrow();
    });
  });
});
