import { Router, Request, Response } from "express";
import { getCameraInstance } from "../camera/registry";

const router = Router();
const BOUNDARY = "mjpegframe";

router.get("/stream", (req: Request, res: Response) => {
  const camera = getCameraInstance();
  if (!camera) {
    res.status(503).json({ message: "Camera not running" });
    return;
  }

  res.setHeader(
    "Content-Type",
    `multipart/x-mixed-replace; boundary=${BOUNDARY}`
  );
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const id = Symbol("stream-client");

  camera.subscribe(id, {
    onFrame(frame: Buffer) {
      if (res.writableEnded) return;
      res.write(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
      );
      res.write(frame);
      res.write("\r\n");
    },
    // The camera was stopped or replaced: end the response so the client
    // reconnects to the current instance instead of waiting forever.
    onEnd() {
      res.end();
    },
  });

  req.on("close", () => {
    camera.unsubscribe(id);
  });
});

export { router as streamRouter };
