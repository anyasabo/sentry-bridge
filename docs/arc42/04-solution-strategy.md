# 4. Solution Strategy

## Approach

SentryBridge is a thin translation layer: it speaks the PrusaLink HTTP API on one side and the Obico OctoPrint WebSocket protocol on the other. No protocol is extended or modified — the bridge adapts between them.

## Key Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js 22 + TypeScript | Async I/O suits the polling + WebSocket workload; TypeScript provides type safety across module boundaries |
| Agent identity | OctoPrint agent protocol (not Moonraker) | OctoPrint identity is stable and well-documented; Moonraker identity unlocks Janus features that are experimental (ADR #46) |
| Camera pipeline | ffmpeg subprocess → JPEG extraction | Proven RTSP→JPEG path; ffmpeg handles codec negotiation; no native Node.js RTSP library required |
| Live stream | Janus WebRTC gateway (bundled in container) | Obico control panel requires WebRTC for low-latency view; MJPEG alone is insufficient |
| File upload | multer diskStorage (not memoryStorage) | Files up to 200 MB must not OOM the Node.js process |
| Config persistence | JSON file on mounted Docker volume | Zero external dependencies; survives container restart; user can inspect and edit |
| Frontend | React + Vite + Mantine v9 + i18next | Productive component library; i18n for EN/DE from the start |

## Resilience Strategy

All three external connections are wrapped in a Circuit Breaker (via `circuitBreakerRegistry`) and recover automatically:

| Component | Recovery mechanism |
|-----------|--------------------|
| PrusaLink HTTP | Circuit breaker opens after 5 consecutive failures; resets after 60 s |
| Obico WebSocket | Exponential backoff reconnect; circuit breaker reset on manual reconnect |
| Camera (ffmpeg) | Restart on crash; stop/start cycle on config change |

## Security Posture

- No API authentication — LAN-only risk accepted in current version; API auth is a known future item
- SSRF mitigation on `file_downloader.download` — only URLs from the configured Obico server origin are accepted
- EoP mitigation on `http.tunnelv2` — only `/api/*` paths are forwarded; bridge cannot be used as a general proxy
- zlib compression on tunnel payloads ≥ 1000 bytes — prevents large uncompressed payloads
