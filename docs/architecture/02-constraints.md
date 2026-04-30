# 2. Architecture Constraints

## Technical Constraints

| ID    | Constraint                                                     | Rationale                                                                                                         |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TC-01 | Runtime: Node.js 22 + TypeScript                               | Chosen in Milestone 1; test suite and tooling are built around this stack                                         |
| TC-02 | Frontend: React + Vite + Mantine v9                            | Established stack; changing would require full UI rewrite                                                         |
| TC-03 | Deployment: Single Docker container (alpine-based) with ffmpeg | Simplest possible deployment for home lab use                                                                     |
| TC-04 | Multi-platform: linux/amd64 + linux/arm64                      | Must run on Unraid (typically AMD64) and Raspberry Pi / NAS (ARM64)                                               |
| TC-05 | Config: JSON file on mounted Docker volume                     | No database dependency; config survives container restarts                                                        |
| TC-06 | Camera: RTSP only (`rtsp://[ip]/live`)                         | Buddy3D board on Prusa Core One exposes only RTSP; no HTTP snapshot endpoint during streaming                     |
| TC-07 | Obico protocol: OctoPrint agent identity                       | Moonraker identity would unlock Janus features that are unstable; OctoPrint identity is the tested path (ADR #46) |
| TC-08 | No API authentication (current)                                | LAN-only deployment; risk accepted; API auth is a candidate for a future milestone                                |

## Organizational Constraints

| ID    | Constraint                          | Rationale                                                                                 |
| ----- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| OC-01 | License: MIT                        | Open-source release; permissive license matches home-lab audience expectations            |
| OC-02 | One container = one printer         | Simplifies state management; multi-printer support is deferred                            |
| OC-03 | TDD for all backend modules         | Established project convention since Milestone 1; all three core modules have test suites |
| OC-04 | No Obico or PrusaLink modifications | Compatibility with all versions; reduces maintenance surface                              |
