# ADR-0003: HTTP Digest Authentication for PrusaLink API

## Status

Accepted

## Context and Problem Statement

PrusaLink's HTTP API (Buddy board firmware on Prusa Core One / MK4S) requires authentication for all endpoints. The protocol used by PrusaLink is HTTP Digest Auth — the username (`maker`) and password are shown on the printer's display. How should SentryBridge authenticate with PrusaLink?

## Decision Drivers

- Must match PrusaLink's required auth scheme — no alternative.
- The `digest-fetch` npm package provides HTTP Digest Auth support for Node.js fetch.
- Credentials are stored in `config.json` on the mounted volume (not in environment variables — too dynamic for per-printer config).

## Considered Options

1. **HTTP Digest Auth via `digest-fetch`** — Node.js package wrapping fetch with Digest challenge/response.
2. **HTTP Basic Auth** — Not supported by PrusaLink.
3. **API Key / Bearer token** — Not supported by PrusaLink.

## Decision Outcome

Chosen: **Option 1 — HTTP Digest Auth via `digest-fetch`**.

There is no alternative: PrusaLink mandates HTTP Digest Auth. The `digest-fetch` package is used in `src/prusalink/client.ts` via the unified `request()` helper, which covers all PrusaLink API calls (status polling, job polling, pause/resume/cancel, file list/upload/startPrint/delete).

## Consequences

- **Positive:** All PrusaLink mutations go through a single `request()` helper, which is covered by the circuit breaker.
- **Negative:** HTTP Digest Auth adds a round-trip (401 challenge → re-request with credentials). Acceptable latency for the polling interval (5 s default).
- **Security note:** Credentials are stored in plaintext in `config.json`. This is intentional — the service is LAN-only and no external secret store is available in the target deployment environment.
