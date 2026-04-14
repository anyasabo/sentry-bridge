# Chapter 8: Cross-Cutting Concepts

## 8.1 Resilience

### Circuit Breaker Pattern

All three external components (PrusaLink, Obico WebSocket, Camera) are protected by a **Circuit Breaker** registered in `CircuitBreakerRegistry` (`src/lib/health.ts`).

| Parameter | Default | Environment Variable |
|-----------|---------|---------------------|
| Failure threshold | 5 | `CIRCUIT_BREAKER_THRESHOLD` |
| Reset timeout | 60 000 ms | `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` |

**States:**
- **CLOSED** — normal operation; requests pass through.
- **OPEN** — after `threshold` consecutive failures; requests are rejected immediately with `CircuitOpenError`. No traffic reaches the failing component.
- **HALF-OPEN** — after `resetTimeout` ms; one probe request is sent. If successful, transitions to CLOSED. If it fails, transitions back to OPEN.

**Circuit Breaker keys:** `"prusalink"`, `"obico_ws"`, `"camera"`.

### Retry with Exponential Backoff

Transient errors (network glitches, timeouts) are retried using `src/lib/retry.ts`:

| Parameter | Default | Environment Variable |
|-----------|---------|---------------------|
| Base delay | 1 000 ms | `RETRY_BASE_DELAY_MS` |
| Max delay | 30 000 ms | `RETRY_MAX_DELAY_MS` |

Backoff formula: `min(baseDelay * 2^attempt, maxDelay)` with jitter.

### Obico WebSocket Reconnect

The Obico Agent reconnects automatically on WebSocket disconnect using exponential backoff (same parameters as retry). Reconnection attempts are unlimited — the bridge recovers when the network recovers.

### Health Monitor

`HealthMonitor` (`src/lib/health-monitor.ts`) tracks component state (`HEALTHY`, `DEGRADED`, `DOWN`) and exposes it via:
- `GET /api/health/` — detailed per-component status (dashboard use)
- `GET /api/health/live` — liveness probe (Docker HEALTHCHECK)
- `GET /api/health/ready` — readiness probe; returns 503 when any critical component has been DOWN for > `HEALTHCHECK_CRITICAL_TIMEOUT_MS` (default 120 s)

---

## 8.2 Configuration Management

### Config-on-Volume

All runtime configuration is stored in a single JSON file at `/config/config.json` on a Docker volume. No database, no external state store.

**Config schema:**

```json
{
  "name": "optional printer display name",
  "prusalink": { "url": "http://...", "username": "maker", "password": "..." },
  "camera": { "rtspUrl": "rtsp://[ip]/live", "frameIntervalSeconds": 2 },
  "obico": { "serverUrl": "https://...", "apiKey": "20-char-hex" },
  "polling": { "statusIntervalMs": 5000 },
  "shutdown": { "ffmpegKillTimeoutSeconds": 3 }
}
```

### Hot-Reload

Config changes (saved via the dashboard) trigger a `configChanged` event via `configEmitter` (Node.js `EventEmitter`). The Bridge Orchestrator listens for this event, tears down all active connections, and reinitialises with the new configuration — without requiring a container restart.

---

## 8.3 Error Handling

### Boundary Validation

Input validation occurs at system boundaries:
- Wizard API routes validate required fields before forwarding to internal modules.
- `POST /api/setup/save` validates all required config fields (prusalink URL/credentials, camera RTSP URL, Obico server URL + API key).
- `POST /api/control` validates the `action` field against an allowlist `["pause", "resume", "cancel"]`.

### Security Guards (http.tunnel)

The `http.tunnelv2` Obico passthru handler enforces:
- **Path guard**: only `/api/*` paths are proxied — prevents use as a general HTTP proxy (EoP mitigation).
- **Method guard**: only `GET`, `POST`, `PUT`, `DELETE` are allowed.
- **SSRF mitigation**: `file_downloader.download` only accepts URLs whose origin matches the configured Obico server URL.

### Error Responses

All API routes return `{ message: string }` on errors. HTTP status codes follow REST conventions:
- `400` — validation failure (missing/invalid input)
- `401` — PrusaLink authentication failure
- `404` — config not found
- `502` — upstream (PrusaLink/Obico) connection failure
- `503` — bridge critical health check failure
- `504` — pairing timeout (120 s deadline exceeded)

---

## 8.4 Logging

SentryBridge uses `console.log` / `console.error` with structured prefixes:

| Prefix | Module |
|--------|--------|
| `[bridge]` | Bridge Orchestrator |
| `[prusalink]` | PrusaLink Client |
| `[camera]` | Camera Module |
| `[obico]` | Obico Agent |
| `[janus]` | Janus Manager / Relay |
| `[health]` | Health Monitor |

All output goes to stdout/stderr and is available via `docker logs`. No log rotation or structured JSON logging in the current version.

---

## 8.5 Graceful Shutdown

On `SIGTERM` (Docker `docker stop`), the SIGTERM handler in `src/index.ts`:
1. Calls `stopBridge()` — stops the poll interval, closes the Obico WebSocket, kills the ffmpeg process (with a configurable `ffmpegKillTimeoutSeconds`, default 3 s).
2. Closes the Express HTTP server.
3. Falls back to `process.exit(0)` after an 8-second hard timeout (`.unref()` so Jest tests are not blocked).

`stop_grace_period: 30s` in Docker Compose gives the container 30 seconds before Docker sends `SIGKILL`.

---

## 8.6 Internationalisation

The React frontend supports **English** (default) and **German** via `i18next`. The backend is English-only. Translation files live in `frontend/src/i18n/`.
