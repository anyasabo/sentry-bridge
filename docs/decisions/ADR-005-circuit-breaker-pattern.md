# ADR-005: Circuit Breaker Pattern for External Component Resilience

## Status

Accepted

## Context and Problem Statement

SentryBridge depends on three external components that can be temporarily unavailable: PrusaLink (printer reboots, firmware updates), Obico WebSocket (network outages, server restarts), and the Camera (RTSP stream interruptions). Without protection, repeated failed requests would flood logs, consume resources, and prevent recovery detection. How should transient failures be managed?

## Decision Drivers

- Must prevent cascading failures when an external component is down.
- Must provide fast-fail behaviour when a component is known to be down.
- Must recover automatically when the component comes back online.
- Dashboard must show per-component health state to the user.

## Considered Options

1. **Circuit Breaker pattern** — state machine (CLOSED → OPEN → HALF-OPEN) with configurable threshold and reset timeout.
2. **Retry-only** — retry with backoff, no circuit state.
3. **Timeout-only** — requests time out, no failure accumulation logic.

## Decision Outcome

Chosen: **Option 1 — Circuit Breaker pattern**, implemented in `src/lib/circuit-breaker.ts`, registered per component in `CircuitBreakerRegistry` (`src/lib/health.ts`).

All three components (keys: `"prusalink"`, `"obico_ws"`, `"camera"`) have dedicated circuit breakers. The Retry pattern (`src/lib/retry.ts`) is used in addition for transient errors within the CLOSED state.

Default parameters: threshold=5 failures, reset timeout=60 s (configurable via environment variables).

## Consequences

- **Positive:** Fast-fail after 5 consecutive failures. Automatic recovery probe after 60 s. Circuit state is visible in the dashboard health card and `GET /api/health/` endpoint.
- **Negative:** Adds complexity to the call path. Wrong threshold tuning can cause false trips (too sensitive) or slow failure detection (too lenient).
- **Constraint:** The `reconnectComponent()` function in `src/bridge.ts` only accepts the keys `"prusalink"`, `"obico"`, `"camera"` — the reconnect button in the dashboard maps to these keys.
