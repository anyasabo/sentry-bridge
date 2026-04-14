# ADR-007: MIT License for Open-Source Release

## Status

Accepted

## Context and Problem Statement

SentryBridge is being released as an open-source project. A license must be chosen that allows broad community adoption, integration into other projects, and commercial use, while minimising legal complexity for contributors and users.

## Decision Drivers

- Permissive license preferred — the project fills a gap in the Prusa/Obico ecosystem and should be usable without restrictions.
- License must be compatible with all dependencies (Node.js ecosystem, Alpine Linux packages, ffmpeg).
- Community-friendly: contributors should not face legal friction.
- Docker Hub and GitHub hosting are the primary distribution channels.

## Considered Options

1. **MIT License** — permissive, requires attribution, no copyleft.
2. **Apache 2.0** — permissive, includes patent grant, more verbose.
3. **GPL v3** — copyleft, requires derivative works to be open-source.

## Decision Outcome

Chosen: **MIT License**.

Reasoning: MIT is the most widely used permissive license in the Node.js ecosystem. It is maximally permissive, minimises friction for users and contributors, and is compatible with all project dependencies. The patent protection of Apache 2.0 is not a concern for this project's scope.

## Consequences

- **Positive:** Maximum adoption potential. No copyleft restrictions. Standard for Node.js open-source projects.
- **Negative:** No patent grant (compared to Apache 2.0) — acceptable for a home automation bridge tool.
- **Implementation:** `LICENSE` file at the repo root contains the MIT License text with copyright holder "René Leban".
