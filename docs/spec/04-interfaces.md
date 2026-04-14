# 04: Interface Documentation

**Document ID:** SPEC-04  
**Standard:** ISO/IEC 29148

This document describes the three interface categories relevant to SentryBridge:

1. **[PrusaLink HTTP API](#1-prusalink-http-api)** — the upstream printer interface (consumed by SentryBridge)
2. **[Obico WebSocket Protocol](#2-obico-websocket-protocol)** — the upstream Obico interface (consumed and produced by SentryBridge)
3. **[SentryBridge REST API](#3-sentrybridge-rest-api)** — the own API (produced by SentryBridge, consumed by the web UI)

---

## 1. PrusaLink HTTP API

PrusaLink is the embedded HTTP API on Prusa printers with Buddy board firmware (Core One, MK4S, MK3.9).

**Base URL:** `http://[printer-ip]` (LAN only)  
**Authentication:** HTTP Digest Auth — username `maker`, password shown on printer display  
**Protocol:** HTTP/1.1

### Endpoints Used by SentryBridge

| Method | Path | Purpose | Response |
|--------|------|---------|---------|
| GET | `/api/v1/status` | Printer telemetry (state, temperatures, axes, speeds) | 200 JSON |
| GET | `/api/v1/job` | Active job info | 200 JSON (printing) / 204 (idle) |
| GET | `/api/v1/info` | Printer identity (hostname, serial, nozzle) | 200 JSON |
| PUT | `/api/v1/job/{id}/pause` | Pause active print | 204 |
| PUT | `/api/v1/job/{id}/resume` | Resume paused print | 204 |
| DELETE | `/api/v1/job/{id}` | Cancel and delete active print | 204 |
| GET | `/api/v1/files` | List files on USB storage | 200 JSON |
| POST | `/api/v1/files` | Upload G-code file (multipart) | 201 |
| POST | `/api/v1/files/{path}/print` | Start printing a file | 204 |
| DELETE | `/api/v1/files/{path}` | Delete a file | 204 |

### Status Response Schema

```json
{
  "printer": {
    "state": "IDLE | BUSY | PRINTING | PAUSED | FINISHED | STOPPED | ERROR | ATTENTION",
    "temp_bed": 25.2,
    "target_bed": 0.0,
    "temp_nozzle": 26.5,
    "target_nozzle": 0.0,
    "axis_z": 0.0,
    "flow": 100,
    "speed": 100
  },
  "storage": {
    "path": "/usb/",
    "name": "usb",
    "read_only": false
  }
}
```

### Job Response Schema (200 when printing)

```json
{
  "id": 420,
  "state": "PRINTING | PAUSED | FINISHED | STOPPED | ERROR",
  "progress": 42.5,
  "time_printing": 1800,
  "time_remaining": 2400,
  "file": {
    "name": "benchy.gcode",
    "display_name": "benchy_0.2mm_PETG.gcode",
    "path": "/usb/",
    "size": 1048576
  }
}
```

**Note:** `GET /api/v1/job` returns `204 No Content` when the printer is idle — this is not an error.

### Error Codes

| Code | Meaning |
|------|---------|
| 401 | Authentication failed |
| 404 | Job or file not found |
| 409 | Invalid state transition (e.g., pause when already paused) |

---

## 2. Obico WebSocket Protocol

SentryBridge connects to Obico as a `moonraker_obico` agent (ADR-002).

**WebSocket Endpoint:** `wss://{obico_server_url}/ws/dev/`  
**Authentication:** HTTP header during WebSocket upgrade: `authorization: bearer {auth_token}`  
**Auth Token:** 20-character hex string obtained via pairing flow, stored in `config.json`

### 2.1 Pairing Flow (HTTP)

Pairing uses HTTP, not WebSocket.

**Step 1 — Request pairing code** (done server-side by user entering code in Obico UI):

The bridge displays the 5-character code from Obico's web interface. The user enters it in the Obico pairing UI.

**Step 2 — Verify code and obtain API key:**

```
POST {obicoServerUrl}/api/v1/octo/verify/?code={5-char-code}
Body: (empty)

Response 200:
{
  "printer": {
    "auth_token": "a3f8c2d1e4b5f6a7c8d9e0f1",
    "id": 42,
    "name": "My Printer"
  }
}
```

The `auth_token` (nested under `printer.auth_token`) is stored as `apiKey` in `config.json` and used for all subsequent WebSocket connections.

**Pairing timeout:** 120 s from when the bridge starts polling for verification.

### 2.2 Outbound Messages (Bridge → Obico)

#### Printer Info (sent on connect)

```json
{
  "printer_info": {
    "sw_version": "2.1.0",
    "fw_version": "unknown",
    "hostname": "[printer-hostname]",
    "type": "moonraker_obico"
  }
}
```

#### Printer Status Update (every 30 s, and on state change)

```json
{
  "current_print_ts": 1712000000,
  "status": {
    "_ts": 1712000000,
    "state": {
      "text": "Printing | Paused | Operational | Offline",
      "flags": {
        "operational": true,
        "paused": false,
        "printing": true,
        "error": false,
        "ready": false
      },
      "error": null
    },
    "job": {
      "file": {
        "name": "benchy.gcode",
        "path": "/usb/benchy.gcode",
        "obico_g_code_file_id": null
      }
    },
    "progress": {
      "completion": 42.5,
      "filepos": null,
      "printTime": 1800,
      "printTimeLeft": 2400,
      "filamentUsed": null
    },
    "temperatures": {
      "tool0": { "actual": 215.2, "target": 215.0 },
      "bed": { "actual": 60.1, "target": 60.0 }
    }
  },
  "event": {
    "event_type": "PrintStarted"
  }
}
```

**Notes:**
- `current_print_ts`: Unix timestamp if printing, `null` if idle.
- `event` field is optional — only present on state transitions.
- Status is also POSTed to `{obicoServerUrl}/api/v1/octo/ping/` as HTTP fallback.

#### Camera Frame Upload (HTTP POST, not WebSocket)

```
POST {obicoServerUrl}/api/v1/octo/pic/
Content-Type: multipart/form-data

Fields:
  img:            <base64-encoded JPEG>
  name:           "camera"
  cam_name:       "camera"
  is_primary_cam: "true"
```

**Frequency:** Every `frameIntervalSeconds` (default: 2 s).  
**Max frame size:** 7 MB.  
**Format:** JPEG, base64-encoded.

#### Passthru ACK (ref-matched response to control command)

```json
{
  "passthru": {
    "ref": "unique-ref-string",
    "ret": null
  }
}
```

### 2.3 Inbound Messages (Obico → Bridge)

#### Passthru Command

```json
{
  "passthru": {
    "ref": "unique-ref-string",
    "target": "Printer",
    "func": "pause | resume | cancel | start_printer_local_print | file_downloader.download",
    "args": [],
    "kwargs": {}
  }
}
```

| `func` | `kwargs` | Action |
|--------|---------|--------|
| `pause` | — | `PUT /api/v1/job/{id}/pause` |
| `resume` | — | `PUT /api/v1/job/{id}/resume` |
| `cancel` | — | `DELETE /api/v1/job/{id}` |
| `start_printer_local_print` | `{ gcode_file_id }` | Start printing file by Obico file ID |
| `file_downloader.download` | `{ url }` | Download G-code from Obico, upload to PrusaLink, start print |

#### http.tunnelv2 Request

```json
{
  "http.tunnelv2": {
    "ref": "unique-ref-string",
    "method": "GET | POST | PUT | DELETE",
    "path": "/api/files/",
    "headers": {},
    "body": null
  }
}
```

Bridge proxies the request to its own Express API (`http://localhost:{PORT}{path}`) and returns the response. Only `/api/*` paths are allowed (EoP mitigation).

---

## 3. SentryBridge REST API

SentryBridge exposes a REST API consumed by the React frontend. The full machine-readable specification is available as **[OpenAPI YAML at `docs/spec/api.yaml`](./api.yaml)**.

### Summary of Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health/` | Detailed health status for all components |
| GET | `/api/health/live` | Liveness probe (Docker HEALTHCHECK) |
| GET | `/api/health/ready` | Readiness probe (503 if critical component DOWN) |
| GET | `/api/config` | Read current configuration |
| POST | `/api/setup/save` | Save configuration and restart bridge |
| GET | `/api/status/stream` | SSE stream of printer + bridge status |
| GET | `/api/printer/info` | Printer name/hostname |
| GET | `/api/camera/snapshot` | JPEG camera snapshot |
| POST | `/api/control` | Printer control (pause/resume/cancel) |
| POST | `/api/bridge/reconnect` | Reconnect a component |
| POST | `/api/wizard/test-prusalink` | Test PrusaLink connection |
| POST | `/api/wizard/test-camera` | Test RTSP camera stream |
| POST | `/api/wizard/verify-pairing` | Verify Obico pairing code |
| GET | `/api/wizard/configured` | Check if bridge is configured |
| GET | `/api/files/` | List G-code files (OctoPrint-compatible) |
| POST | `/api/files/` | Upload G-code file |
| POST | `/api/files/:filename/print` | Start print |
| DELETE | `/api/files/:filename` | Delete file |
| GET | `/stream/mjpeg` | MJPEG live stream |

See [`api.yaml`](./api.yaml) for request/response schemas, status codes, and examples.
