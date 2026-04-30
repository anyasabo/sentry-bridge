# ADR-0009: Frontend Stack — React 19 + Vite + Mantine + react-router + i18next

## Status

Accepted

## Context and Problem Statement

SentryBridge serves a browser-based interface for two flows:

1. **Setup wizard** — a 4-step guided flow (PrusaLink credentials → camera test → Obico pairing → done) that runs once on first start.
2. **Dashboard** — long-lived monitoring UI showing live status, camera preview, health indicators, and a G-code file browser with upload / print / delete operations.

Both share the same SPA delivered as static assets by the Express backend (`src/server.ts`). The frontend must build into a self-contained `frontend/dist/` that the Docker image copies in. What stack should the frontend use?

## Decision Drivers

- **Self-hosted / offline-friendly** — the bridge often runs on a LAN with no internet access for the _user_; the build must produce static assets with no runtime CDN or telemetry.
- **Reasonable component coverage out of the box** — wizard forms, dashboard panels, modals, file lists with sort/search, drag-and-drop upload. We don't want to hand-roll a component library.
- **i18n support** — English and German are first-class (Quality Goal: Operability). Adding more languages later should not require restructuring.
- **Familiarity for contributors** — public open-source project; React + TypeScript is the path of least resistance for drive-by contributors.
- **Build speed** — fast iteration during development, fast Docker build in CI.
- **No SSR / no routing server** — the bridge serves a single SPA from Express; a full Next.js / Remix-style framework would add deployment complexity for no gain.
- **Bundle size** — ships in a single Docker image; reasonable but not extreme constraint (the image already contains Node.js, ffmpeg, Janus).

## Considered Options

1. **React + Vite + Mantine + react-router + i18next** (chosen).
2. **React + CRA / Webpack** — slower builds, abandoned tooling direction.
3. **Vue 3 + Vite + Vuetify / PrimeVue** — fewer drive-by contributors expected vs. React.
4. **Svelte / SvelteKit** — smaller bundles, but smaller component-library ecosystem and fewer contributors.
5. **No framework — vanilla HTML + a few scripts** — wizard forms and the file browser are too rich; would slow development.

## Decision Outcome

Chosen: **Option 1 — React + Vite + Mantine + react-router-dom + i18next + react-i18next**.

Concrete pinning (verified against `frontend/package.json`):

| Concern           | Choice                                                                                                 | Rationale                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Framework         | **React 19** + TypeScript                                                                              | Largest contributor pool; first-class TypeScript ecosystem.                                                                      |
| Build             | **Vite 8** (`@vitejs/plugin-react`)                                                                    | Fast dev server, fast production builds, simple config.                                                                          |
| Component library | **Mantine 9** (`@mantine/core`, `@mantine/hooks`)                                                      | Wide component coverage (Stepper, Table, Modal, Dropzone, Notifications) without per-component installs; first-class TypeScript. |
| Icons             | **`@tabler/icons-react`**                                                                              | Pairs with Mantine's design language; tree-shakeable.                                                                            |
| Routing           | **`react-router-dom` 7**                                                                               | Wizard / dashboard split; client-side routing only — no SSR.                                                                     |
| i18n              | **`i18next` + `react-i18next` + `i18next-browser-languagedetector`**                                   | EN/DE support; auto-detect browser language; resource bundles per language under `frontend/src/i18n/`.                           |
| Backend serving   | **Express 5 static assets** at `/`, API at `/api/*` (`src/server.ts`)                                  | Single-port deployment; no separate frontend server.                                                                             |
| Dev proxy         | **Vite proxy** (`vite.config.proxy.ts`, `npm run dev:frontend:proxy`) forwards `/api/*` to the backend | No CORS during local development; same URL shape as production.                                                                  |

## Consequences

- **Positive:**
  - Fast development cycle: `npm run dev:all` runs backend (`ts-node` watch) and Vite dev server in parallel, hot-reload on both.
  - Mantine covers ~all UI surfaces (Stepper for wizard, Modal for confirmations, Dropzone for upload, Table for file browser) without per-component selection.
  - Production build is a static bundle copied into the Docker image — no runtime dependency on any external CDN.
  - i18next resources are simple JSON, easy for contributors to add a new language.
- **Negative:**
  - Mantine 9 is a recent major; breaking changes between minors require attention during upgrades.
  - React 19 + Vite 8 + TypeScript 6 are bleeding-edge versions; some plugins/types may lag during dependency bumps.
  - Bundle size is ~600 KB minified (gzip ~180 KB) — fine for LAN deployment, larger than a vanilla approach.
- **Constraint established:**
  - Pages live under `frontend/src/pages/` (one per route); reusable UI under `frontend/src/components/`; hooks under `frontend/src/hooks/`; i18n under `frontend/src/i18n/`. Don't add nested page routers.
  - All user-facing strings go through `t()` — no hardcoded English in components.
  - Backend stays headless: no template rendering, no server-side React. Express only serves the prebuilt SPA and the JSON API.

## Related Decisions

- ADR-0001 — Docker Single-Container Model (frontend builds into the same image).
- ADR-0006 — Configuration Stored as JSON File on Docker Volume (config UI consumes the same shape).
