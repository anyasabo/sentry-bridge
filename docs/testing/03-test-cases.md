# 03: Representative Test Cases

**Document ID:** TEST-03
**Standard:** ISO/IEC 29119-4
**Version:** 1.1.0

This document describes representative test cases for the most architecturally significant scenarios. These cases were selected to cover the key risk areas: Obico pairing protocol, circuit breaker state machine, config hot-reload, and print command dispatch.

For the full test suite, see `src/__tests__/`.

---

## TC-001: Obico Pairing — Successful Code Verification

**Test File:** `src/__tests__/wizard-pairing.test.ts`
**Level:** Integration (HTTP route)
**Module:** Obico Agent + Wizard API
**Requirement:** SRS-008 (Obico pairing flow)

### Preconditions
- Obico server is reachable (mocked via `jest.spyOn(global, 'fetch')`)
- Valid 5-character pairing code is available

### Steps
1. POST `/api/wizard/verify-pairing` with `{ obicoServerUrl: "http://obico.test", code: "AB12C" }`
2. Mock fetch resolves with `{ printer: { auth_token: "abc123def456abc123de", id: 42, name: "test" } }`
3. Assert response is 200 `{ apiKey: "abc123def456abc123de", serverUrl: "http://obico.test" }`

### Expected Result
- HTTP 200 with `apiKey` and `serverUrl` in response body
- The `auth_token` nested under `printer.auth_token` is extracted correctly

### Actual Result (v1.1.0)
Pass

---

## TC-002: Obico Pairing — Timeout After 120 Seconds

**Test File:** `src/__tests__/wizard-pairing.test.ts`
**Level:** Integration (HTTP route + fake timers)
**Module:** Obico Agent + Wizard API
**Requirement:** SRS-008

### Preconditions
- Obico server mock always returns 404 (code not yet verified by user)
- `jest.useFakeTimers()` active

### Steps
1. POST `/api/wizard/verify-pairing` with valid `obicoServerUrl` and `code`
2. Advance fake timers by 121 000 ms
3. Assert response

### Expected Result
- HTTP 504 `{ message: "Pairing timed out..." }`

### Actual Result (v1.1.0)
Pass

---

## TC-003: Circuit Breaker — CLOSED to OPEN After 5 Failures

**Test File:** `src/__tests__/circuit-breaker.test.ts`
**Level:** Unit
**Module:** Circuit Breaker (`src/lib/circuit-breaker.ts`)
**Requirement:** SRS-013 (circuit breaker threshold)

### Preconditions
- Circuit breaker created with `threshold: 5`
- Wrapped function always throws

### Steps
1. Call `execute(fn)` — fails, count=1, state=CLOSED
2. Call `execute(fn)` — fails, count=2, state=CLOSED
3. Call `execute(fn)` — fails, count=3, state=CLOSED
4. Call `execute(fn)` — fails, count=4, state=CLOSED
5. Call `execute(fn)` — fails, count=5, state=OPEN
6. Call `execute(fn)` — throws `CircuitOpenError` (fn not called)

### Expected Result
- After 5 failures: state=OPEN
- 6th call throws `CircuitOpenError` without invoking the wrapped function
- Circuit breaker `stats.state === "open"`

### Actual Result (v1.1.0)
Pass

---

## TC-004: Circuit Breaker — OPEN to HALF-OPEN to CLOSED After Recovery

**Test File:** `src/__tests__/circuit-breaker.test.ts`
**Level:** Unit
**Module:** Circuit Breaker
**Requirement:** SRS-013

### Preconditions
- Circuit breaker in OPEN state (from TC-003)
- `jest.useFakeTimers()` active, `resetTimeoutMs: 60000`

### Steps
1. Advance fake timers by 60 001 ms — circuit transitions to HALF-OPEN
2. Call `execute(fn)` where `fn` now succeeds
3. Assert state

### Expected Result
- After timeout: state=HALF-OPEN
- After successful probe: state=CLOSED, `stats.failures === 0`

### Actual Result (v1.1.0)
Pass

---

## TC-005: Config Hot-Reload — Bridge Restarts on configChanged

**Test File:** `src/__tests__/bridge-reload.test.ts`
**Level:** Integration
**Module:** Bridge Orchestrator + Config Module
**Requirement:** SRS-001 (config reload without container restart)

### Preconditions
- Bridge is running (state has active prusaClient, camera, agent)
- `__setStateForTest()` used to inject mock components

### Steps
1. Set up mock `stopBridge` and `startBridge` spies
2. Emit `configEmitter.emit("configChanged")`
3. Assert call order

