# Chapter 12: Glossary

| Term | Definition |
|------|------------|
| **Bridge** | SentryBridge itself — the Docker service that connects PrusaLink to Obico. Also used as shorthand for the Bridge Orchestrator (`src/bridge.ts`). |
| **Buddy3D** | The camera board integrated in the Prusa Core One printer. Exposes an unauthenticated RTSP stream at `rtsp://[printer-ip]/live`. |
| **Circuit Breaker** | A resilience pattern implemented in `src/lib/circuit-breaker.ts`. Transitions between CLOSED, OPEN, and HALF-OPEN states based on failure counts. Prevents request storms against failing external services. |
| **Config Hot-Reload** | The mechanism by which configuration changes saved via the dashboard take effect without restarting the Docker container. Implemented via `configEmitter` event in `src/config/config.ts`. |
| **HTTP Digest Auth** | The authentication scheme required by PrusaLink's HTTP API. Uses a challenge-response protocol to avoid sending credentials in plaintext. |
| **Janus** | An open-source WebRTC gateway (`janus-gateway`) bundled in the SentryBridge Docker image. Used to relay the RTSP camera stream as a WebRTC feed for the Obico control panel. |
| **MJPEG** | Motion JPEG — a streaming format where individual JPEG frames are sent as a multipart HTTP response. Used as a fallback when WebRTC is unavailable. |
| **Obico** | An open-source AI-powered 3D print failure detection platform. SentryBridge connects to Obico via its WebSocket agent protocol. Formerly "The Spaghetti Detective". |
| **OctoPrint Consumer** | The server-side WebSocket consumer in Obico that handles agent connections. SentryBridge uses the `moonraker_obico` agent identity to connect to this consumer. |
| **Passthru** | The Obico WebSocket protocol mechanism for forwarding control commands (pause, resume, cancel, start print) from the Obico server to the agent. Commands include a `ref` for ACK matching. |
| **PrusaLink** | Prusa's embedded HTTP API available on Prusa printers (Core One, MK4S, MK3.9 with Buddy board). Provides printer status, job control, and file management. |
| **RTSP** | Real-Time Streaming Protocol — used by the Buddy3D camera to stream H.264 video. SentryBridge captures individual frames from the RTSP stream via ffmpeg. |
| **SentryBridge** | The open-source project name for this bridge service (formerly `obico-prusalink-bridge`). |
| **Setup Wizard** | The 4-step browser-based onboarding flow: PrusaLink credentials → camera test → Obico pairing → done. |
| **Volume** | A Docker volume mounted at `/config` inside the container. Contains `config.json` — the only persistent state for SentryBridge. |
| **WebRTC** | Web Real-Time Communication — a browser-native protocol for low-latency audio/video. Used by the Obico control panel for the live camera stream. Janus relays the RTSP stream to WebRTC. |
