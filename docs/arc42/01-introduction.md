# 1. Introduction and Goals

## Purpose

SentryBridge is a standalone Docker service that connects Prusa printers (Core One, MK4S) to any Obico instance without modifying Obico or PrusaLink. One container per printer. Setup takes under 10 minutes via a browser-based wizard.

## Key Features

- Polls PrusaLink HTTP API for printer status and active job data
- Captures the RTSP camera stream via ffmpeg and uploads JPEG snapshots to Obico for AI failure detection
- Forwards printer status and camera frames to Obico over WebSocket (OctoPrint-compatible agent protocol)
- Provides a live WebRTC stream via a bundled Janus gateway for the Obico control panel
- Accepts pause / resume / cancel commands from Obico and relays them to PrusaLink
- Exposes a browser-based dashboard with live status, camera preview, and a G-code file browser

## Goals

| Priority | Goal | Motivation |
|----------|------|------------|
| 1 | Zero-modification integration | Obico and PrusaLink are not patched — bridge runs as a sidecar |
| 2 | Setup in under 10 minutes | Core value proposition: LAN printer + self-hosted Obico working fast |
| 3 | Resilient against transient failures | Circuit breakers and automatic reconnects for all three external connections |

## Quality Goals

| # | Quality Goal | Scenario |
|---|--------------|---------|
| 1 | Operability | A user with Docker knowledge can set up the bridge from zero using only the README — no external help needed |
| 2 | Reliability | The bridge recovers from PrusaLink, Obico WS, or camera failures within 60 seconds without manual intervention |
| 3 | Compatibility | The bridge works with any Obico instance (self-hosted or cloud) that accepts the OctoPrint agent protocol |

## Stakeholders

| Role | Expectation |
|------|-------------|
| Home Lab User | Easy Docker Compose setup; stable background service; control prints from Obico |
| Self-Hosted Obico Operator | Bridge connects without Obico changes; AI failure detection works out of the box |
| Contributor | Clear module boundaries; TypeScript; TDD test suite; arc42 architecture docs |
