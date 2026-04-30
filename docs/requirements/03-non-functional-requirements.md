# 03: Non-Functional Requirements

**Document ID:** SPEC-03  
**Relates to:** SRS-NFR-001 through SRS-NFR-014  
**Standard:** ISO/IEC 29148

---

## NFR Categories

### Performance

| ID      | Requirement                   | Measurable Criterion                                                                                                     |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| NFR-P01 | Camera frame upload latency   | End-to-end latency from RTSP capture to Obico HTTP POST completion ≤ 2 s at the default frame interval of 2 s            |
| NFR-P02 | Printer status poll interval  | PrusaLink `/api/v1/status` polled every 5 000 ms by default (configurable via `statusIntervalMs`)                        |
| NFR-P03 | Obico status update frequency | Status JSON sent to Obico WebSocket every 30 s (routine) and immediately on printer state change                         |
| NFR-P04 | Setup wizard response time    | Each wizard step (PrusaLink test, camera test, pairing verify) completes within 10 s under normal LAN conditions         |
| NFR-P05 | File upload throughput        | G-code file uploads up to 200 MB are accepted without OOM; multer diskStorage streaming is used (no in-memory buffering) |

### Resilience

| ID      | Requirement                    | Measurable Criterion                                                                                                                                |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-R01 | Circuit breaker trip threshold | After 5 consecutive failures, the circuit breaker opens and stops sending requests to the failing component                                         |
| NFR-R02 | Circuit breaker reset timeout  | Circuit breaker transitions to HALF-OPEN after 60 000 ms; if the probe succeeds, it transitions to CLOSED                                           |
| NFR-R03 | Reconnect backoff              | Reconnect delay starts at 1 000 ms, doubles per attempt, caps at 30 000 ms                                                                          |
| NFR-R04 | Pairing timeout                | `waitForPairing()` times out after 120 s and returns a 504 error to the wizard                                                                      |
| NFR-R05 | Critical health timeout        | `GET /api/health/ready` returns 503 when any critical component has been DOWN for > 120 000 ms (configurable via `HEALTHCHECK_CRITICAL_TIMEOUT_MS`) |

### Security

| ID      | Requirement                       | Measurable Criterion                                                                                                                                                       |
| ------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-S01 | LAN-only deployment               | No REST API authentication is enforced in v1.1.0 — deployment is LAN-only; users must not expose port 3000 to the internet without additional network-level controls       |
| NFR-S02 | SSRF mitigation for file download | `file_downloader.download` only downloads from URLs whose origin matches the configured `obicoServerUrl` — any other origin is rejected with 400                           |
| NFR-S03 | http.tunnel path restriction      | The `http.tunnelv2` handler only proxies requests to `/api/*` paths and HTTP methods `GET`, `POST`, `DELETE` — prevents use as a general HTTP proxy                        |
| NFR-S04 | Credential storage                | PrusaLink credentials and Obico API key are stored in plaintext in `/config/config.json` on the Docker volume; the volume must be access-controlled at the OS/Docker level |

### Portability

| ID       | Requirement            | Measurable Criterion                                                                                          |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| NFR-PO01 | Container platforms    | Docker image built for `linux/amd64` and `linux/arm64`; verified on Unraid (AMD64) and Raspberry Pi 4 (ARM64) |
| NFR-PO02 | Node.js runtime        | Requires Node.js 22+; Docker image uses `node:22-alpine`                                                      |
| NFR-PO03 | No database dependency | All persistent state is stored in `/config/config.json` — no external database required                       |

### Maintainability

| ID      | Requirement       | Measurable Criterion                                                                                                         |
| ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| NFR-M01 | Test coverage     | Backend test suite: ≥ 200 unit tests (210+ as of v1.1.0); TDD enforced for Config, PrusaLink Client, and Obico Agent modules |
| NFR-M02 | Module boundaries | Four core modules (`config`, `prusalink`, `camera`, `obico`) communicate through defined interfaces; no circular imports     |
