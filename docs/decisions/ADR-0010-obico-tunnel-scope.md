# ADR-0010: Scope of the Obico HTTP Tunnel

## Status

Accepted

## Context and Problem Statement

Obico's printer control page has an "OctoPrint" button. It opens the agent's own web UI through Obico's tunnel: the Obico server allocates a tunnel (port or subdomain), and forwards every HTTP request on it to the agent as an `http.tunnelv2` message on the agent WebSocket — `/`, static assets, and API calls alike. Requests arrive as BSON binary frames; the official agents (moonraker-obico `tunnel.py`, `send_http_to_local_v2`) answer with a BSON frame whose `response` holds `status`, `compressed`, `content` (raw bytes, zlib-compressed when `compressed`), `cookies` and `headers`.

SentryBridge has a web UI with printer control and config writes, but no authentication. #30 decided that it is built for the LAN only. Which part of the bridge should the tunnel serve?

## Decision Drivers

- **No unauthenticated control from outside the LAN** — anyone with access to the printer in Obico could otherwise reach the bridge UI.
- **Protocol parity** — tunnel messages must use the same encoding as the official agents, or the Obico server cannot read them.
- **Useful button** — clicking it should tell the user what to do instead of failing.

## Considered Options

1. **A — Proxy the whole bridge UI through the tunnel.** Serve `/`, assets and all of `/api/*`.
2. **B — `/api/*` tunnel plus a LAN link page.** Proxy `/api/*` (narrowed to an allow-list, see below) with `GET`, `POST`, `DELETE` (NFR-S03); answer `GET /` with a small static page that says the UI is LAN-only and links to the bridge URL.
3. **C — Document the button as unsupported.** No `/` handling.

## Decision Outcome

Chosen: **Option B**.

Option A is rejected: it exposes an unauthenticated UI with printer control and config writes to anyone with Obico access to the printer, which contradicts the LAN-only decision of #30. Option C leaves the button failing with "path not allowed" and gives the user no hint.

The page for `GET /` is self-contained (no scripts, styles or images loaded from elsewhere). Its link uses the configured `bridgeUrl`, or the auto-detected URL the agent already reports as base of `stream_url`. Every other path outside `/api/*` stays `403`.

Within `/api/*`, the tunnel proxies only an explicit allow-list, not the whole prefix: a prefix rule would expose `POST /api/setup/save`, `/api/wizard/*`, `/api/bridge/reconnect` and `/api/control` to anyone with Obico access. The Obico server and web app call no bridge endpoint through the tunnel themselves (printer control and file prints use `passthru` messages), so the list holds only the read-only, OctoPrint-shaped `GET /api/files`. Paths are matched on the decoded, canonical pathname; traversal segments, empty segments, backslashes and percent-encoded `.`, `/`, `\` or NUL are rejected with `403`. As in moonraker-obico, the local request is sent with `Accept-Encoding: identity`.

## Consequences

- **Positive:**
  - The OctoPrint button shows where the UI is instead of an error.
  - Smaller attack surface than before: the tunnel serves one read-only endpoint from an allow-list plus a static page; config, setup, wizard, reconnect, control and file-mutating endpoints are LAN-only.
  - Tunnel replies use the official BSON format, so the allowed endpoints work against a real Obico server.
  - A new endpoint is reachable through the tunnel only after it is added to the allow-list in `src/obico/tunnel.ts` and NFR-S03.
- **Negative:**
  - The bridge UI is not usable remotely through Obico; users need the LAN, a VPN or their own authenticated reverse proxy.
  - Adds the `bson` dependency (Apache-2.0).
- **Constraint established:**
  - The button only reaches the bridge if the Obico server has tunnels enabled (`OCTOPRINT_TUNNEL_PORT_RANGE` or subdomain tunnels). With an empty port range such as `'0-0'`, Obico answers 484 before any request reaches the bridge.

## Related Decisions

- ADR-0002 — OctoPrint Agent Identity for Obico WebSocket.
