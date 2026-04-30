# 1. System Overview and Context

## System Purpose

SentryBridge is a standalone Docker service that connects Prusa printers (Core One, MK4S) to Obico — a 3D-printing monitoring platform that uses AI failure detection. It acts as an OctoPrint-compatible Obico agent, so no modifications to Obico or PrusaLink are required.

**Core value:** A Prusa printer owner on a LAN-only self-hosted Obico setup can get AI failure detection running in under 10 minutes, with camera stream and printer control that just work.

## Scope

| In scope                                              | Out of scope                                      |
| ----------------------------------------------------- | ------------------------------------------------- |
| One Prusa printer per container instance              | Multiple printers per container                   |
| PrusaLink HTTP API (Core One, MK4S)                   | Prusa Mini (different firmware, different API)    |
| RTSP camera stream from Buddy3D board                 | USB cameras, IP cameras without RTSP              |
| Obico self-hosted and cloud (app.obico.io)            | Other monitoring platforms (OctoEverywhere, etc.) |
| Print control: pause, resume, cancel, start from file | G-code terminal, direct temperature control       |
| G-code file management: list, upload, print, delete   | Thumbnail preview, slicer integration             |
| LAN deployment (Docker on Unraid, Raspberry Pi, NAS)  | Cloud-hosted deployment of the bridge itself      |

## System Context

See [arc42 Chapter 3 — System Scope and Context](../architecture/03-context.md) for the context diagram and external interface summary.

## Stakeholders

| Role                       | Description                                   | Primary Concern                                                   |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Home Lab User              | Runs Prusa printer + self-hosted Obico on LAN | Easy setup; reliable background service; print control from Obico |
| Self-Hosted Obico Operator | Manages Obico instance                        | Bridge connects without Obico changes; camera stream works        |
| Contributor                | Developer extending or debugging the bridge   | Clear module boundaries; documented protocol; test suite          |

## Definitions and Acronyms

| Term                     | Definition                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| PrusaLink                | Prusa's built-in HTTP API for printer status and control (Buddy firmware)                   |
| Obico                    | Open-source 3D print monitoring platform with AI failure detection                          |
| OctoPrint agent protocol | Obico's WebSocket protocol, originally designed for OctoPrint agents                        |
| Janus                    | Open-source WebRTC gateway; bundled in the SentryBridge container for live stream           |
| RTSP                     | Real-Time Streaming Protocol; camera stream endpoint on Buddy3D board                       |
| Circuit Breaker          | Resilience pattern: stops calling a failing endpoint after N failures, resets after timeout |
| GSD                      | Get Shit Done — internal project workflow tooling (not part of the public product)          |
