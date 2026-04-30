# Chapter 6: Runtime View

This chapter documents six key runtime scenarios that illustrate how SentryBridge behaves during operation. Each scenario is shown as a Mermaid sequence diagram.

---

## Scenario 1: Pairing Flow

The initial pairing establishes the connection between SentryBridge and the Obico server. The wizard triggers this flow after the user configures PrusaLink and camera.

```mermaid
sequenceDiagram
    participant UI as Web UI (Browser)
    participant Bridge as SentryBridge
    participant Obico as Obico Server

    UI->>Bridge: POST /api/wizard/verify-pairing {obicoServerUrl, code}
    Bridge->>Obico: POST /api/v1/octo/verify/?code=<code>
    Obico-->>Bridge: 200 { printer: { auth_token, id, name } }
    Bridge-->>UI: 200 { apiKey, serverUrl }
    UI->>Bridge: POST /api/setup/save (full config incl. apiKey)
    Bridge->>Bridge: saveConfig() → emit configChanged
    Bridge->>Obico: WebSocket connect wss://{server}/ws/dev/ (Authorization: bearer {auth_token})
    Obico-->>Bridge: WebSocket established
    Bridge->>Obico: Send printer_info { type: "moonraker_obico", version: "2.1.0" }
```

---

## Scenario 2: Frame Loop

After pairing, SentryBridge continuously captures camera frames and forwards them to Obico for AI failure detection.

```mermaid
sequenceDiagram
    participant Printer as Buddy3D Camera (RTSP)
    participant ffmpeg as ffmpeg process
    participant Bridge as SentryBridge (Camera Module)
    participant Obico as Obico Server

    loop Every frameIntervalSeconds (default: 2s)
        Bridge->>ffmpeg: spawn: ffmpeg -rtsp_transport tcp -i rtsp://[ip]/live -vframes 1 -f image2pipe
        ffmpeg->>Printer: RTSP connect + request frame
        Printer-->>ffmpeg: RTSP stream (H.264)
        ffmpeg-->>Bridge: JPEG frame (stdout pipe)
        Bridge->>Bridge: encode frame as base64
        Bridge->>Obico: POST /api/v1/octo/pic/ (multipart: img=<base64>, is_primary_cam=true)
        Obico-->>Bridge: 200 OK
    end
```

---

## Scenario 3: Reconnect Flow

When the Obico WebSocket connection drops, SentryBridge reconnects with exponential backoff.

```mermaid
sequenceDiagram
    participant Bridge as SentryBridge (Obico Agent)
    participant CB as Circuit Breaker (obico_ws)
    participant Obico as Obico Server
    participant Health as Health Monitor

    Obico--xBridge: WebSocket disconnect (network error)
    Bridge->>CB: recordFailure()
    CB-->>Bridge: state: CLOSED (failure count < threshold)
    Bridge->>Health: setComponentState("obico_ws", DOWN)

    loop Exponential backoff (1s → 2s → 4s → … → 30s max)
        Bridge->>Obico: WebSocket connect attempt
        alt Connection succeeds
            Obico-->>Bridge: WebSocket established
            Bridge->>Health: setComponentState("obico_ws", HEALTHY)
            Bridge->>CB: recordSuccess()
            Bridge->>Obico: Send printer_info (re-pairing check)
        else Connection fails
            Obico--xBridge: Connection refused / timeout
            Bridge->>CB: recordFailure()
            Bridge->>Bridge: increase backoff delay (cap at 30s)
        end
    end
```

---

## Scenario 4: Print-Start Flow

Obico sends a print command (from the Obico control panel or file library). SentryBridge dispatches it to PrusaLink and sends a ref-matched ACK.

```mermaid
sequenceDiagram
    participant Obico as Obico Server
    participant Bridge as SentryBridge (Obico Agent)
    participant PrusaLink as PrusaLink HTTP API

    Obico->>Bridge: WebSocket passthru { ref, target: "Printer", func: "start_printer_local_print", kwargs: { gcode_file_id } }
    Bridge->>Bridge: resolve file name from gcode_file_id
    Bridge->>PrusaLink: POST /api/v1/files/usb/{filename}/print (HTTP Digest Auth)
    PrusaLink-->>Bridge: 204 No Content
    Bridge->>Obico: WebSocket passthru ACK { ref, ret: null }

    Note over Bridge,Obico: For file_downloader.download flow:
    Obico->>Bridge: WebSocket passthru { func: "file_downloader.download", kwargs: { url } }
    Bridge->>Bridge: SSRF check — url origin must match configured obicoServerUrl
    Bridge->>Obico: GET {url} (download G-code from Obico server)
    Obico-->>Bridge: G-code file content
    Bridge->>PrusaLink: POST /api/v1/files/usb (multipart upload)
    PrusaLink-->>Bridge: 201 Created
    Bridge->>PrusaLink: POST /api/v1/files/usb/{filename}/print
    PrusaLink-->>Bridge: 204 No Content
    Bridge->>Obico: WebSocket passthru ACK { ref, ret: null }
```

---

## Scenario 5: Config Hot-Reload

When the user saves a new configuration through the dashboard, the bridge tears down all active connections and reinitialises with the new config.

```mermaid
sequenceDiagram
    participant UI as Web UI (Browser)
    participant API as Express API
    participant Config as Config Module
    participant Bridge as Bridge Orchestrator

    UI->>API: POST /api/setup/save { prusalink, camera, obico, ... }
    API->>Config: saveConfig(newConfig)
    Config->>Config: write /config/config.json
    Config->>Bridge: emit("configChanged")
    Bridge->>Bridge: stopBridge() — close WS, kill ffmpeg, clear poll interval
    Bridge->>Config: loadConfig()
    Bridge->>Bridge: startBridge() — init PrusaLink client, Camera, Obico Agent
    Bridge-->>API: bridge restarted
    API-->>UI: 200 { ok: true }
```

---

## Scenario 6: Circuit Breaker Trip

When PrusaLink becomes unreachable, the circuit breaker opens after 5 consecutive failures, preventing further requests until the reset timeout expires.

```mermaid
sequenceDiagram
    participant Bridge as SentryBridge (Poll Loop)
    participant CB as Circuit Breaker (prusalink)
    participant PrusaLink as PrusaLink HTTP API
    participant Health as Health Monitor

    loop Poll every 5s
        Bridge->>CB: execute(getStatus)
        CB->>PrusaLink: GET /api/v1/status (HTTP Digest Auth)
        PrusaLink--xCB: timeout / connection refused
        CB->>CB: recordFailure() — count: 1→2→3→4→5
    end

    Note over CB: threshold=5 reached → circuit OPEN
    CB->>Health: setComponentState("prusalink", DOWN)

    loop While circuit OPEN (60s reset timeout)
        Bridge->>CB: execute(getStatus)
        CB-->>Bridge: CircuitOpenError (no request sent to PrusaLink)
    end

    Note over CB: 60s elapsed → circuit HALF-OPEN
    Bridge->>CB: execute(getStatus)
    CB->>PrusaLink: GET /api/v1/status (probe request)

    alt PrusaLink recovered
        PrusaLink-->>CB: 200 OK
        CB->>CB: circuit CLOSED
        CB->>Health: setComponentState("prusalink", HEALTHY)
    else Still unreachable
        PrusaLink--xCB: timeout
        CB->>CB: circuit OPEN again (60s reset restarts)
    end
```
