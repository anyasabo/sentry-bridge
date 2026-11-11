# REST API Guide

SentryBridge exposes a REST API consumed by the React web UI and by Obico's `http.tunnelv2` passthru handler. You can also use it directly for scripting, monitoring, or integration.

For the complete authoritative endpoint specification, see → [`docs/requirements/api.yaml`](../../requirements/api.yaml) (OpenAPI 3.0).

The API has no authentication: SentryBridge is built for the LAN. Anyone who can reach port 3000 can call every endpoint, so do not expose it to the internet or untrusted networks.

This guide covers the most useful endpoints with practical curl examples.

---

## Base URL

All examples assume SentryBridge is running on the default port:

```
http://localhost:3000
```

Replace `localhost:3000` with your host and port if you changed the `PORT` variable.

---

## Health checks

### Is the container alive?

```bash
curl http://localhost:3000/api/health/live
```

Returns `200 {"status":"ok"}` as long as the Node.js process is running. Use this as a liveness probe.

### Is the bridge ready to serve traffic?

```bash
curl -w "\nHTTP %{http_code}\n" http://localhost:3000/api/health/ready
```

Returns `200` when all components are operational. Returns `503` when a critical component (PrusaLink, Camera, or Obico WS) has been DOWN for longer than `HEALTHCHECK_CRITICAL_TIMEOUT_MS` (default: 120 seconds).

### Detailed per-component health

```bash
curl http://localhost:3000/api/health/ | jq .
```

Returns per-component status, circuit breaker state, and failure counts. Useful for diagnosing which component is failing.

Example response fragment:

```json
{
  "status": "degraded",
  "components": {
    "prusalink": { "status": "UP", "circuitBreaker": "CLOSED" },
    "camera": { "status": "DOWN", "circuitBreaker": "OPEN", "failures": 5 },
    "obico_ws": { "status": "UP", "circuitBreaker": "CLOSED" }
  }
}
```

---

## Printer status

### Get current printer and job status

```bash
curl http://localhost:3000/api/status | jq .
```

Returns the latest polled state from PrusaLink: printer state (IDLE, PRINTING, PAUSED, FINISHED), temperatures, and current job progress if a print is active.

---

## Printer control

All control endpoints are fire-and-forget — they return `200` when the command is sent to PrusaLink, not when the printer acknowledges it.

### Pause a print

```bash
curl -X POST http://localhost:3000/api/bridge/pause
```

### Resume a paused print

```bash
curl -X POST http://localhost:3000/api/bridge/resume
```

### Cancel a print

```bash
curl -X POST http://localhost:3000/api/bridge/cancel
```

---

## Configuration

### Get the current config

```bash
curl http://localhost:3000/api/config | jq .
```

Returns the current `config.json` contents without secrets. The PrusaLink password and the Obico API key are replaced by `prusalink.passwordHint` and `obico.apiKeyHint`: `***` plus the last 3 characters when the secret has at least 8 characters, otherwise `***`.

When saving via `POST /api/setup/save`, an empty or missing `prusalink.password` / `obico.apiKey` keeps the stored value; a filled one replaces it. The stored value is only kept for the same target: the password only if `prusalink.url` and `prusalink.username` are unchanged, the API key only if `obico.serverUrl` is unchanged. Otherwise the request fails with `400` and a message that a password (or a new pairing) is required. `POST /api/wizard/test-prusalink` applies the same rule to its empty password.

`POST /api/wizard/verify-pairing` takes the setup (`prusalink`, `camera`, optional `name`/`polling`) plus `obicoServerUrl` and `code`, pairs with Obico and saves the config with the new API key. The response is `{ "ok": true, "serverUrl": "..." }` and never contains the key.

### Update the config

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{"polling": {"statusIntervalMs": 3000}}'
```

Merges the provided object into the current config and saves it. SentryBridge hot-reloads automatically — no restart needed.

---

## G-code file management

SentryBridge exposes OctoPrint-compatible file endpoints that Obico uses for its file browser integration. You can also use them directly.

### List files on the printer

```bash
curl http://localhost:3000/api/files/local | jq .
```

### Upload a G-code file

```bash
curl -X POST http://localhost:3000/api/files/local \
  -F "file=@/path/to/your/print.gcode"
```

Maximum upload size: 200 MB.

### Start a print

```bash
curl -X POST http://localhost:3000/api/files/local/print.gcode/print
```

Replace `print.gcode` with the filename (8.3 format as returned by PrusaLink).

### Delete a file

```bash
curl -X DELETE http://localhost:3000/api/files/local/print.gcode
```

---

## Full specification

The examples above cover the most common operations. For every endpoint, request schema, and response schema, see the OpenAPI specification:

→ [`docs/requirements/api.yaml`](../../requirements/api.yaml)

You can render it locally with any OpenAPI viewer, or paste it into [editor.swagger.io](https://editor.swagger.io).
