# ADR-006: Configuration Stored as JSON File on Docker Volume

## Status

Accepted

## Context and Problem Statement

SentryBridge needs to persist printer-specific configuration (PrusaLink URL/credentials, Obico server URL/API key, camera RTSP URL, polling intervals) across container restarts. Configuration changes must take effect without restarting the container. What is the appropriate persistence mechanism for a single-printer, single-container service?

## Decision Drivers

- Target deployment (Unraid, Raspberry Pi, NAS) typically does not include a database server.
- Configuration should be human-readable and editable outside the container if needed.
- Setup wizard writes configuration after the user completes the 4-step flow.
- Hot-reload on config change is required (no container restart needed).
- No cross-instance shared state — each container is independent.

## Considered Options

1. **JSON file on Docker volume** — `/config/config.json` on a mounted volume.
2. **Environment variables only** — all config via `docker run -e ...` or Compose `environment:`.
3. **SQLite database** — embedded DB on a volume.

## Decision Outcome

Chosen: **Option 1 — JSON file on Docker volume** (`/config/config.json`).

Reasoning: simplest persistence model for a single-instance service. Human-readable. The setup wizard writes it once; subsequent changes are incremental. Environment variables are reserved for infrastructure config (ports, Janus settings, resilience tuning) — not for per-printer application config, which changes via the web UI.

## Consequences

- **Positive:** No external dependencies. Config is portable (copy the volume to migrate). Easy to inspect and edit manually.
- **Negative:** No schema validation at the file level — malformed JSON causes startup failure. No config versioning or migration tooling in the current version.
- **Hot-reload mechanism:** `configEmitter` (Node.js `EventEmitter`) in `src/config/config.ts` emits `"configChanged"` on `saveConfig()`. Bridge Orchestrator listens and triggers teardown + reinit.
