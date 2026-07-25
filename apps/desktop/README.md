# Ever Works Desktop App (`apps/desktop`)

All-in-one Electron shell for running the full Ever Works platform locally:

1. **Install wizard** (first launch): prerequisite check (Node.js >= 22, pnpm, optional Docker) →
   job-runtime selection (BullMQ · pg-boss · Temporal · Trigger.dev · Inngest — the platform's
   `job-runtime-*` plugin family) → env file generation (+ optional
   `docker compose -f docker-compose.infra.yml up -d`) → service boot.
2. **Service supervisor**: starts/stops the local API (:3100) and web (:3000) as child processes
   with restart-on-crash backoff, log ring buffers and `/api/health` polling; controllable from a
   tray menu.
3. **Embedded web UI**: once healthy, the main window loads `http://localhost:3000` so the
   existing web onboarding wizard runs as-is.

## Layout

- `src/main/` — Electron main process (single-instance lock, window + tray, IPC wiring, secure
  defaults: `contextIsolation` on, `nodeIntegration` off, sandboxed preload).
- `src/main/preload.ts` — minimal typed IPC bridge (`window.everworks`).
- `src/services/` — pure, unit-tested logic: `process-manager.ts`, `runtime-setup.ts`,
  `prereq-check.ts`, `health.ts`.
- `src/renderer/` — small React/Vite UI for the pre-boot wizard + status screen only.
- `src/shared/` — IPC contract + runtime catalog shared across processes.

## Commands

```bash
pnpm --filter ever-works-desktop build   # tsc type-check + main-process build + vite renderer build
pnpm --filter ever-works-desktop test    # vitest unit tests
pnpm --filter ever-works-desktop dev     # vite dev server for the wizard UI (browser, no bridge)
pnpm --filter ever-works-desktop start   # electron . (requires the Electron binary, see below)
pnpm --filter ever-works-desktop dist    # electron-builder packages (win/mac/linux, unsigned)
```

## Notes

- **Electron binary**: pnpm ignores install scripts by default in this repo, so the Electron
  binary is not downloaded automatically. Before `start`/`dist`, run `pnpm approve-builds` and
  allow `electron` (one-time), or run `node node_modules/electron/install.js`.
- **Excluded from the default root build**: like `apps/docs`, this app is filtered out of root
  `pnpm build` / `pnpm build:apps` to keep the platform build lean; build it explicitly with the
  filter commands above (root `pnpm build:all` includes it).
- **Repo root resolution**: the supervisor runs services from the monorepo checkout (two levels
  up in development); packaged installs set `EVER_WORKS_REPO_ROOT`.
- **Packaging is unsigned by design** — signing + auto-update channels are a later hardening
  milestone of the Desktop epic.

## Follow-ups

- Electron e2e (smoke-launch the shell, drive the wizard via Playwright's `_electron`) is
  deliberately not part of this scaffold — unit tests cover the pure logic; an e2e suite lands
  with the packaging CI milestone.
- Bundled dist builds of API/web (no repo checkout required) per PRD M6.
