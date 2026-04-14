# ADR-002: OctoPrint Agent Identity for Obico WebSocket

## Status

Accepted

## Context and Problem Statement

The Obico server's WebSocket endpoint (`/ws/dev/`) is designed for OctoPrint-based agents. It routes to `OctoPrintConsumer` server-side. Agents must identify themselves in the WebSocket connection. SentryBridge has no OctoPrint layer — it bridges PrusaLink directly. Which agent identity should it present to the Obico server?

## Decision Drivers

- Obico server must accept the connection without modification.
- The chosen identity should unlock full feature access (status, camera, print commands).
- Stability: the identity's server-side consumer must be mature and well-documented (open-source Obico server code is the reference).
- Moonraker identity would unlock Janus/WebRTC-specific Obico features but adds complexity.

## Considered Options

1. **OctoPrint identity** — present as `octoprint` agent type.
2. **Moonraker identity** — present as `moonraker_obico` v`2.1.0`.
3. **Custom identity** — register a new agent type with Obico server.

## Decision Outcome

Chosen: **Option 2 — Moonraker identity** (`moonraker_obico` v`2.1.0`).

Reasoning: The Moonraker agent is open-source and its WebSocket protocol was fully reverse-engineered (see `docs/background/obico-agent-protocol.md`). Using `moonraker_obico` identity enables Janus WebRTC passthru via `http.tunnelv2`, which is required for the Obico control panel's live stream tab. OctoPrint identity does not support the tunnel protocol.

Hardcoded version `2.1.0` matches the Moonraker agent version whose protocol was validated in the POC.

## Consequences

- **Positive:** Full Obico feature set including WebRTC stream in control panel. Mature, documented protocol.
- **Negative:** If Obico updates the Moonraker protocol in a breaking way, SentryBridge must update its implementation. The hardcoded version string may need updating.
- **Implementation note:** Agent identity is set in `src/obico/agent.ts` — see `printer_info` message payload.
