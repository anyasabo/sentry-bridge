# Background Research

This directory contains the original research documents created during SentryBridge development. They document the protocol investigation process and implementation notes used to build the PrusaLink client and Obico agent.

## Contents

| File | Description |
|------|-------------|
| [prusalink-api.md](./prusalink-api.md) | PrusaLink HTTP API research — endpoints, auth, response schemas |
| [obico-agent-protocol.md](./obico-agent-protocol.md) | Obico WebSocket protocol research — connection, pairing, status, camera, commands |

## Relationship to SPEC-04

> **SPEC-04 (`docs/spec/04-interfaces.md`) is the authoritative interface specification.**

The files in this directory document the original protocol investigation — the research process, implementation notes, and source code references that informed the design. They are preserved as background material for historical context.

For the definitive, implementation-accurate description of the interfaces SentryBridge uses, refer to:

- **[docs/spec/04-interfaces.md](../spec/04-interfaces.md)** — PrusaLink API, Obico WebSocket Protocol, SentryBridge REST API
- **[docs/spec/api.yaml](../spec/api.yaml)** — OpenAPI 3.0 spec for the SentryBridge REST API
