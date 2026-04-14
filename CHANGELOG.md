# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-13

Milestone 3: Print & Files (Phases 13–15)

### Added

- **Dashboard File Browser** — browse G-code files from PrusaLink directly in the Obico dashboard; file list with name, size, and date; one-click print start (#48)
- **Resume bug fix** — `current_print_ts` stabilized; paused state included in forwarded status so Obico correctly reflects pause/resume transitions (#79)
- **Command message handling** — support for `commands[]` message format for pause/resume/cancel control (#79)

### Fixed

- Resume command not forwarded correctly when printer was in paused state
- `current_print_ts` changed on every status poll causing Obico to treat each poll as a new print
- `commands[]` array format not handled in Obico agent command dispatcher

---

## [1.0.0] - 2026-04-07

First production-ready release. Covers Milestone 1 (Working Bridge) and Milestone 2 (Production-Ready).

### Milestone 2: Production-Ready (Phases 5–11)

#### Added

- **Dashboard Health UI** — three-component health card (PrusaLink / Obico / Camera) with colored status badges, inline Reconnect buttons, and 15s auto-refresh with Page Visibility pause/resume (#41)
- **Graceful shutdown** — ordered SIGTERM/SIGINT handler: HTTP server → Obico WS (close 1001) → ffmpeg (SIGINT + 3s SIGKILL fallback) → `process.exit(0)` with 8s hard timeout
- **Config hot-reload** — saving new credentials via the dashboard reconnects affected subsystems within 5s; no container restart required
- **Pairing timeout** — `waitForPairing()` exits with an error after 120s instead of looping forever
- **Circuit breaker registry** — `obico_ws` and `camera` circuit breakers registered; dashboard Reconnect resets CB state
- **`config/config.example.json`** — complete example matching the Config schema including the `polling` block
- **`docker-compose.yml`** — ready-to-use Compose file in the repo root
- **EXPOSE 10100-10200/udp** — Dockerfile documents the Janus WebRTC RTP port range

#### Fixed

- Crash in PrusaLink client when `body.file` is null on prints without a file attached (#66)
- `testStream()` hangs indefinitely on stalled RTSP connections — bounded by configurable timeout (#67)
- `setInterval` handle leaked on config reload — now cleared correctly
- README Node.js prerequisite corrected from 20+ to 22+

#### Changed

- Docker base image migrated to `node:22-alpine`
- `StatusCard` and `ResilienceCard` replaced by unified `HealthCard` component
- README fully rewritten: Quick Start, Docker Compose, full config reference, Known Limitations, Troubleshooting, Building from Source (#57, #58, #59)

---

### Milestone 1: Working Bridge (Phases 1–4)

#### Added

- **Config module** — `loadConfig()` / `saveConfig()` / `isConfigured()` with JSON persistence on mounted volume
- **PrusaLink client** — HTTP Digest Auth, polls `/api/v1/status` + `/api/v1/job`, pause/resume/cancel
- **Camera module** — RTSP via ffmpeg (`rtsp://[printer-ip]/live`), JPEG frame emission at configurable interval
- **Janus WebRTC relay** — live RTSP stream proxied to Obico control panel via Janus Gateway
- **Obico agent** — WebSocket connection, pairing flow, status + frame forwarding, control command dispatch
- **Resilience layer** — circuit breaker, retry with exponential backoff, health monitor, WebSocket auto-reconnect
- **Health endpoints** — `GET /api/health`, `/api/health/live`, `/api/health/ready`
- **4-step setup wizard** — PrusaLink → Camera → Obico pairing → Done
- **Dashboard** — printer status, job progress, print controls
- **Docker image** — single image with ffmpeg, multi-platform build (amd64 + arm64), Docker Hub CI/CD via GitHub Actions
- 128 backend unit tests

---

## [Unreleased]

### Planned — Milestone 3

- Print passthru — start print from Obico UI (#47)
- G-code file browser — PrusaLink files in Obico UI (#48)
