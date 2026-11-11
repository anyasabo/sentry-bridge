export interface CameraConfig {
  rtspUrl: string;
  frameIntervalSeconds: number;
}

export interface CameraModule {
  start(): void;
  stop(): void;
  /** Graceful ffmpeg teardown: SIGINT, then SIGKILL after timeoutMs. Resolves when proc exits or fallback fires. */
  stopGracefully(timeoutMs: number): Promise<void>;
  onFrame(callback: (frame: Buffer) => void): void;
  subscribe(id: symbol, callback: (frame: Buffer) => void): void;
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
