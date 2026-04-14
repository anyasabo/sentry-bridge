# Configuration Reference

SentryBridge has two configuration surfaces: **environment variables** (set at container start) and **config.json** (written by the Setup Wizard, stored on the mounted volume).

---

## Environment Variables

Set these in your `.env` file (Docker Compose) or with `-e` flags (`docker run`). All variables are optional unless marked **Required**.

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | Optional | HTTP port for the Web UI and REST API |
| `CONFIG_PATH` | `/config/config.json` | Optional | Path to the config file inside the container. Change only if you mount the volume at a non-standard path. |
| `JANUS_HOST_IP` | _(unset)_ | **Required for WebRTC** | LAN IP of the Docker host. Janus advertises this as its ICE candidate so browsers can reach the WebRTC live stream. Without this, the live stream in Obico falls back to MJPEG snapshots. |
| `JANUS_MODE` | `auto` | Optional | How Janus is managed. `bundled` — SentryBridge spawns and manages the Janus binary included in the image. `hosted` — Janus runs as an external sidecar (development use). `auto` — detect a running Janus on `ws://127.0.0.1:8188`, then fall back to `bundled`. |
| `JANUS_DEBUG_LEVEL` | `2` | Optional | Janus log verbosity. `0`=Fatal, `1`=Error, `2`=Warn, `3`=Info, `4`=Verbose, `5`=Huge. Increase to `3` or `4` when debugging WebRTC issues. |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Optional | Number of consecutive failures before a circuit breaker opens for a component (PrusaLink, Obico WS, Camera). |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `60000` | Optional | Time in milliseconds to wait before retrying a component after its circuit breaker opens. Default: 60 seconds. |
| `RETRY_BASE_DELAY_MS` | `1000` | Optional | Initial delay in milliseconds for exponential backoff retries. |
| `RETRY_MAX_DELAY_MS` | `30000` | Optional | Maximum delay cap in milliseconds for exponential backoff retries. |
| `HEALTHCHECK_CRITICAL_TIMEOUT_MS` | `120000` | Optional | How long in milliseconds a critical component can remain DOWN before `/api/health/ready` returns `503`. Default: 120 seconds. |

### Setting variables with Docker Compose

Create a `.env` file next to `docker-compose.yml`:

```bash
JANUS_HOST_IP=192.168.1.42
# Optional overrides:
# JANUS_DEBUG_LEVEL=3
# CIRCUIT_BREAKER_THRESHOLD=10
```

Docker Compose automatically picks up `.env`. The `docker-compose.yml` passes these to the container via `${VARIABLE:-default}` syntax.

---

## config.json

The Setup Wizard writes `/config/config.json` on the mounted volume after you complete step 4. You can also create or edit this file manually — SentryBridge hot-reloads it when the file changes (the bridge restarts automatically; no container restart required).

Default location: `./config/config.json` (relative to the Docker Compose directory, mounted as `/config/config.json` inside the container).

### Full schema with all fields

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

### Field reference

#### `prusalink`

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Base URL of the PrusaLink HTTP API. Must not have a trailing slash. Example: `http://192.168.1.100` |
| `username` | string | PrusaLink username. Default is `maker` for most Prusa printers. |
| `password` | string | PrusaLink password. Found in `Settings → Network → API Key / User Password` on the printer. |

SentryBridge uses HTTP Digest Authentication for all PrusaLink requests — your password is never sent in plain text.

#### `camera`

| Field | Type | Description |
|-------|------|-------------|
| `rtspUrl` | string | RTSP endpoint for the printer camera. For Prusa printers with the Buddy3D camera board: `rtsp://[printer-ip]/live`. The stream is unauthenticated and LAN-only. |
| `frameIntervalSeconds` | number | How often SentryBridge captures a JPEG snapshot and forwards it to Obico for AI failure detection. Default: `10` (every 10 seconds). Lower values increase CPU usage. |

#### `obico`

| Field | Type | Description |
|-------|------|-------------|
| `serverUrl` | string | Your Obico server URL. Use `https://app.obico.io` for the Obico cloud, or your self-hosted instance URL. No trailing slash. |
| `apiKey` | string | Pairing token assigned by Obico during the Setup Wizard pairing step. This field is empty until the wizard completes step 3. Do not set this manually — use the wizard. |

#### `polling`

| Field | Type | Description |
|-------|------|-------------|
| `statusIntervalMs` | number | How often SentryBridge polls PrusaLink for printer status and job data, in milliseconds. Default: `5000` (every 5 seconds). Reduce to `2000` for faster status updates; increase to `10000` to reduce printer API load. |

---

## Config hot-reload

When `config.json` is modified (by the wizard, by a manual edit, or by an external tool), SentryBridge detects the change and restarts the bridge components automatically. The container does not restart — only the internal bridge (PrusaLink client, camera, Obico agent) tears down and reinitialises with the new config.

You will see a log entry:

```
[config] Config file changed — restarting bridge
```
