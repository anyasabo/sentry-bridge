# Obico Agent Protocol Research

**Issue:** #2  
**Status:** Complete  
**Sources:**

- https://github.com/TheSpaghettiDetective/moonraker-obico (reference agent implementation)
- https://github.com/TheSpaghettiDetective/obico-server (server-side consumer)

---

## Summary

| Component               | Details                                                |
| ----------------------- | ------------------------------------------------------ |
| WebSocket Endpoint      | `wss://{server}/ws/dev/`                               |
| Auth Method             | Bearer token in HTTP header during WS upgrade          |
| Auth Header             | `authorization: bearer {token}`                        |
| Auth Token              | 20-char hex string, obtained via pairing flow          |
| Status Update Frequency | Every 30s (routine), immediate on state change         |
| Status Format           | JSON with nested state/progress/temperature            |
| Camera Upload           | HTTP POST to `/api/v1/octo/pic/`, base64 JPEG          |
| Camera Frequency        | Every 10s default                                      |
| Control Commands        | WebSocket passthrough messages (`target/func/args`)    |
| Heartbeat               | Implicit — status updates serve as keepalive           |
| Message Queue           | Max 50 pending messages                                |
| Pairing Code            | 5-char alphanumeric, 2h cache, 60s verification window |

---

## 1. WebSocket Connection

**Endpoint:**

```
wss://{obico_server_url}/ws/dev/
```

**Authentication:**  
Bearer token passed as HTTP header during the WebSocket upgrade request:

```
authorization: bearer {auth_token}
```

The `auth_token` is a 20-character hex string (`hexlify(os.urandom(10))`), obtained via the pairing flow and stored in config.

**Server-side routing:**  
`ws/dev/` → `OctoPrintConsumer` (handles all agent connections)

**Source files:**

- `moonraker_obico/server_conn.py` — connection setup
- `moonraker_obico/ws.py` — WebSocketClient with header injection
- `backend/api/ws_routing.py` — server-side routing
- `backend/api/consumers.py` — OctoPrintConsumer authentication

---

## 2. Pairing Flow

The pairing flow uses HTTP, not WebSocket.

**Step 1 — Discovery (optional):**

```
POST /api/v1/octo/discovery/
Body: { host_or_ip, device_id }
```

Can generate a one-time passcode or queue messages for network discovery.

**Step 2 — Agent requests a pairing code:**  
5-character alphanumeric code, 2-hour TTL, generated server-side via `request_one_time_passcode()`.  
User is shown this code and enters it in the Obico web UI.

**Step 3 — Verify code and obtain API key:**

```
POST /api/v1/octo/verify/?code=<code>
Body: (empty)
Response: {
  "printer": { "auth_token": "<20-char-hex>", "id": 3, "name": "...", ... },
  "code": "116768",
  "expired_at": "...",
  "verified_at": "..."
}
```

⚠️ The code is passed as a **query parameter**, not in the JSON body.  
The `auth_token` is nested under `printer.auth_token`.  
On success, the server creates/updates a `Printer` record and returns the `auth_token`.  
The agent stores this token in config — it is used for all future WebSocket connections.

**Source files:**

- `moonraker_obico/link.py` — pairing flow orchestration
- `backend/api/octoprint_views.py` — OctoPrinterDiscoveryView, OneTimeVerificationCodeVerifyView
- `backend/lib/one_time_passcode.py` — code generation and validation

---

## 3. Printer Status Message

Sent over WebSocket as JSON. Routine interval: **30 seconds**. Sent immediately on state changes.

```json
{
  "current_print_ts": 1712000000,
  "status": {
    "_ts": 1712000000,
    "state": {
      "text": "Printing",
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
        "path": "/path/to/benchy.gcode",
        "obico_g_code_file_id": null
      }
    },
    "progress": {
      "completion": 42.5,
      "filepos": 102400,
      "printTime": 1800,
      "printTimeLeft": 2400,
      "filamentUsed": 12.3
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

- `current_print_ts`: Unix timestamp if printing, `null` if idle/offline
- `state.text`: Human-readable state string (`Printing`, `Paused`, `Operational`, `Offline`)
- `event` field is optional — only present on state transitions
- Status is also POSTed to `/api/v1/octo/ping/` as HTTP fallback

**Source files:**

- `moonraker_obico/printer.py` — PrinterState.to_dict()
- `moonraker_obico/server_conn.py` — post_status_update_to_server()

---

## 4. Camera Frame Upload

Camera frames are sent via **HTTP POST**, not WebSocket.

```
POST /api/v1/octo/pic/
Content-Type: multipart/form-data

img:           <base64-encoded JPEG>
name:          <webcam name>
cam_name:      <display name>
is_primary_cam: true
```

**Frequency:** Every 10 seconds (default), 3 seconds in debug mode.  
**Max size:** 7 MB per frame.  
**Format:** JPEG only, base64-encoded.

For SentryBridge: We capture RTSP frames via ffmpeg → encode as base64 JPEG → POST to this endpoint.

**Source files:**

- `moonraker_obico/webcam_capture.py` — JpegPoster class, capture_jpeg()

---

## 5. Control Commands (Obico → Agent)

Received over WebSocket as passthrough messages:

```json
{
  "passthru": {
    "ref": "unique-ref-string",
    "target": "Printer",
    "func": "pause",
    "args": [],
    "kwargs": {}
  }
}
```

**Relevant targets and functions for SentryBridge:**

| target    | func       | description         |
| --------- | ---------- | ------------------- |
| `Printer` | `pause()`  | Pause active print  |
| `Printer` | `resume()` | Resume paused print |
| `Printer` | `cancel()` | Cancel print job    |

**Response:** Agent sends back a message matching the `ref`, containing either the return value or an error description.

**Source files:**

- `moonraker_obico/passthru_targets.py` — PassthruExecutor, command handlers
- `backend/api/consumers.py` — OctoPrintConsumer.receive()

---

## 6. Heartbeat / Keepalive

**No explicit heartbeat messages.** Status updates serve as the implicit keepalive.

- Server caches printer status with **120-second TTL**
- Routine status updates every 30s keep the cache alive
- If no update arrives within TTL, server considers the printer offline
- WebSocket-level ping/pong is handled by the underlying `websocket-client` library
- Reconnection: exponential backoff, max 300 seconds

**Source files:**

- `moonraker_obico/server_conn.py` — ExpoBackoff, start() reconnection loop
- `backend/api/octoprint_messages.py` — process_printer_status(), 120s TTL

---

## Implementation Notes for `src/obico/agent.ts`

1. **Connection**: Open WebSocket to `{serverUrl}/ws/dev/` with `Authorization: bearer {apiKey}` header.
2. **Pairing**: POST to `/api/v1/octo/verify/` with the user-entered code → store returned `auth_token`.
3. **Status loop**: Send status JSON every 30 seconds and immediately on printer state changes.
4. **Camera loop**: POST base64 JPEG to `/api/v1/octo/pic/` every 10 seconds (or configured interval).
5. **Control commands**: Listen for `passthru` messages on WebSocket → dispatch `pause`/`resume`/`cancel` to PrusaLink Client.
6. **Reconnection**: Implement exponential backoff on WebSocket disconnect.
