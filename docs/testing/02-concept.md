# 02: Test Concept

**Document ID:** TEST-02
**Standard:** ISO/IEC 29119-3
**Version:** 1.1.0

---

## 1. Unit Test Approach

### 1.1 TDD Cycle

For all three core modules (Config, PrusaLink Client, Obico Agent), tests are written before implementation:

```
1. Define module interface (TypeScript export signatures)
2. Write failing test (RED) — describe the expected behaviour
3. Run test → confirm it fails
4. Implement minimal code to pass (GREEN)
5. Run test → confirm it passes
6. Refactor without breaking tests (REFACTOR)
7. Commit with message: feat(phase-N): implement [module]
```

Each test file is co-located with the module in `src/__tests__/` and follows the naming convention `{module}.test.ts`.

### 1.2 Module-Specific Approach

#### Config Module (`src/__tests__/config.test.ts`)

- File system (`fs/promises`) is mocked — no real file I/O in tests.
- Tests verify: `loadConfig()` parses valid JSON, throws on missing file, throws on invalid JSON.
- `saveConfig()` merges existing config and writes atomically (mock verifies write call).
- `isConfigured()` returns false when file absent or required fields missing.

#### PrusaLink Client (`src/__tests__/prusalink.test.ts`)

- `global.fetch` is mocked via `jest.spyOn`.
- Tests verify Digest Auth header generation (challenge-response round-trip).
- Job state tests include 204 response (idle — no active job) as a first-class case.
- Mutation tests (pause, resume, cancel, startPrint, uploadFile, deleteFile) verify correct HTTP method, path, and body.
- `testConnection()` verifies it calls `/api/v1/info` and parses `hostname`.

#### Obico Agent (`src/__tests__/obico-agent.test.ts`)

- A mock WebSocket server (`ws` library) runs in-process during tests.
- Tests verify: connection with `Authorization: bearer {apiKey}` header.
- Pairing flow: `waitForPairing()` polls `/api/v1/octo/verify/` with correct `?code=` query parameter.
- Passthru dispatch: `pause`, `resume`, `cancel` are forwarded to the `PrusaLinkCommandDispatcher`.
- Print commands: `start_printer_local_print` resolves file name and calls `startPrint()`.
- `file_downloader.download`: SSRF check is tested (origin mismatch → rejected).
- ACK: ref-matched response is sent after successful dispatch.
- Reconnect: exponential backoff is tested via fake timers (`jest.useFakeTimers`).

#### Circuit Breaker (`src/__tests__/circuit-breaker.test.ts`)

- State machine is tested exhaustively: CLOSED → OPEN (after N failures), OPEN → HALF-OPEN (after timeout), HALF-OPEN → CLOSED (on success), HALF-OPEN → OPEN (on failure).
- `CircuitOpenError` is thrown in OPEN state without calling the wrapped function.
- Fake timers used for reset timeout.

#### Retry (`src/__tests__/retry.test.ts`)

- Exponential backoff formula verified: delays are `baseDelay * 2^attempt`, capped at `maxDelay`.
- Retries stop on success (resolve) or when max attempts reached.
- Fake timers used to avoid real delays.

---

## 2. Integration Test Approach

### 2.1 Config Hot-Reload (`src/__tests__/bridge-reload.test.ts`)

- `configEmitter` is triggered manually in tests.
- Verifies that `stopBridge()` is called before `startBridge()`.
- Verifies new config is loaded after reload.
- Uses `__setStateForTest()` and `__setCurrentConfigForTest()` test helpers exported from `src/bridge.ts`.

### 2.2 Component Reconnect (`src/__tests__/bridge-reconnect.test.ts`)

- Calls `reconnectComponent("prusalink" | "obico" | "camera")`.
- Verifies the component's stop + start sequence.
- Invalid component names are rejected with an error.

### 2.3 Graceful Shutdown (`src/__tests__/bridge-shutdown.test.ts`)

- Simulates `SIGTERM` by calling `stopBridge(server)` directly.
- Verifies ffmpeg kill, WebSocket close, HTTP server close — in correct order.
- `hardTimeout.unref()` is verified not to block the Jest process.

### 2.4 Files API Routes (`src/__tests__/files-routes.test.ts`)

- Uses Supertest to send HTTP requests to the Express router.
- Mocks `createPrusaLinkClient` to avoid real PrusaLink calls.
- Tests: list files (200), upload (201), start print (200), delete (200).
- Tests: missing file in upload (400), PrusaLink failure (502).

---

## 3. Hardware-UAT Approach

### 3.1 Environment

| Component | Details |
|-----------|---------|
| Printer | Prusa Core One, Buddy board, PrusaLink enabled |
| Camera | Buddy3D integrated camera, RTSP at `rtsp://[ip]/live` |
| Obico | Self-hosted Obico server (Docker, LAN) |
| Bridge | Built from source, `npm run build:all && npm run start:backend` |
| Network | LAN only, no external internet required |

### 3.2 UAT Execution Checklist

Hardware-UAT is performed before every release tag. The tester follows these steps:

1. **Setup Wizard** — complete all 4 steps, verify dashboard loads with live status.
2. **Camera stream** — open Obico control panel, verify WebRTC stream appears.
3. **Pause / Resume** — start a print, pause from Obico, resume from Obico, verify state in dashboard.
4. **Cancel** — cancel an active print from Obico, verify printer returns to IDLE.
5. **Print from Obico library** — use `file_downloader.download` flow, verify print starts.
6. **Print from control panel** — use `start_printer_local_print` flow.
7. **File upload (dashboard)** — drag-drop a `.gcode` file, verify it appears in the list.
8. **Delete file (dashboard)** — delete a file, verify it is removed.
9. **Start print from dashboard** — click print on a file in FileBrowserCard.
10. **Obico file browser tab** — verify files list appears in Obico via tunnel.

All 10 scenarios were passing for v1.1.0 release.

### 3.3 Regression Strategy

After any code change affecting:
- Obico agent passthru — re-run UAT steps 3-6, 10
- PrusaLink client — re-run UAT steps 3-9
- Camera module — re-run UAT step 2
- Config module — re-run UAT step 1
- Bridge shutdown/reload — perform `docker stop` and restart test

---

## 4. Test Data

| Module | Test Data |
|--------|-----------|
| Config | Inline JSON fixtures in test files; no external files |
| PrusaLink | Mocked API responses derived from `docs/background/prusalink-api.md` |
| Obico Agent | Mocked WebSocket messages derived from `docs/background/obico-agent-protocol.md` |
| Files API | Test G-code file: `test.gcode` (minimal 10-line file for upload tests) |
| Hardware-UAT | Real G-code files from Prusa Slicer (benchy_0.2mm_PETG.gcode) |

---

## 5. Test Environment Configuration

```bash
# Run backend tests (unit + integration)
npm run test:backend

# Run with coverage report
npm run test:backend -- --coverage

# Run specific module tests
npm run test:backend -- --testPathPattern=obico-agent
npm run test:backend -- --testPathPattern=prusalink
npm run test:backend -- --testPathPattern=circuit-breaker
```

Jest configuration is in `jest.config.ts` at the repo root. Reports are written to `reports/` on each run.
