# Ever Works Desktop Node (`apps/desktop-node`)

Thin Electron shell that registers **this machine** as a platform execution node, then runs the
node runtime with a small status UI. It is the desktop packaging of the "thin agent" role — not a
second full platform UI (PRD §3.2).

All enrollment, heartbeat and capability logic comes from **`ever-works-node`**'s shared core; this
app contributes the wizard, the status window, the tray and the credential-owning main process.

## What it does

1. **Setup wizard** (first launch): welcome → choose API host (local desktop install /
   self-hosted URL / cloud) → paste the one-time enrollment token → enroll → running.
2. **Status window**: node id, API host, last heartbeat, capability tags, connection state and a
   live log pane, with connect / disconnect / un-enroll.
3. **Tray**: status summary, connect, disconnect, quit. Closing the window minimizes to tray and
   keeps the node heartbeating.
4. **Auto-start**: an already-enrolled machine starts heartbeating on launch, without the window
   ever being opened.

## Layout

- `src/main/` — Electron main process (single-instance lock, window + tray, IPC wiring, secure
  defaults: `contextIsolation` on, `nodeIntegration` off, sandboxed preload).
- `src/main/identity.ts` — the credential-free projections that cross the IPC bridge, plus
  **main-side re-validation** of enrollment requests (a renderer is never a trust boundary).
- `src/main/preload.ts` — minimal typed IPC bridge (`window.everworksNode`).
- `src/shared/` — IPC contract + status labels shared across processes.
- `src/renderer/` — small React/Vite UI: wizard (`wizard/steps.ts` holds all sequencing) + status.

## Security posture

- **The heartbeat secret never crosses the IPC bridge.** It is minted during enrollment, written by
  the main process to `userData/node-config.json` (0600 on POSIX), and the renderer only ever
  learns _that_ a credential exists. `toIdentityView` is the choke point, and a unit test asserts
  the serialized payload cannot contain it.
- The token travels renderer → main only (write-only across the bridge) and is never echoed back.
- The renderer bundle contains **no Node built-ins**: `shared/ipc-contract.ts` imports
  `ever-works-node` type-only, and the two credential-length constants are deliberately duplicated
  as literals rather than value-imported, so `node:child_process`/`node:fs` can never be dragged
  into a browser bundle.
- This shell renders only its own local bundle — it never embeds the platform web UI, so every
  external URL is handed to the OS browser.

## Commands

```bash
pnpm --filter ever-works-desktop-node build   # tsc type-check + main-process build + vite renderer build
pnpm --filter ever-works-desktop-node test    # vitest unit tests
pnpm --filter ever-works-desktop-node dev     # vite dev server for the UI (browser, no bridge)
pnpm --filter ever-works-desktop-node start   # electron . (requires the Electron binary, see below)
pnpm --filter ever-works-desktop-node dist    # electron-builder packages (win/mac/linux, unsigned)
```

`build` depends on `ever-works-node` being built first — turbo's `^build` ordering handles that;
building this app directly requires `pnpm build:node` first.

## Notes

- **Electron binary**: pnpm ignores install scripts by default in this repo, so the Electron binary
  is not downloaded automatically. Before `start`/`dist`, run `pnpm approve-builds` and allow
  `electron` (one-time), or run `node node_modules/electron/install.js`.
- **Excluded from the default root build**: like `apps/docs` and `apps/desktop`, this app is
  filtered out of root `pnpm build` / `pnpm build:apps`; build it explicitly with
  `pnpm build:desktop-node` (root `pnpm build:all` includes it).
- **Packaging is unsigned by design** — signing + auto-update channels are a later hardening
  milestone of the Desktop epic.
- **Un-enroll is local only**: it forgets this machine's credential; the node row stays in the
  Fleet page until an admin revokes or deletes it there.

## Follow-ups

- Wizard steps 3–4 of PRD §3.2 (capability opt-in, resource limits) slot into `wizard/steps.ts`'s
  `computeStepList` without new machinery — they need the corresponding Fleet API fields first.
- Electron e2e (smoke-launch the shell, drive the wizard via Playwright's `_electron`) lands with
  the packaging CI milestone; unit tests cover the pure logic today.
