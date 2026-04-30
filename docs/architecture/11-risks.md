# Chapter 11: Risks and Technical Debt

## Risks

| ID   | Risk                                                                   | Likelihood | Impact | Mitigation                                                                                                                                     |
| ---- | ---------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Obico server changes the WebSocket protocol (breaking change)          | Low        | High   | Protocol is reverse-engineered from open-source code. Monitor Obico releases. The ADR-0002 identity version (`2.1.0`) may need updating.       |
| R-02 | PrusaLink firmware update changes API surface                          | Low        | Medium | API is documented in the official OpenAPI spec. Only standard endpoints are used. Monitor Prusa firmware changelogs.                           |
| R-03 | RTSP stream unavailable after Prusa firmware update (WebRTC-only mode) | Medium     | High   | Newer Prusa firmware defaults to WebRTC streaming mode. Users must manually switch to RTSP in Prusa Connect settings. Document in setup guide. |
| R-04 | No API authentication on REST endpoints                                | High       | Medium | LAN-only deployment mitigates external exposure. Planned for a future milestone (API Basic Auth or token). Documented as known limitation.     |
| R-05 | Config stored in plaintext JSON including credentials                  | Medium     | Medium | LAN-only deployment reduces risk. Future: consider config encryption at rest.                                                                  |
| R-06 | ffmpeg process leak on RTSP timeout                                    | Low        | Medium | `testStream()` has a timeout guard. The camera circuit breaker tracks failures. Monitored via health endpoint.                                 |

## Technical Debt

| ID    | Item                                                              | Impact                                                      | Priority                         |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| TD-01 | No API authentication                                             | Security risk on non-isolated networks                      | High — next milestone            |
| TD-02 | Hardcoded agent identity version `2.1.0` in Obico agent           | Must be updated manually if Obico changes protocol          | Medium                           |
| TD-03 | No config schema validation at startup                            | Malformed `config.json` causes cryptic startup failure      | Medium                           |
| TD-04 | Frame upload via per-frame ffmpeg spawn (not persistent pipeline) | Higher CPU overhead at low frame rates                      | Low — acceptable for current use |
| TD-05 | No structured logging (JSON)                                      | Harder to integrate with log aggregation tools (Loki, etc.) | Low                              |
| TD-06 | Layer count / Z-height not available from PrusaLink               | Obico shows no layer progress — requires G-code parsing     | Low — separate issue #80         |
| TD-07 | `cachedJob` fallback for FINISHED/FINISHING state is implicit     | Logic depends on timing; may fail on very fast printers     | Low — monitored                  |