### Expected Result
- `stopBridge()` called before `startBridge()`
- `loadConfig()` called after `stopBridge()` completes
- Bridge reinitialises with new config values

### Actual Result (v1.1.0)
Pass

---

## TC-006: Print Command Dispatch — start_printer_local_print Passthru ACK

**Test File:** `src/__tests__/obico-agent.test.ts`
**Level:** Unit
**Module:** Obico Agent
**Requirement:** SRS-017 (print command dispatch), SRS-004 (ref-matched ACK)

### Preconditions
- Mock WebSocket server running in-process
- `PrusaLinkCommandDispatcher` mock with `startPrint` spy
- Agent connected and authenticated

### Steps
1. Mock WS server sends: `{ passthru: { ref: "ref-001", target: "Printer", func: "start_printer_local_print", kwargs: { gcode_file_id: 5 } } }`
2. Agent resolves file name from `gcode_file_id: 5` to `"benchy.gcode"`
3. Agent calls `dispatcher.startPrint("benchy.gcode")`
4. Agent sends back passthru ACK over WebSocket

### Expected Result
- `dispatcher.startPrint` called with resolved filename
- WebSocket message sent: `{ passthru: { ref: "ref-001", ret: null } }`

### Actual Result (v1.1.0)
Pass

---

## TC-007: SSRF Mitigation — file_downloader.download Rejects External URL

**Test File:** `src/__tests__/obico-agent.test.ts`
**Level:** Unit
**Module:** Obico Agent
**Requirement:** SRS-018 (SSRF mitigation)

### Preconditions
- Agent configured with `obicoServerUrl: "http://obico.local"`
- Mock WS server running

### Steps
1. Mock WS server sends: `{ passthru: { ref: "ref-002", func: "file_downloader.download", kwargs: { url: "http://attacker.example.com/malicious.gcode" } } }`
2. Agent checks origin of URL against configured `obicoServerUrl`
3. Origin mismatch detected

### Expected Result
- `fetch` is NOT called with the attacker URL
- Passthru ACK sent with error: `{ passthru: { ref: "ref-002", ret: { error: "SSRF check failed" } } }`

### Actual Result (v1.1.0)
Pass

---

## TC-008: Obico Reconnect — Exponential Backoff Delays

**Test File:** `src/__tests__/obico-agent.test.ts`
**Level:** Unit
**Module:** Obico Agent
**Requirement:** SRS-007 (automatic reconnect within 60 s)

### Preconditions
- `jest.useFakeTimers()` active
- WebSocket connect mock fails first 3 times, succeeds on 4th attempt

### Steps
1. Agent calls `connect()` — fails
2. Assert delay before retry 1 = 1 000 ms (base)
3. Assert delay before retry 2 = 2 000 ms
4. Assert delay before retry 3 = 4 000 ms
5. 4th attempt succeeds — agent connected

### Expected Result
- Delays follow `baseDelay * 2^attempt`: 1 s, 2 s, 4 s
- Successful reconnect on 4th attempt
- Health state transitions: DOWN to HEALTHY

### Actual Result (v1.1.0)
Pass

---

## TC-009: PrusaLink Client — GET /api/v1/job Returns 204 (Idle)

**Test File:** `src/__tests__/prusalink.test.ts`
**Level:** Unit
**Module:** PrusaLink Client
**Requirement:** SRS-003 (job status polling)

### Preconditions
- `global.fetch` mocked to return 204 No Content for `/api/v1/job`

### Steps
1. Call `client.getJob()`
2. Assert return value

### Expected Result
- `getJob()` returns `null` (no active job)
- No error thrown — 204 is a valid response

### Actual Result (v1.1.0)
Pass

---

## TC-010: Files API — Upload Uses multer diskStorage (No OOM)

**Test File:** `src/__tests__/files-routes.test.ts`
**Level:** Integration (HTTP route)
**Module:** Files API + PrusaLink Client
**Requirement:** SRS-016 (file upload up to 200 MB without OOM)

### Preconditions
- Supertest client connected to Express app
- `createPrusaLinkClient` mocked
- A test `.gcode` file available as Buffer

### Steps
1. POST `/api/files/` with `multipart/form-data`, `file` field = test gcode Buffer
2. Assert multer wrote file to `/tmp` (not memory)
3. Assert `client.uploadFile()` called with the tmp file path
4. Assert response: 201 `{ ok: true, name: "test.gcode" }`

### Expected Result
- File written to disk (`/tmp/upload-{ts}-test.gcode`), not held in memory
- `uploadFile()` receives the disk path
- HTTP 201 returned

### Actual Result (v1.1.0)
Pass
