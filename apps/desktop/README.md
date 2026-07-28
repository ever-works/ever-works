# Ever Works Desktop App (`apps/desktop`)

Electron shell for Ever Works. It runs in one of two **modes**, chosen in the first-launch install
wizard:

- **Local stack** (`local-stack`) — the all-in-one install: the app supervises its own API (:3100)
  and web (:3000) services, with an install wizard for prerequisites, job runtime and database.
- **Client** (`remote-client`) — the app runs nothing locally and connects to an Ever Works
  instance that already exists somewhere else (your self-hosted deployment, a team server, the
  hosted platform). The window becomes a native client for that instance.

## Wizard flow

```
local-stack   welcome → mode → prereq → runtime → env → boot → open
remote-client welcome → mode → remote → open
```

1. **mode** — pick local stack vs. client. Local stack is disabled (with the reason shown) when the
   install has neither a bundled runtime nor a monorepo checkout.
2. **remote** (client mode) — enter the instance URL; the API URL is derived (`app.<domain>` →
   `api.<domain>`, otherwise the same base URL) and stays editable. `Test connection` probes
   `<apiUrl>/api/health` and only a successful probe unlocks the step. Plain-HTTP instances are
   accepted but flagged. URLs carrying credentials are rejected outright.
3. **prereq / runtime / env / boot** (local stack) — unchanged: prerequisite check → job-runtime
   selection (BullMQ · pg-boss · Temporal · Trigger.dev · Inngest · Fleet nodes) → env file
   generation (+ optional `docker compose -f docker-compose.infra.yml up -d`) → service boot.

## Self-contained installs

Installers ship a **runtime payload** at `resources/app-bundle`, staged by
`scripts/prepare-bundle.js`:

```
bundle/
  bundle-manifest.json   # schema, version, api/web entry points
  api/                   # `pnpm deploy` output: dist/ + production node_modules (+ plugins/)
  web/                   # Next.js standalone server + .next/static + public/
```

`src/services/runtime-layout.ts` resolves, in order:

1. the bundled payload next to the packaged app,
2. an explicit `EVER_WORKS_REPO_ROOT` checkout,
3. the development checkout two levels above the app path,

and reports `unavailable` (with the reason) when none apply, which the wizard surfaces instead of
spawning a command that will never exist.

Bundled services run on **Electron's own Node.js** (`ELECTRON_RUN_AS_NODE=1`), so a bundled install
needs no monorepo checkout, no Node.js and no pnpm on the machine — the prerequisite step
downgrades both toolchain checks to informational in that case.

When the platform build output is not staged (fast PR packaging runs), `prepare-bundle.js` writes a
`bundled: false` manifest and warns loudly; packaging still succeeds and the resulting app offers
client mode.

## Layout

- `src/main/` — Electron main process (single-instance lock, window + tray, IPC wiring, secure
  defaults: `contextIsolation` on, `nodeIntegration` off, sandboxed preload).
- `src/main/preload.ts` — minimal typed IPC bridge (`window.everworks`).
- `src/services/` — pure, unit-tested logic: `process-manager.ts`, `runtime-layout.ts`,
  `remote-connection.ts`, `runtime-setup.ts`, `prereq-check.ts`, `health.ts`, `signing-plan.ts`.
- `src/renderer/` — small React/Vite UI for the pre-boot wizard + status screen only.
- `src/shared/` — IPC contract + runtime catalog shared across processes.
- `scripts/` — `prepare-bundle.js` (runtime payload staging) and `package-app.js`
  (electron-builder + code signing).

## Commands

```bash
pnpm --filter ever-works-desktop build     # tsc type-check + main-process build + vite renderer build
pnpm --filter ever-works-desktop test      # vitest unit tests
pnpm --filter ever-works-desktop dev       # vite dev server for the wizard UI (browser, no bridge)
pnpm --filter ever-works-desktop start     # electron . (requires the Electron binary, see below)
pnpm --filter ever-works-desktop bundle    # stage the self-contained runtime payload
pnpm --filter ever-works-desktop package   # electron-builder with the resolved signing plan
pnpm --filter ever-works-desktop dist      # electron-builder directly (no signing plan resolution)
```

A fully self-contained installer is `build` → platform build with `NEXT_BUILD_OUTPUT=standalone` →
`bundle` → `package`.

## Code signing

Certificates never live in the repository. `src/services/signing-plan.ts` (unit-tested) resolves a
plan from the environment; `scripts/package-app.js` applies it and
`.github/workflows/desktop-build.yml` supplies the values from repository secrets:

| Secret                                 | Effect                                     |
| -------------------------------------- | ------------------------------------------ |
| `DESKTOP_WINDOWS_CERTIFICATE_BASE64`   | Windows signing (with the password secret) |
| `DESKTOP_WINDOWS_CERTIFICATE_PASSWORD` | ⇧                                          |
| `DESKTOP_MACOS_CERTIFICATE_BASE64`     | macOS signing (with the password secret)   |
| `DESKTOP_MACOS_CERTIFICATE_PASSWORD`   | ⇧                                          |
| `DESKTOP_APPLE_ID`                     | macOS notarization (all three required)    |
| `DESKTOP_APPLE_APP_SPECIFIC_PASSWORD`  | ⇧                                          |
| `DESKTOP_APPLE_TEAM_ID`                | ⇧                                          |

With any of them missing the build **degrades to unsigned** and prints a loud `::warning` naming the
missing secrets (never their values). That keeps forks and pull requests — which never receive
secrets — building. Linux artifacts are unsigned by design.

## CI

`.github/workflows/desktop-build.yml` builds Windows, macOS and Linux installers on every push and
pull request that touches `apps/desktop/**`, and uploads them as workflow artifacts
(`ever-works-desktop-<os>`). The bundled runtime payload is staged on the Linux cell for pushes;
`workflow_dispatch` with `bundle_runtime: true` stages it on all three.

## Notes

- **Electron binary**: pnpm ignores install scripts by default in this repo, so the Electron
  binary is not downloaded automatically. Before `start`/`package`, run `pnpm approve-builds` and
  allow `electron` (one-time), or run `node node_modules/electron/install.js`.
- **Excluded from the default root build**: like `apps/docs`, this app is filtered out of root
  `pnpm build` / `pnpm build:apps` to keep the platform build lean; build it explicitly with the
  filter commands above (root `pnpm build:all` includes it).

## Follow-ups

- Electron e2e (smoke-launch the shell, drive the wizard via Playwright's `_electron`) — unit tests
  cover the pure logic today.
- Auto-update channels on top of the now-signed artifacts.
