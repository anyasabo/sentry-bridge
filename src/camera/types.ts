export interface CameraConfig {
  rtspUrl: string;
  frameIntervalSeconds: number;
}

/** A /stream client: receives frames until the stream ends. */
export interface FrameSubscriber {
  onFrame(frame: Buffer): void;
  /** Fires once when stop() or stopGracefully() ends the stream; the subscription is then removed. */
  onEnd(): void;
}

export interface CameraModule {
  start(): void;
  stop(): void;
  /** Graceful ffmpeg teardown: SIGINT, then SIGKILL after timeoutMs. Resolves when proc exits or fallback fires. */
  stopGracefully(timeoutMs: number): Promise<void>;
  onFrame(callback: (frame: Buffer) => void): void;
  subscribe(id: symbol, subscriber: FrameSubscriber): void;
  unsubscribe(id: symbol): void;
  testStream(timeoutMs?: number): Promise<Buffer>;
  /** Last frame of the running stream, or null if none is newer than maxAgeMs. */
  latestFrame(maxAgeMs: number): Buffer | null;
  /** Start a parallel H.264 RTP stream to 127.0.0.1:{port} for Janus. */
  startRtpStream(port: number): void;
  stopRtpStream(): void;
  /** Fired after a successful RTP restart (not the initial start). */
  onRtpRecover(callback: () => void): void;
}
