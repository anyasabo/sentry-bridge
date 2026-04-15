# SentryBridge

[![CI](https://img.shields.io/github/actions/workflow/status/reneleban/sentry-bridge/ci.yml?branch=main&label=CI)](https://github.com/reneleban/sentry-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Docker Image Version](https://img.shields.io/docker/v/rleban/sentry-bridge?label=Docker)](https://hub.docker.com/r/rleban/sentry-bridge)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-green.svg)](https://nodejs.org)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/reneleban/sentry-bridge?utm_source=oss&utm_medium=github&utm_campaign=reneleban%2Fsentry-bridge&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

Standalone Docker service that connects Prusa Core One printers (via PrusaLink) to Obico (self-hosted or cloud). Runs as an Obico agent — no modifications to Obico or PrusaLink required. One container = one printer.

- Setup wizard: PrusaLink credentials → camera test → Obico pairing
- Live status forwarding (temperatures, job progress, state)
- MJPEG snapshot upload for AI failure detection
- WebRTC live stream via Janus in the Obico control panel
- Pause / resume / cancel from Obico

## What it does

The bridge acts as a translator between your Prusa Core One printer and Obico. It polls the printer's PrusaLink HTTP API for status and job data, captures the RTSP camera stream via ffmpeg, and forwards everything to Obico over WebSocket. The Obico control panel then shows your printer's state, lets you watch the live stream, and can pause or cancel a print if the AI detects a failure.

## Requirements

- Docker (20.10+) with Docker Compose v2
- A Prusa Core One with PrusaLink enabled and reachable on your LAN
- PrusaLink credentials (username + password from the printer's network settings)
- RTSP camera stream from the printer (`rtsp://[printer-ip]/live`) — **mandatory**, Obico requires a live stream for AI failure detection
- An Obico account (self-hosted or https://app.obico.io)
- The Docker host's LAN IP (needed for WebRTC — see `JANUS_HOST_IP` below)

## Quick Start

Pull the image and run it with your Docker host's LAN IP:

```bash
docker run -d \
  -p 3000:3000 \
  -p 10100-10200:10100-10200/udp \
  -v ./config:/config \
  -e JANUS_HOST_IP=192.168.1.x \
  rleban/sentry-bridge:latest
```

```bash
# Open http://localhost:3000 → follow setup wizard
```

Replace `192.168.1.x` with the LAN IP of the machine running Docker. Without this, the WebRTC live stream will not work.

For the full guide → [docs/guide/](docs/guide/)

## Docker Compose

For persistent setups, use the included `docker-compose.yml` at the repo root, or copy this block:

```yaml
services:
  bridge:
    image: rleban/sentry-bridge:latest
    container_name: prubico_bridge
    ports:
      - "3000:3000"
      - "10100-10200:10100-10200/udp" # WebRTC ICE media (browser ↔ Janus)
    volumes:
      - ./config:/config
    environment:
      - PORT=3000
      - CONFIG_PATH=/config/config.json
      - JANUS_MODE=bundled
      - JANUS_DEBUG_LEVEL=2
      - JANUS_HOST_IP=${JANUS_HOST_IP:-}
      - CIRCUIT_BREAKER_THRESHOLD=5
      - CIRCUIT_BREAKER_RESET_TIMEOUT_MS=60000
      - RETRY_BASE_DELAY_MS=1000
      - RETRY_MAX_DELAY_MS=30000
      - HEALTHCHECK_CRITICAL_TIMEOUT_MS=120000
    healthcheck:
      test:
        [
          "CMD-SHELL",
          'node -e "fetch(''http://localhost:3000/api/health/live'').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
    restart: unless-stopped
    stop_grace_period: 30s
```

```bash
docker compose up -d
# Open http://localhost:3000 → follow setup wizard
```

The repo includes a ready-to-use [`docker-compose.yml`](./docker-compose.yml) — just clone and run.

## Configuration

### Environment Variables

| Variable                           | Default               | Required / Optional       | Description                                                                                                                                                     |
| ---------------------------------- | --------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | `3000`                | Optional                  | HTTP port                                                                                                                                                       |
| `CONFIG_PATH`                      | `/config/config.json` | Optional                  | Config file path                                                                                                                                                |
| `JANUS_HOST_IP`                    | _(unset)_             | **Required** (for WebRTC) | LAN IP of the Docker host. Janus advertises this as its ICE candidate so the browser can reach it. Without this, the live stream falls back to MJPEG snapshots. |
| `JANUS_MODE`                       | `auto`                | Optional                  | `bundled` — bridge manages Janus binary; `hosted` — external/sidecar; `auto` — detect                                                                           |
| `JANUS_DEBUG_LEVEL`                | `2`                   | Optional                  | Janus log verbosity: 0=Fatal 1=Err 2=Warn 3=Info 4=Verbose 5=Huge                                                                                               |
| `CIRCUIT_BREAKER_THRESHOLD`        | `5`                   | Optional                  | Consecutive PrusaLink failures before circuit opens                                                                                                             |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `60000`               | Optional                  | Time (ms) before retrying after circuit opens                                                                                                                   |
| `RETRY_BASE_DELAY_MS`              | `1000`                | Optional                  | Initial retry delay (ms)                                                                                                                                        |
| `RETRY_MAX_DELAY_MS`               | `30000`               | Optional                  | Maximum retry delay (ms)                                                                                                                                        |
| `HEALTHCHECK_CRITICAL_TIMEOUT_MS`  | `120000`              | Optional                  | Time (ms) a critical component can stay DOWN before `/api/health/ready` returns 503                                                                             |

### config.json

The wizard writes `/config/config.json` on the mounted volume. All fields can also be set manually:

```json
{
  "prusalink": {
    "url": "http://192.168.1.x",
    "username": "maker",
    "password": "your-prusalink-password"
  },
  "camera": {
    "rtspUrl": "rtsp://192.168.1.x/live",
    "frameIntervalSeconds": 10
  },
  "obico": {
    "serverUrl": "https://app.obico.io",
    "apiKey": ""
  },
  "polling": {
    "statusIntervalMs": 5000
  }
}
```

- `prusalink` — printer URL, username, and password for HTTP Digest Auth access to PrusaLink
- `camera` — RTSP stream URL and snapshot interval in seconds
- `obico` — server URL and pairing token (`apiKey` is empty until the wizard completes pairing)
- `polling` — polling interval in milliseconds (default: 5000)

## Setup Wizard

On first start the bridge serves a 4-step wizard at `http://localhost:3000`:

1. **PrusaLink** — enter printer URL (e.g. `http://192.168.x.x`), username (`maker`), and password. The wizard performs a live connection test before continuing.
2. **Camera** — the wizard probes `rtsp://[printer-ip]/live` and shows a preview frame. This step is **mandatory** — it blocks until a frame is received.
3. **Obico Pairing** — enter your Obico server URL (`https://app.obico.io` or your self-hosted instance). The wizard displays a 6-digit pairing code. Confirm it in Obico's "Link Printer" dialog.
4. **Done** — redirect to the dashboard. The bridge starts forwarding status and frames.

## Known Limitations

These are intentional product decisions, not bugs:

- **One container = one printer.** Simplifies config, isolation, and restarts. Run multiple containers on different ports for multiple printers.
- **RTSP camera is mandatory.** Obico's AI failure detection requires a live stream — there is no "disable camera" mode.
- **Manual printer controls are limited to pause / resume / cancel.** The PrusaLink API does not expose file upload, filament load/unload, or print queue management, so the bridge does not either.

## Troubleshooting

### 1. PrusaLink auth fails (401)

- Symptom: Wizard step 1 fails with 401 Unauthorized
- Check URL has no trailing slash: `http://<printer-ip>` not `http://<printer-ip>/`
- Verify credentials in PrusaLink: Settings → Network → API Key / User Password
- Test from host: `curl -u <username>:<password> --digest http://<printer-ip>/api/v1/status`

### 2. Camera RTSP unreachable

- Symptom: Wizard step 2 blocks, no frame preview
- Confirm printer has a camera (Buddy3D board) and RTSP is enabled
- Test from host: `ffmpeg -rtsp_transport tcp -i rtsp://<printer-ip>/live -frames:v 1 -f image2 test.jpg`
- Check LAN: printer and Docker host on the same subnet, no VLAN isolation

### 3. Obico pairing never confirms

- Symptom: Wizard step 3 shows pairing code but Obico never confirms
- Verify the server URL (`https://app.obico.io` or your self-hosted URL) — no trailing slash
- Check firewall between bridge and Obico server (WebSocket on 443/80)
- Container logs: `docker logs <container> | grep obico`

### 4. WebRTC live stream is black in Obico

- Symptom: Obico control panel loads but video is black / spinning
- `JANUS_HOST_IP` must be set to the **Docker host's LAN IP**, not `127.0.0.1` or `0.0.0.0`
- Confirm UDP ports `10100-10200` are published and reachable from the browser
- Test: `docker exec <container> env | grep JANUS_HOST_IP`
- Restart after change: `docker compose up -d --force-recreate`

## Building from Source

For local development or custom builds:

### Prerequisites

- Node.js 22+
- ffmpeg
- Docker Desktop (for Janus sidecar on Mac)

### Setup

```bash
git clone https://github.com/reneleban/sentry-bridge.git
cd sentry-bridge
npm run install:all
```

### Run (dev)

```bash
npm run dev:all          # backend (ts-node watch) + frontend (Vite)
```

Frontend proxies `/api/*` to the backend automatically.

### Janus WebRTC sidecar (Mac / dev only)

On Mac, Janus cannot be installed natively. Run it as a Docker sidecar:

```bash
docker compose -f docker-compose.dev.yml up -d
```

This starts Janus with:

- WS on port `8188` (bridge relay)
- RTP input on port `17732/udp` (from ffmpeg)
- ICE media on ports `10100–10200/udp` (WebRTC)

For WebRTC to work during local development, set `nat_1_1_mapping` in `config/janus/janus.jcfg` to your Mac's LAN IP (e.g. `192.168.1.x`). This tells Janus which IP to advertise for ICE so the browser can reach it.

The bridge auto-detects a running Janus on `ws://127.0.0.1:8188` before looking for a local binary.

In production (Docker image), Janus runs natively inside the container — set `JANUS_HOST_IP` in the environment instead of editing the config file directly.

### Test

```bash
npm run test:backend
```

### Build

```bash
npm run build:all           # TypeScript + Vite → dist/ + frontend/dist/
npm run build:docker        # Docker image (single platform)
```

## Architecture

```
Prusa Core One
  ├── PrusaLink HTTP  →  Bridge (status poll, pause/resume/cancel)
  └── RTSP /live      →  ffmpeg → H.264 RTP → Janus (WebRTC)
                                                   ↕ WS relay
Browser  ←  Obico Server  ←  /ws/janus/{id}/  ←  Bridge
```

- **Config module** — reads/writes JSON from mounted volume
- **PrusaLink client** — HTTP Digest Auth, polls status + job
- **Camera module** — RTSP → JPEG frames (MJPEG) + H.264 RTP (WebRTC)
- **Janus manager** — spawns/detects Janus WebRTC gateway
- **Janus relay** — bidirectional WS relay: local Janus ↔ Obico
- **Obico agent** — WebSocket to Obico, pairing flow, status + frame forwarding
