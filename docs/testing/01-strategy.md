# 01: Test Strategy

**Document ID:** TEST-01
**Standard:** ISO/IEC 29119-2
**Version:** 1.1.0

---

## 1. Scope

This strategy covers testing for SentryBridge — the backend Node.js/TypeScript service and its four core modules (Config, PrusaLink Client, Camera, Obico Agent). It does not cover the React frontend (component testing deferred to a future phase).

---

## 2. Test Levels

### 2.1 Unit Tests

**Scope:** Individual modules and functions in isolation.
**Target modules:**
- `src/config/` — Config module: `loadConfig()`, `saveConfig()`, `isConfigured()`
- `src/prusalink/` — PrusaLink Client: all HTTP operations
- `src/obico/` — Obico Agent: WebSocket protocol, pairing, passthru dispatch
- `src/lib/` — Circuit Breaker, Retry, Health Monitor

**Isolation strategy:** External dependencies are mocked:
- PrusaLink HTTP API — mocked via `jest.fn()` / `jest.spyOn(global, 'fetch')`
- Obico WebSocket — mock WS server (using `ws` library in test mode)
- ffmpeg process — mocked child process spawn
- File system (`fs`) — mocked via `jest.mock('node:fs/promises')`

**Framework:** Jest with ts-jest
**Location:** `src/__tests__/*.test.ts`

### 2.2 Integration Tests

**Scope:** Module interactions, especially the Bridge Orchestrator coordinating multiple modules.
**Target scenarios:**
- Config hot-reload triggering bridge teardown and reinit
- Bridge component reconnect (prusalink, obico, camera)
- Graceful shutdown sequence (SIGTERM → ffmpeg kill → WS close → server close)
- OctoPrint-compatible files API routes (`/api/files/`)

**Integration test files:**
- `bridge-reload.test.ts` — hot-reload flow
- `bridge-reconnect.test.ts` — component reconnect
- `bridge-shutdown.test.ts` — SIGTERM sequence
- `files-routes.test.ts` — files API

**Framework:** Jest + Supertest (for HTTP routes)

### 2.3 Hardware-UAT (User Acceptance Testing)

**Scope:** End-to-end flows on physical hardware.
**Hardware:** Prusa Core One with Buddy3D camera, self-hosted Obico server.
**Execution:** Manual, performed before each release tag.

**UAT scenarios (v1.1.0, all passed):**
1. Setup wizard: PrusaLink → camera preview → Obico pairing → dashboard
2. Live camera stream in Obico control panel (WebRTC via Janus)
3. Pause/Resume/Cancel from Obico control panel
4. Start print from Obico file library (`file_downloader.download`)
5. Start print from Obico control panel (`start_printer_local_print`)
6. File upload from Dashboard (drag-drop)
7. Delete file from Dashboard
8. Start print from Dashboard FileBrowserCard
9. Obico file browser tab (http.tunnelv2 passthru)
10. Display name shown correctly (not 8.3 short format)

---

## 3. Tools and Infrastructure

| Tool | Version | Purpose |
|------|---------|---------|
| Jest | 29.x | Test runner and assertion library |
| ts-jest | 29.x | TypeScript transformer for Jest |
| @jest/globals | 29.x | Jest globals (describe, it, expect) |
| jest-html-reporter | — | HTML report generation (`reports/test-report.html`) |
| jest-junit | — | JUnit XML output (`reports/junit.xml`) for CI |
| ws | 8.x | Mock WebSocket server in tests |
| supertest | — | HTTP route testing |

---

## 4. Coverage Goals

| Scope | Goal | Current (v1.1.0) |
|-------|------|-----------------|
| Config module | 100% line coverage | Achieved |
| PrusaLink Client | 100% line coverage | Achieved |
| Obico Agent | >90% line coverage | Achieved |
| Circuit Breaker | 100% state transitions | Achieved |
| Retry module | 100% backoff cases | Achieved |
| Bridge Orchestrator | >80% branch coverage | Achieved |
| React Frontend | Not targeted | Not measured |

**Overall:** 210+ tests, all passing on main branch.

---

## 5. Test Execution

```bash
# Run all backend tests
npm run test:backend

# Run in watch mode (during development)
npm run test:backend -- --watch

# Run a specific test file
npm run test:backend -- --testPathPattern=obico-agent

# Run all tests (backend + any future frontend tests)
npm run test:all
```

Reports are written to `reports/` (gitignored):
- `reports/test-report.html` — human-readable
- `reports/junit.xml` — CI-compatible

---

## 6. TDD Policy

**TDD is mandatory** for the three testable backend modules: Config, PrusaLink Client, and Obico Agent.

Development order enforced:
1. Write the module interface (TypeScript types/exports)
2. Write failing tests that describe expected behaviour
3. Implement until all tests pass
4. Refactor without breaking tests

This policy was applied throughout v1.0 and v1.1.0 development and is documented in `CLAUDE.md`.

---

## 7. Known Gaps

| Gap | Rationale |
|-----|-----------|
| React frontend component tests | Mantine v9 + Vite setup deferred; E2E tooling (Playwright) not yet configured |
| Performance tests (frame throughput) | LAN-only deployment; load testing not a priority for v1.x |
| Security penetration testing | Acknowledged in NFR-S01; manual review performed for SSRF/EoP mitigations |
