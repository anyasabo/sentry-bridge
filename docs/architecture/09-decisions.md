# Chapter 9: Architecture Decisions

Architecture decisions are recorded as Architecture Decision Records (ADRs) in MADR format. ADR files live in [`docs/decisions/`](../decisions/).

## ADR Index

| ID                                                            | Title                                                       | Status   | Date       |
| ------------------------------------------------------------- | ----------------------------------------------------------- | -------- | ---------- |
| [ADR-0001](../decisions/ADR-0001-docker-single-container.md)  | Docker Single-Container Model (One Container = One Printer) | Accepted | 2026-04-13 |
| [ADR-0002](../decisions/ADR-0002-octoprint-agent-identity.md) | OctoPrint Agent Identity for Obico WebSocket                | Accepted | 2026-04-13 |
| [ADR-0003](../decisions/ADR-0003-http-digest-auth.md)         | HTTP Digest Authentication for PrusaLink API                | Accepted | 2026-04-13 |
| [ADR-0004](../decisions/ADR-0004-rtsp-ffmpeg-camera.md)       | RTSP Camera Stream via ffmpeg                               | Accepted | 2026-04-13 |
| [ADR-0005](../decisions/ADR-0005-circuit-breaker-pattern.md)  | Circuit Breaker Pattern for External Component Resilience   | Accepted | 2026-04-13 |
| [ADR-0006](../decisions/ADR-0006-config-on-volume.md)         | Configuration Stored as JSON File on Docker Volume          | Accepted | 2026-04-13 |
| [ADR-0007](../decisions/ADR-0007-mit-license.md)              | MIT License for Open-Source Release                         | Accepted | 2026-04-13 |

## Decision Process

Decisions were made iteratively during development (v1.0 through v1.1.0) and documented retroactively as part of the v1.2.0 open-source release preparation. Each ADR captures the problem context, the alternatives considered, and the rationale for the chosen option.

For the full list of validated design decisions, see the ADR index above.
