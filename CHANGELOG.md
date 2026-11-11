# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The bridge, Janus and ffmpeg run as the unprivileged `node` user (uid 1000). On start the container hands `/config`, `config.json` and `print-state.json` to that user (not recursively) and keeps `config.json` at mode `0600`, so existing installs migrate without manual steps. If ownership cannot be changed (NFS root_squash, rootless Docker), it keeps running as root and logs a warning. (#98)
- Requests with an unknown `Host` header are rejected (403). **BREAKING:** access through a DNS name containing a dot (reverse proxy, Tailscale MagicDNS, `*.fritz.box`) requires the name in the new `ALLOWED_HOSTS` environment variable; IP addresses, `localhost`, single-label and `*.local` names keep working. (#93)
- Cross-site write requests (`POST`/`PUT`/`DELETE` whose `Origin` does not match `Host`) are rejected (403); a reverse proxy must pass the original `Host` header through. (#93)
- `GET /api/config` no longer returns RTSP credentials or characters of stored secrets. (#91)
- Camera URLs must use `rtsp://` or `rtsps://`. (#91)
- `config.json` is written with mode `0600`. (#91)
- The bundled Janus WebSocket listens on loopback only; the default Janus admin secret was removed. (#91)
- Obico messages are logged by key only, not with their content. (#91)

### Changed

- **BREAKING: published ports are bound to the host LAN IP.** `docker-compose.yml`, the README, and the docs now publish the web port and the Janus UDP range as `${JANUS_HOST_IP}:<port>` instead of on all interfaces. `JANUS_HOST_IP` is now required: `docker compose up` fails with an error if it is unset or empty, and `docker run` examples use `-p <LAN-IP>:3000:3000`. Existing setups must set `JANUS_HOST_IP` (e.g. in `.env`) before upgrading their compose file, and open the UI at `http://<JANUS_HOST_IP>:3000` instead of `http://localhost:3000`. (#90)
- Docker image builds use `npm ci`; GitHub Actions are pinned to commit SHAs and updated by Dependabot. (#92)

### Added

- `SECURITY.md` with the supported deployment (private LAN or VPN), trust assumptions, and how to report vulnerabilities (#90)
- Warning that the bridge has no authentication in the README, quickstart, and Docker Compose guide, and a startup log line stating it (#90)
- Note that Docker-published ports bypass host firewalls such as `ufw` (#90)

### Fixed

- README no longer claims the bridge offers no file upload (`POST /api/files/upload`) (#90)
- RTSP passwords containing `/`, spaces or `@`, or split across ffmpeg output chunks, no longer leak into logs (#62)
- Frame uploads to Obico time out after 15 s, include the server's response in the error, and report persistent failures to the health view (#62)
- The bundled Janus logs a warning when it finds no config directory (#62)
- README states the ffmpeg 5+ requirement for source builds (#62)
- PrusaLink READY ("ready to print") is reported to Obico as idle, and UNKNOWN no longer ends the current print (#64)

### Planned — Milestone 3

- Print passthru — start print from Obico UI (#47)
- G-code file browser — PrusaLink files in Obico UI (#48)

---

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
