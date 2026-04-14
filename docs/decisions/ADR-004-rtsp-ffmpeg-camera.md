# ADR-004: RTSP Camera Stream via ffmpeg

## Status

Accepted

## Context and Problem Statement

Obico requires a continuous camera stream for AI failure detection. The Prusa Core One's integrated camera (Buddy3D board) exposes an RTSP stream at `rtsp://[printer-ip]/live` — unauthenticated, LAN-only. Obico expects camera frames as base64-encoded JPEG uploaded via HTTP POST. How should SentryBridge capture and forward camera frames?

## Decision Drivers

- Source is RTSP H.264 — must decode to JPEG for Obico's HTTP upload endpoint.
- ffmpeg is a proven, widely available tool for RTSP transcoding. It is available as an Alpine package.
- Frame interval is configurable (default: 2 s = 0.5 fps for AI detection; Obico default is 10 s).
- The camera stream is mandatory — the setup wizard blocks progression if the RTSP stream is unreachable.

## Considered Options

1. **ffmpeg spawned as child process** — spawn per frame or with `-vframes 1` for on-demand capture.
2. **node-rtsp-stream** — npm package wrapping ffmpeg, WebSocket-based streaming.
3. **VLC** — alternative to ffmpeg, heavier dependency.

## Decision Outcome

Chosen: **Option 1 — ffmpeg spawned as child process** per frame (`-vframes 1 -f image2pipe`).

Reasoning: maximum control over frame timing, simple implementation (one spawn per frame), no additional npm dependencies beyond ffmpeg binary. ffmpeg is packaged in the Docker image via `apk add ffmpeg`.

## Consequences

- **Positive:** Reliable RTSP → JPEG extraction. Works with the Buddy3D camera's unauthenticated RTSP stream. Configurable frame interval. ffmpeg also handles the Janus RTP relay for WebRTC.
- **Negative:** Each frame spawns a new ffmpeg process — higher overhead than a persistent ffmpeg pipeline. Acceptable for 0.5 fps (one frame every 2 s).
- **Known limitation:** If the RTSP stream goes down after pairing, the camera circuit breaker trips and the dashboard shows a camera error. Automatic recovery occurs when ffmpeg frames resume successfully.
