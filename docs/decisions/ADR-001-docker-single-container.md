# ADR-001: Docker Single-Container Model (One Container = One Printer)

## Status

Accepted

## Context and Problem Statement

SentryBridge must run alongside one or more Prusa printers on a user's LAN without requiring complex orchestration. The deployment target includes home lab setups (Unraid, Raspberry Pi, NAS) where Docker Compose is the primary tool. How should the service be packaged and deployed?

## Decision Drivers

- Deployment simplicity: users should be able to start with a single `docker run` command.
- Isolation: each printer should have independent configuration, logs, and failure domain.
- Compatibility: must run on Unraid (AMD64) and Raspberry Pi (ARM64).
- Includes bundled ffmpeg and Janus WebRTC gateway — binary dependencies packaged in image.

## Considered Options

1. **Single container per printer** — each printer gets its own container instance.
2. **Multi-printer single container** — one container manages all printers via a config array.
3. **Sidecar model** — bridge as a sidecar to an existing OctoPrint/Moonraker container.

## Decision Outcome

Chosen: **Option 1 — Single container per printer**.

Reasoning: simplest deployment story ("one `docker run`"), clear failure isolation, straightforward config model (one `config.json`), and aligns with how users already run OctoPrint (one instance per printer).

Multi-printer support is explicitly deferred — it would require significant API and UI changes with unclear demand.

## Consequences

- **Positive:** Simple setup wizard and config model. Independent upgrades per printer. Docker Compose scales naturally (duplicate service block with different ports and config volumes).
- **Negative:** Multiple printers require multiple container instances and port mappings. Resource overhead multiplied per printer.
- **Constraint established:** `src/bridge.ts` is a single-instance orchestrator. No printer-ID routing anywhere in the codebase.
