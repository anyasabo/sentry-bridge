# Chapter 10: Quality Goals

The following quality goals drive SentryBridge's architecture, listed in priority order.

## Quality Goals

| Priority | Quality Goal       | Motivation                                                                                                                                                                     |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | **Reliability**    | The bridge must forward print status and camera frames to Obico consistently. Dropped status updates cause Obico to mark the printer offline, disabling AI failure detection.  |
| 2        | **Operability**    | Setup must take under 10 minutes for a home lab user with no development background. The 4-step wizard and Docker Compose deployment support this goal.                        |
| 3        | **Recoverability** | When PrusaLink, the Obico WebSocket, or the camera fails transiently, the bridge must recover automatically without user intervention.                                         |
| 4        | **Correctness**    | Print commands dispatched from Obico (pause, resume, cancel, start print) must be forwarded accurately to PrusaLink with ref-matched ACKs. Silent failures are not acceptable. |
| 5        | **Portability**    | The Docker image must run on AMD64 (Unraid) and ARM64 (Raspberry Pi 4) without modification.                                                                                   |

## Quality Scenarios

### Reliability — Status Forwarding Continuity

**Stimulus:** PrusaLink returns HTTP 5xx for 2 consecutive polls.  
**Response:** Circuit breaker records failures. Status is not forwarded during the outage. After 60 s, the circuit breaker probes PrusaLink and resumes normal operation when it recovers.  
**Metric:** No false "printer offline" state in Obico when PrusaLink recovers within 60 s.

### Recoverability — Obico WebSocket Reconnect

**Stimulus:** Obico server restarts; WebSocket connection drops.  
**Response:** Bridge reconnects with exponential backoff (1 s → 2 s → ... → 30 s cap). Reconnection is automatic, no user action required.  
**Metric:** Reconnection succeeds within 30 s of server availability after a 5-minute outage.

### Operability — Setup Wizard Completion

**Stimulus:** New user with a running Prusa Core One and a self-hosted Obico instance.  
**Response:** User completes the 4-step wizard (PrusaLink → camera test → pairing → done) and the dashboard shows live printer status.  
**Metric:** Completion in under 10 minutes from `docker run` to active monitoring.

### Correctness — Print Command Dispatch

**Stimulus:** Obico sends `start_printer_local_print` passthru command.  
**Response:** Bridge dispatches the print to PrusaLink, receives 204 No Content, and sends ref-matched ACK back to Obico.  
**Metric:** 100% of print commands result in ACK. No silent failures.
