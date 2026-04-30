# ADR-0008: Janus WebRTC Relay for Live Stream in Obico Control Panel

## Status

Accepted

## Context and Problem Statement

Obico's control panel renders the printer's live camera feed for users. Two paths exist for delivering the camera stream from SentryBridge to Obico:

1. **MJPEG snapshot upload** — JPEG frames POSTed to Obico over HTTP (already implemented for AI failure detection, max 10s interval).
2. **Low-latency live video** — required for the interactive live stream Obico shows in its control panel.

MJPEG alone is insufficient for the live-stream UX: latencies of multiple seconds and jitter from per-frame HTTP uploads make the feed unsuitable for "watch the printer in real time" use cases. Obico's reference agents (Moonraker-Obico, OctoPrint Obico Plugin) integrate a WebRTC stream via Janus for this purpose; the Obico control panel expects a Janus WebSocket relay to be reachable.

How should SentryBridge deliver the live stream to Obico?

## Decision Drivers

- **Parity with Obico reference agents** — the Obico control panel client signals via a `/ws/janus/{id}/` WebSocket; without that endpoint, the live stream UI does not work.
- **Latency** — sub-second video for monitoring active prints; MJPEG cannot reach this.
- **One-container constraint** (ADR-0001) — adding an external service is acceptable only if it can be co-located in the same Docker image.
- **LAN deployment target** — users already need Docker; adding another binary inside the container is acceptable. Users should not have to run a separate Janus container for the basic case.
- **ARM64 + AMD64 support** — Janus must build/run on both architectures (Alpine package available).
- **No protocol invention** — SentryBridge follows existing Obico WebSocket message formats (reverse-engineered from open-source reference agents); inventing a custom video transport would break compatibility.

## Considered Options

1. **MJPEG only.** Drop the live-stream feature in Obico's control panel; rely solely on JPEG snapshots for AI detection.
2. **Bundled Janus inside the container** — package Janus binary in the Docker image (`janus-gateway` Alpine package), spawn it from the bridge process, and run a WebSocket relay between local Janus and the Obico server.
3. **External / sidecar Janus** — require users to run Janus as a separate container or service, configure the bridge to connect to it.
4. **Direct WebRTC peer connection from the bridge** — implement WebRTC signalling and media in Node.js (e.g. `wrtc`, `mediasoup`).

## Decision Outcome

Chosen: **Option 2 — bundled Janus, with optional Option 3 (hosted/sidecar) supported via `JANUS_MODE` env var**.

The bridge ships Janus inside its Docker image (`janus-gateway` Alpine package) and manages its lifecycle. The camera module emits an H.264 RTP stream; the `janus` module manages the Janus process and signals through a WebSocket relay so the Obico control panel can negotiate a WebRTC peer connection with the local Janus.

`JANUS_MODE=bundled|hosted|auto` covers two operational shapes without forcing users into one:

- **`bundled`** — bridge spawns and supervises its own Janus instance; default for the published Docker image.
- **`hosted`** — bridge connects to an externally managed Janus (sidecar pattern); used in development on macOS where Janus cannot be installed natively (see `docker-compose.dev.yml`).
- **`auto`** — detect a running Janus on `ws://127.0.0.1:8188` first, fall back to bundled.

Reasoning: bundled gives the user a one-`docker run` setup without sacrificing the option for advanced users to run their own Janus. The relay isolates the media path from the agent protocol — the WebSocket carrying status/frames stays separate from the Janus signalling channel.

The `JANUS_HOST_IP` env var is required when WebRTC is in use; without it, Janus cannot advertise a reachable ICE candidate to the browser. This is documented in the README and produces a graceful fallback (MJPEG only) when unset.

## Consequences

- **Positive:**
  - Live-stream parity with Moonraker-Obico and OctoPrint-Obico — Obico control panel "just works."
  - Sub-second latency for live video.
  - Single-container deployment for the default case (ADR-0001 preserved).
  - Separation of concerns: `src/janus/manager.ts` (process lifecycle) vs. `src/janus/relay.ts` (WS relay) — each is independently testable.
  - macOS development supported via `JANUS_MODE=hosted` and `docker-compose.dev.yml`.
- **Negative:**
  - Larger Docker image (Janus + dependencies, ~25 MB compressed).
  - Operational complexity: extra UDP port range (`10100–10200/udp`) must be published, and `JANUS_HOST_IP` must be set correctly or live stream falls back silently.
  - Janus is a C dependency we don't control — version bumps require image rebuilds and ARM/AMD64 testing.
- **Constraint established:**
  - `src/camera/camera.ts` produces both MJPEG frames (for ADR-0004's snapshot upload path) **and** an H.264 RTP output for Janus. Removing one breaks the other use case.
  - The Obico WebSocket (status/frames) and the Janus WebSocket (media signalling) are two distinct connections to the Obico server — both must be healthy for full functionality.

## Related Decisions

- ADR-0001 — Docker Single-Container Model (single image, multi-binary).
- ADR-0002 — OctoPrint Agent Identity for Obico WebSocket (status/frames path).
- ADR-0004 — RTSP Camera Stream via ffmpeg (camera input shared between MJPEG and RTP output).
