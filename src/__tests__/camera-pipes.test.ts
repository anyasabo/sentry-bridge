import { ChildProcess } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCamera } from "../camera/camera";

// Uses a real child process: the bug only exists with a real pipe that fills up.
// Only the binary is swapped; Jest's sandboxed process.env doesn't reach spawn.
const fakeBin = { path: "", children: [] as ChildProcess[] };
jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawn: (_cmd: string, args: string[], options: object) => {
      const child = actual.spawn(fakeBin.path, args, options);
      fakeBin.children.push(child);
      return child;
    },
  };
});

// Fills one pipe with more than it can hold, then proves it got past that write.
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const isRtp = args.includes("rtp");
fs.writeSync(isRtp ? 1 : 2, "x".repeat(1024 * 1024));
if (isRtp) fs.writeSync(2, "past-stdout-write");
else fs.writeSync(1, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
if (args.includes("-frames:v")) process.exit(0);
setTimeout(() => {}, 60000);
`;

const config = {
  rtspUrl: "rtsp://192.168.178.65/live",
  frameIntervalSeconds: 10,
};

describe("Camera ffmpeg pipes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-ffmpeg-"));
    fakeBin.path = join(dir, "ffmpeg");
    writeFileSync(fakeBin.path, FAKE_FFMPEG);
    chmodSync(fakeBin.path, 0o755);
  });

  afterEach(async () => {
    // No child may outlive its test, also when the test fails.
    await Promise.all(
      fakeBin.children.splice(0).map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve(null);
            } else {
              child.once("exit", resolve);
              child.kill("SIGKILL");
            }
          })
      )
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps delivering MJPEG frames when ffmpeg fills stderr", (done) => {
    const camera = createCamera(config);
    camera.onFrame((frame) => {
      expect(frame.length).toBeGreaterThan(0);
      camera.stop();
      done();
    });
    camera.start();
  }, 5000);

  it("finishes testStream() when ffmpeg fills stderr", async () => {
    const frame = await createCamera(config).testStream(3000);
    expect(frame.length).toBeGreaterThan(0);
  }, 5000);

  it("keeps the RTP ffmpeg running when it fills stdout", (done) => {
    const camera = createCamera(config);
    const stderrWrite = jest
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        if (String(chunk).includes("past-stdout-write")) {
          stderrWrite.mockRestore();
          // Stop after the stderr handler returns, or it re-arms the watchdog.
          setImmediate(() => {
            camera.stopRtpStream();
            done();
          });
        }
        return true;
      });
    camera.startRtpStream(5004);
  }, 5000);
});
