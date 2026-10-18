# FL-04 — Sessions on computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths and a **Test** line (Constitution VI). Work top to bottom; tasks marked `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-04-sessions-on-computers`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run everything with `pnpm` from the root unless said otherwise.
- Migrations are **authored** from `apps/api/`; the API self-applies them on boot. Timestamps are the FL-04 slots (CONTRACTS §13); re-stamp before merge if `develop` moved.
- Runners: `packages/contracts`, `apps/node`, `apps/web` unit, `apps/cli` → **Vitest**; `packages/agent`, `apps/api` → **Jest**; `apps/web` e2e → **Playwright**.
- Prerequisites: FL-02 merged (`--manage`, link gateway, viewer attach, relay bus), FL-01 merged (module registry, role derivation). Tasks that touch their files say so.
- Before every PR: run the program's reference-tool name check over `docs apps packages` (README §7 rule 16 — the tools that informed this design are never named in this repository); it must print nothing.
- Add tasks at the bottom; never renumber. Commit style `feat(fleet-sessions): …`, `test(fleet-sessions): …`, `chore(i18n): …`.

---

# PHASE 1 — Owner sessions and the daemon

## P1.A — Contracts

- [ ] **T-01**. Add the session contracts at `packages/contracts/src/fleet/fleet-sessions.types.ts`: kind, provider, state, outcome, ended-reason and recording-state unions (each with a `readonly` array + `isX` guard, as `fleet-jobs.types.ts` does), `FleetSessionView`, `FleetSessionStartRequest`, `FleetSessionAttachTokenResponse`, and the limits `FLEET_SESSION_MAX_OWNER_PER_NODE = 8`, `FLEET_SESSION_MAX_VIEWERS = 5`, `FLEET_SESSION_SCROLLBACK_LINES = 10_000`, `FLEET_SESSION_REPLAY_LINES = 2_000`, `FLEET_SESSION_DRAIN_WARNING_SEC = 60`, `FLEET_SESSION_END_GRACE_MS = 5_000`. Export from `packages/contracts/src/fleet/index.ts`.
    - **Test**: `packages/contracts/src/fleet/__tests__/fleet-sessions.spec.ts` — every union has a guard that rejects a foreign string; limits equal CONTRACTS §10.
- [ ] **T-02** (parallel). Append the nine CONTRACTS §7 session actions `node.session.start|attach|input|answer|rename|restart|end|recording.start|recording.stop` to `FleetAuditAction` and `FLEET_AUDIT_ACTIONS` in `packages/contracts/src/fleet/fleet-panic.types.ts` (after `'computer.profile-reset'`, `:114` and `:148`); FL-05 writes `answer` and does not re-add it.
    - **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts` — the nine actions are present and the array has no duplicates.
- [ ] **T-03** (parallel). Add the `session` family message types (`session.start/attach/input/resize/end/rename/restart` — CONTRACTS §3.3; `session.answer` is FL-05's — and the node→platform channel-0 `session.event`, `session.list` — §3.2–3.3) to FL-02's `packages/contracts/src/fleet/fleet-link.types.ts`, and `sessions` to the known capability tags in `packages/contracts/src/fleet/fleet-node.types.ts`; add the optional heartbeat `daemon { state, reason?, sessions }` block to `FleetHeartbeatRequest` (`:532`) in the newest tier (spec §8b default until CONTRACTS §1.1 lists it).
    - **Test**: extend FL-02's link types spec — a `session.event` with an unknown `event` is rejected by its guard; the conformance fixture `packages/contracts/fixtures/fleet-node-contract.v1.json` still validates (the block is optional).

## P1.B — Schema and domain

- [ ] **T-04**. Create `packages/agent/src/entities/fleet-session.entity.ts` with the plan §4.1 columns (string unions in `varchar`, `PortableDateColumn`, raw `uuid` columns, FKs by migration), class-level indexes, and a header comment stating that `daemonSessionId` is the node's key and `id` the platform's. Register in `packages/agent/src/database/_entities-inventory.ts` (beside `ComputerSession`, `:157`/`:436`) and `_entity-names.ts` (`:81`).
    - **Test**: `packages/agent/src/entities/__tests__/fleet-session.entity.spec.ts` — metadata loads; every column has a doc comment naming its writer.
- [ ] **T-05**. Add `fleetSessionId uuid NULL` to `packages/agent/src/entities/terminal-transcript-chunk.entity.ts`, make `runId` nullable, add the partial unique index on `(fleetSessionId, seq)` and document the "one of the two keys" rule (CONTRACTS R-9).
    - **Test**: extend `packages/agent/src/database/repositories/__tests__/terminal-transcript-chunk.repository.spec.ts` (create if absent) — a chunk with only `fleetSessionId` saves; one with neither is refused by the service guard.
- [ ] **T-06**. Author migration A from `apps/api/`: `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateFleetSessions`, land as `apps/api/src/migrations/1796040000000-CreateFleetSessions.ts`. Hand-check: one `CREATE TABLE`, four indexes, FKs, the transcript-chunk `ADD COLUMN`, `DROP NOT NULL`, check constraint and partial unique index. No `DROP TABLE`, no `ALTER … TYPE`. `down` reverses exactly.
    - **Test**: applies on an empty database and on one with transcript rows; a re-run of `migration:generate` is an empty diff.
- [ ] **T-07**. Write the pure policy at `packages/agent/src/fleet/sessions/fleet-session.policy.ts`: `consentFor(kind)`, `canStart(node, kind, provider, existing)` → typed refusal (`consent_missing|unreachable|unsupported_on_node|limit_exceeded|kill_switch|node_state`), `canAttach(session, viewers, role)`, `transition(state, event)` for `starting→working/ended`, `*→ended(reason)`, `endedReasonFor(evidence)`; no NestJS/TypeORM imports.
    - **Test**: `packages/agent/src/fleet/sessions/__tests__/fleet-session.policy.spec.ts` — a truth table over consent × kind × tag × count ±1 × kill switch × node state; every ended reason produced.
- [ ] **T-08**. Write `packages/agent/src/fleet/sessions/fleet-session.repository.ts` and `fleet-session.service.ts`: `startOwner`, `list`, `get`, `rename`, `end(reason)` (idempotent), `restart` (links `restartOfSessionId`), `applyNodeEvent` (`started|exited|title|activity|lost` → row updates incl. `lastScreen`), `reconcileList` (node's `session.list` vs rows), audit through `FleetAuditService.record()` with `family: 'sessions'`. Refusals are typed values, never bare throws (the `TerminalSessionLauncher` posture). Export `@ever-works/agent/fleet` additions from `packages/agent/src/fleet/index.ts`.
    - **Test**: `packages/agent/src/fleet/sessions/__tests__/fleet-session.service.spec.ts` — start/refuse per code, rename, end idempotent, restart link, `lost` → `ended (node-restart)` with screen, `exited` → `ended (exit)` with code, every audit row written with no input bytes.

## P1.C — The daemon (`apps/node`)

- [ ] **T-09**. Add dependencies to `apps/node/package.json`: `@homebridge/node-pty-prebuilt-multiarch ^0.13.1` (optional, as `pty-local` does), `@xterm/headless ^5.5.0`, `@xterm/addon-serialize ^0.13.0`. Confirm `apps/node/build.js` bundles them and leaves the native prebuild external.
    - **Test**: `pnpm --filter ever-works-node build` emits a `cli.js` that starts with `--help`; `doctor --json` reports `sessions.pty: available|missing`.
- [ ] **T-10**. Write `apps/node/src/core/sessions/daemon/daemon-protocol.ts`: NDJSON op schemas (`hello health list start attach resize rename end screen block-input warn ack-ended watch`), reply/error shapes, and the frame kinds re-exported from `@ever-works/contracts` (`DATA=1 RESIZE=2 EXIT=3 JSON=10 CLOSE=11`).
    - **Test**: `apps/node/src/core/sessions/daemon/__tests__/daemon-protocol.spec.ts` — malformed ops are refused with `invalid`, never thrown.
- [ ] **T-11**. Write `apps/node/src/core/sessions/daemon/session-process.ts`: node-pty spawn with `TERM=xterm-256color`, `COLORTERM=truecolor`, `EVER_WORKS_SESSION_ID`; `end()` = terminate, then kill after `FLEET_SESSION_END_GRACE_MS`; exit code capture; `pty: 'missing'` reported when the prebuild cannot load (no pipe floor).
    - **Test**: `apps/node/src/core/sessions/daemon/__tests__/session-process.spec.ts` — exit code captured, grace honoured, kill after grace, missing prebuild reported not thrown.
- [ ] **T-11a** (parallel). Write `apps/node/src/core/sessions/daemon/screen-grid.ts`: `@xterm/headless` with `scrollback: 10_000`; `replay()` via the serialize addon with `scrollback: 2_000`; terminal queries (DSR, DA, OSC colour) answered by the grid only while no driver is attached; only the newest driver's response-shaped bytes forwarded, others dropped; `plainText(lines)` for the `screen` op.
    - **Test**: `__tests__/screen-grid.spec.ts` — 10 000 lines kept, replay ≤ 2 000, DSR answered only with no driver, newest driver's responses forwarded, plain text has no escapes.
- [ ] **T-12**. Write `attach-fanout.ts`: viewer/driver sets, newest driver sizes the PTY, viewers never resize, slow viewer (write buffer > 1 MiB or stalled 5 s) closed with `CLOSE slow-viewer`, `blockInput(on)` for the kill switch, `warn(seconds)` as a `JSON` notice frame to attached channels.
    - **Test**: `__tests__/attach-fanout.spec.ts` — size follows the newest driver; a stalled viewer is dropped and output continues; blocked input is discarded.
- [ ] **T-13**. Write `apps/node/src/core/sessions/daemon/session-store.ts`: atomic JSON per session (`<stateDir>/sessions/<id>.json`) plus `<id>.screen`, written ≤ 30 s after a change and at exit; `ended` records kept until `ack-ended`; disk-full reported in the record's `warnings`, never fatal.
    - **Test**: `__tests__/session-store.spec.ts` — atomic rename (no partial file on a crash mid-write), screen persisted at exit, ack forgets, disk-full reports and continues.
- [ ] **T-13a**. Write `apps/node/src/core/sessions/daemon/daemon-server.ts` and `daemon-main.ts`: socket/pipe listener, `hello` with token checked before anything else is read, control vs attach connection roles (plan §6.4), the `watch` stream, idle exit after 5 min with no sessions and no node connection, crash log `<stateDir>/daemon.log` with 1 MB rollover, state dir 0700 / `icacls` owner-only.
    - **Test**: `__tests__/daemon-server.spec.ts` — wrong token → connection closed before a second line is read; `start` + `attach` + `end` round trip emits replay, live `DATA` and `EXIT`; `watch` emits `exited`; idle timer fires; a second `hello` on the same connection is refused.
- [ ] **T-14**. Add the hidden `session-daemon` subcommand to `apps/node/src/cli/program.ts` (`--socket --token-file --state-dir`, `hidden: true`) calling `apps/node/src/core/sessions/daemon/daemon-main.ts`; add `sessions` lines to `doctor` (`daemon: running|stopped|failed`, `pty: available|missing`).
    - **Test**: extend `apps/node/src/cli/program.spec.ts` — the subcommand is hidden from `--help` and parses its flags.

## P1.D — Node: supervisor, bridge, launcher, reconciler

- [ ] **T-15**. Write `apps/node/src/core/sessions/daemon-supervisor.ts`: when `manageEnabled || workEnabled`, connect to an alive daemon (token file + `health`) or spawn one detached (`process.execPath cli.js session-daemon …`, `detached: true`, `stdio: 'ignore'`, `windowsHide: true`, `unref()`); health every 10 s; respawn backoff 1 s → 30 s; expose `state()` for the heartbeat `daemon` block and `sessions` tag (`apps/node/src/core/capabilities.ts`, beside the `attended` rule `:315-324`).
    - **Test**: `apps/node/src/core/sessions/__tests__/daemon-supervisor.spec.ts` — connect-or-spawn, respawn with backoff, `sessions` advertised only while health answers; never spawned without a consent.
- [ ] **T-16**. Write `owner-session-launcher.ts`: login shell per OS (`$SHELL -l` / `/bin/zsh -l` / `pwsh -NoLogo` else `powershell.exe -NoLogo`), `claude`/`codex` argv with the optional first message and the `hook-overlay.port.ts` seam (no-op here), refusals `consent_missing` (no `--manage`), `unsupported_on_node` (provider tag absent), `invalid` (cwd missing or outside home/checkouts/extra roots).
    - **Test**: `__tests__/owner-session-launcher.spec.ts` — argv per OS and provider; each refusal with its hint; the overlay seam is called with `(kind, provider, sessionId)`.
- [ ] **T-17**. Write `session-link-bridge.ts` as the link `session` family handler, registered as a node module in FL-02's compile-time array `apps/node/src/core/link/modules/index.ts` (`NodeModule` from `modules/registry.ts`): `channel.open` → consent + kill-switch check → daemon `attach` → frames bridged with the channel prefix; `session.start/end/rename/restart/resize/input` → daemon ops; daemon `watch` → `session.event` on channel 0; FL-02's `link.pause|resume` → `block-input`; FL-02's `link.drain { graceSec }` → `warn 60` then `end(drain)` for owner sessions.
    - **Test**: `__tests__/session-link-bridge.spec.ts` — a viewer-mode channel's input is dropped; frames carry the right channel; `exited` becomes `session.event`; kill switch blocks input without ending.
- [ ] **T-18**. Write `session-reconciler.ts` and wire it into `apps/node/src/core/runtime.ts` after `link.ready`: daemon alive → `session.list`; dead → `session.event lost` per persisted session with its `.screen`, then `ack-ended` when the platform confirms.
    - **Test**: `__tests__/session-reconciler.spec.ts` — both branches; screens attached; ack clears the store.
- [ ] **T-19**. Windows packaging: set `AppKillProcessTree 0` in `apps/node/packaging/windows/install-service.ps1` for the NSSM path and document in `apps/node/packaging/README.md` that the daemon outlives a service restart; add a `doctor` warning when the flag is unset on an installed service.
    - **Test**: extend `apps/node/packaging/windows/install-service.spec.ps1` (or the Pester suite that exists) — the flag is set; `doctor` warns when missing.

## P1.E — API and link family

- [ ] **T-20**. Create `apps/api/src/fleet/sessions/fleet-sessions.controller.ts` (`@Controller('api/fleet')`, `FleetEnabledGuard`, `FLEET_SESSIONS_ENABLED` guard) with the plan §5 routes except recording — including `POST /sessions/:id/restart` (CONTRACTS §11.2; audits `node.session.restart`); DTOs under `apps/api/src/fleet/sessions/dto/`; throttles 10/min start, 30/min attach-token (spec §8b defaults); mount in `apps/api/src/fleet/fleet.module.ts` (`controllers` at `:115`).
    - **Test**: `apps/api/src/fleet/sessions/fleet-sessions.controller.spec.ts` — every refusal's status and hint; audience matrix owner/org-admin/org-member/stranger; cross-user Node 404s like unknown; restart of a live session → `invalid`; throttle decorators present.
- [ ] **T-21**. Create `apps/api/src/fleet-link/families/session.family.ts` beside FL-02's `fleet-link.registry.ts` / `fleet-link.service.ts`: opens `session` channels for attach tokens, forwards viewer frames by role (viewer never inputs), applies `session.event` and `session.list` through `FleetSessionService`, refuses everything with `kill_switch` while the switch is on, and emits the drain sequence from `FleetPanicService` (`apps/api/src/fleet/fleet-panic.service.ts`).
    - **Test**: `apps/api/src/fleet-link/families/session.family.spec.ts` — role enforcement, event application, kill switch, drain warning then end, held input never auto-sent.
- [ ] **T-22**. `POST /sessions/:id/attach-token` mints through FL-02's `FleetLinkAttachService.mint` (there is no generic attach route), and FL-02's viewer gateway `/ws/fleet/session/:id` resolves roles `viewer|driver`, caps viewers at 5, and closes a viewer within 30 s of losing audience membership (membership re-check on the 30 s ping).
    - **Test**: extend FL-02's gateway spec — sixth viewer refused `limit_exceeded`; revoked member closed on the next ping.

## P1.F — Web

- [ ] **T-23**. Extend `apps/web/src/components/terminal/TerminalPane.tsx` and `use-terminal-attach.ts` with an optional `source` (`run` default | `fleet-session`); the new source mints `/api/fleet/sessions/:id/attach-token` and connects to the returned `wsPath`. No existing prop changes.
    - **Test**: extend `TerminalPane.unit.spec.tsx` and `use-terminal-attach` unit spec — default behaviour byte-identical; the new source mints the right URL; viewer role refuses `sendInput`.
- [ ] **T-24**. Add `DASHBOARD_FLEET_SESSION` to `apps/web/src/lib/constants.ts` (beside `DASHBOARD_AGENT_COMPUTER`, `:258`); create `apps/web/src/lib/api/fleet-sessions.ts` and the BFF routes `apps/web/src/app/api/fleet/sessions/route.ts`, `…/[id]/route.ts`, `…/[id]/attach-token/route.ts`, `…/[id]/end/route.ts`, `apps/web/src/app/api/fleet/nodes/[id]/sessions/route.ts` mirroring `apps/web/src/app/api/agents/[id]/computer/sessions/[sessionId]/attach-token/route.ts`.
    - **Test**: `apps/web/src/lib/api/fleet-sessions.unit.spec.ts` — error envelopes pass through with their hints; no token reaches client code before the socket opens.
- [ ] **T-25**. Write `apps/web/src/components/fleet/sessions/sessions.shared.ts` (pure: consent copy, limits, glyph per state, elapsed rule, role transitions, held-input policy, cost sentence per kind) and `SessionCard.tsx` in its compact layout (header + footer only; FL-05 completes the anatomy, R-22).
    - **Test**: `sessions.shared.unit.spec.ts`, `SessionCard.unit.spec.tsx`.
- [ ] **T-26**. Write `SessionsTab.tsx` (live/ended groups, row menu Open/Rename/Copy link/End|Restart), `SessionStateCard.tsx` (consent missing with command + copy, daemon down with diagnosis + Retry, offline with last-seen, limits with lists), `SessionRowMenu.tsx`, `SessionEndDialog.tsx` (the one confirmation text; Agent variant adds the Run line); register the `sessions` tab in `apps/web/src/components/fleet/registry.ts` (FL-01).
    - **Test**: `SessionsTab.unit.spec.tsx` — each state card; End from the row opens the same dialog as the detail.
- [ ] **T-27**. Write `SessionStartDialog.tsx` (computer → who → what → where → first message; owner kinds only in P1; providers greyed by tag; recents from the last 10 sessions' folders; checkouts when FL-14 present; the cost sentence) and wire **New session ▾** into FL-01's computer page header.
    - **Test**: `SessionStartDialog.unit.spec.tsx` — consent gating per kind; provider gating; missing-folder refusal keeps other fields; worktree row hidden without FL-14.
- [ ] **T-28**. Write `apps/web/src/components/fleet/sessions/use-session-attach.ts`: mints the token through the BFF per role, opens the pane's `fleet-session` source, reconnecting state at 3 s without frames, held input (typed while offline) kept client-side and **offered**, never auto-sent, kill-switch banner from the relay's `JSON` notice, role switch (viewer ↔ driver) by re-minting without a page reload, bandwidth counter.
    - **Test**: `use-session-attach.unit.spec.tsx` — reconnecting at 3 s; held input offered and discarded; role switch; kill-switch notice surfaces; a viewer's `sendInput` is a no-op.
- [ ] **T-28a**. Write the detail page `apps/web/src/app/[locale]/(dashboard)/fleet/sessions/[id]/page.tsx` (server component: session, Node, Agent, recording manifest in parallel, each `.catch()`), `SessionDetailClient.tsx`, `SessionHeader.tsx` (icon · title · glyph · computer · kind · provider · folder · starter · elapsed; the FL-06 git-line slot and the FL-05 attention slot), `SessionFooter.tsx` (role sentence, watchers, size, recording, bandwidth), `SessionComposer.tsx` (agent providers: text + Enter → driver input), `SessionShortcutSheet.tsx` (`T W R E N ?`; `Esc Esc` releases the keyboard and is the only key intercepted while driving).
    - **Test**: `SessionDetailClient.unit.spec.tsx` — role sentences, every ended-line variant, kill-switch footer, drain strip, keyboard reach, `?` opens the sheet; the pane is a labelled region re-announced on role change.

## P1.G — Safety, sweeper, i18n, e2e

- [ ] **T-29**. Wire kill switch and drain: `FleetKillSwitchService` changes → FL-02's `link.pause|resume` to every link → daemon `block-input`; `FleetPanicService` drain-all → owner sessions `warn 60` then `end(drain)`, Agent sessions through the existing Run cancellation (`apps/api/src/fleet/fleet-agent-run-canceller.ts`).
    - **Test**: extend `apps/api/src/fleet/fleet-panic.controller.spec.ts` and `fleet-kill-switch.controller.spec.ts` — drain emits the warning then the end; kill switch refuses starts and blocks input without ending.
- [ ] **T-30**. Add `packages/tasks/src/tasks/trigger/fleet-session-sweeper.task.ts` (cron `4/5 * * * *`, registered with `TriggerInternalModule` like `fleet-job-lease-sweeper.task.ts:35-74`): `starting` > 60 s → `ended (exit, unconfirmed)`; sessions on nodes offline > 2 heartbeats are left as they are (never ended by silence) — the "unknown — last seen …" label is derived on read from the Node's offline status (`unknown` is not a CONTRACTS §4.2 state).
    - **Test**: `packages/tasks/src/__tests__/fleet-session-sweeper.task.spec.ts` — the `starting` branch; an offline Node's sessions are not written; overlapping ticks idempotent; a silent-but-online session is never touched.
- [ ] **T-31**. Add the i18n groups to `apps/web/messages/en.json` under `fleet.sessions.*`, `fleet.computer.tabs.sessions`, `fleet.errors.*` (camelCase leaves, no literal `.`); only `en.json` is authored.
    - **Test**: `grep -c '"[a-zA-Z]*\.[a-zA-Z]*":' apps/web/messages/en.json` unchanged; no component under `apps/web/src/components/fleet/sessions/` contains a literal user-visible string.
- [ ] **T-32**. Write `apps/web/e2e/flow-fleet-sessions-owner.spec.ts` (tab states, start shell, attach, rename, end, restart, limits) and `apps/web/e2e/flow-fleet-sessions-contract.spec.ts` (every route's shape and refusal codes, in the style of `flow-terminal-attach-contract.spec.ts`).
    - **Test**: both green locally and in CI on a cold database; `flow-fleet-*` and `flow-terminal-attach-contract.spec.ts` unchanged and green.

---

# PHASE 2 — Agent sessions

- [ ] **T-33**. Add `'agent-session'` to `FleetJobKind`, `FLEET_JOB_KINDS` (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`) and `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` (`:239`, value `600`); add `FleetAgentSessionPayload`; add `'session'` to `AgentRunTriggerKind` (`packages/agent/src/entities/agent-run.entity.ts:23-29`) and `fleetSessionId uuid?` to the entity.
    - **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-jobs.spec.ts` (kind present with a record entry) and the agent-run entity spec.
- [ ] **T-34**. Author migration B from `apps/api/`: `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddAgentRunFleetSessionId` → `apps/api/src/migrations/1796040100000-AddAgentRunFleetSessionId.ts`. Hand-check: one `ADD COLUMN`, one index, no drops.
    - **Test**: applies twice cleanly; empty diff afterwards.
- [ ] **T-35**. Write `packages/agent/src/fleet/sessions/agent-session.dispatcher.ts` (twin of `packages/agent/src/computer/computer-session.dispatcher.ts:40-79`): payload, `targetNodeId` always set, `requiredCapabilities: ['sessions', <provider tag>]`, idempotency key `fleet-session:<id>`, lease TTL 300 s; `FleetSessionService.startAgent` creates the Run (trigger `session`, `fleetSessionId`), the session row and enqueues; `202` when queued.
    - **Test**: `__tests__/agent-session.dispatcher.spec.ts` and extend `fleet-session.service.spec.ts` — Run ↔ session links both ways; ending either ends both; queued state surfaces as `starting` with a waiting flag.
- [ ] **T-36**. Write `apps/node/src/core/executors/agent-session.ts` — the launch builder: `agentProfile.ensure` (`apps/node/src/core/screen/agent-profile.ts`), `isolatedHomeLayout` + `applyIsolatedHomeEnv` and the `claudeConfigRelocationLoss` gate from `apps/node/src/core/model-execution/isolated-home.ts` (refuse `unsupported_on_node` with the Task-run hint, never downgrade), MCP bridge (`apps/node/src/core/executors/mcp-bridge.ts`) or `MODEL_CLI_EMPTY_MCP_CONFIG` + `--strict-mcp-config`, `buildNodeCheckEnv`, `--permission-mode` from the plan (default `acceptEdits`), Codex's existing owner-config isolation (`--ignore-user-config`, shipped 2026-10-16 — reused from `model-cli.ts:104-113`, not re-implemented) + overlay `CODEX_HOME`; interactive argv (no `-p`, no `--output-format`), the first message as the prompt argument, the FL-05 hook overlay seam.
    - **Test**: `apps/node/src/core/executors/agent-session.spec.ts` — for the same plan the child env equals `agent-task`'s (the isolation proof, asserted key by key); argv has no `-p`; MCP config is the bridge's or empty with `--strict-mcp-config`; relocation refusal carries the hint.
- [ ] **T-36a**. Wire the executor as the `agent-session` job: lease → start through the daemon → keep-alive at TTL/3 while the session is alive → complete with the exit evidence (`FleetAgentSessionResult { exitCode, outcome, providerSessionId }`); refused without `--work`; drain publishes `end(drain)` inside `LEASE_TERMINATION_SAFETY_MS`. Register in `apps/node/src/core/runtime.ts` beside `'agent-task'` (`:749`) on the work lane only (never the attended lane).
    - **Test**: `agent-session.spec.ts` extended — lease lifecycle, keep-alive cadence, drain within budget, refusal without `--work`; `apps/node/src/core/runtime.spec.ts` extended — the kind is registered on the work lane only.
- [ ] **T-37**. Extend `SessionStartDialog.tsx` with the Agent kind: Agent picker (Agents bound to or allowed on the Node), required first message 3–4 000 chars, the isolation sentence, **in a new worktree** when FL-14's `checkouts.create` is available (create first, then start with `checkoutId`), the queued-state copy and cancel.
    - **Test**: `SessionStartDialog.unit.spec.tsx` extended — Agent kind gated by `--work`; first-message validation; worktree row present only with FL-14; queued copy.
- [ ] **T-37a** (parallel). Add the Agent page "Sessions" block (`apps/web/src/components/agents/AgentSessionsBlock.tsx`, mounted on the Agent dashboard) using `SessionCard` with the same row menu, and link the Run receipt (`apps/web/src/components/runs/RunReceiptView.tsx`) to the session detail for runs with `fleetSessionId`.
    - **Test**: `AgentSessionsBlock.unit.spec.tsx`; `RunReceiptView.unit.spec.tsx` extended — the link renders only for `session` runs.
- [ ] **T-38**. Add Agent tools at `packages/agent/src/fleet/agent-fleet-session-tools.ts` (`fleet_sessions_list|read` readOnly; `fleet_sessions_start` destructive:false, always kind `agent` with `agentId` = caller; `fleet_sessions_send` destructive:false (FL-19 catalogue §9.1); `fleet_sessions_rename`; `fleet_sessions_end` destructive:true, `confirmationClass: 'confirm'`), gated by AW-15 grants and the Node's `sessions` audience for the Agent's owner; register beside `agent-fleet-tools.ts`. Add the six to `apps/mcp/src/openapi-tools/whitelist.ts` beside the Fleet block (`:475-519`).
    - **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-session-tools.spec.ts` — a tool call never produces an owner session; audience refusal returns the envelope with hint; annotations present. MCP whitelist spec extended.
- [ ] **T-39**. Add the CLI: `apps/cli/src/commands/fleet/index.ts` (registered in `apps/cli/src/main.ts:23-26`), `commands/fleet/session/list.ts` (`--json`, exit `0/1/2`), `commands/fleet/session/attach.ts` (`--watch`, raw mode, `SIGWINCH` resize, `Ctrl-]` `d` detach, exit `0/1/2`).
    - **Test**: `apps/cli/src/commands/fleet/__tests__/session-attach.spec.ts`, `session-list.spec.ts` — detach chord, exit codes, JSON shape equals `FleetSessionView`.
- [ ] **T-40**. Write `apps/web/e2e/flow-fleet-sessions-agent.spec.ts` — start an Agent session, Run created and linked, isolation footer, queued state under concurrency 1, end from the receipt ends both.
    - **Test**: green locally and in CI.

---

# PHASE 3 — Recording and re-watch

- [ ] **T-41**. Extend `packages/agent/src/agents/terminal-transcript.service.ts` with `persistSessionFrames(fleetSessionId, frames)` (same redaction and batching as `persistFrames`, `:107-124`; retention 14 days fixed for sessions) and `replaySession(fleetSessionId, from, limit)`; `FleetSessionService.setRecording(on)` flips `recordingState` and audits `node.session.recording.start|stop`; default on for Agent sessions, for owner sessions from the Node's existing `recordWatchSessions` (`packages/agent/src/entities/fleet-node.entity.ts:506`).
    - **Test**: extend `packages/agent/src/agents/__tests__/terminal-transcript.service.spec.ts` — session chunks keyed and redacted; default rule per kind; storage failure flips the state to `off` with a reason and never throws into the relay.
- [ ] **T-42**. Route recorded frames: `session.family.ts` forwards `DATA` frames to `persistSessionFrames` when `recordingState === 'recording'`, fire-and-forget like `apps/api/src/terminal/terminal-internal.controller.ts:130-150`; add `GET/POST /sessions/:id/recording` to the controller (`GET` returns the manifest with driver spans from the audit rows, or a chunk page with `?from=seq&limit` — the CONTRACTS §11.2 path, no sub-route).
    - **Test**: controller spec extended; family spec — a storage failure never stalls the viewer path.
- [ ] **T-43**. Extend `packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts` to delete session-keyed chunks older than 14 days alongside the existing per-run retention.
    - **Test**: `packages/tasks/src/__tests__/terminal-transcript-gc.task.spec.ts` extended — session chunks past 14 days gone, run chunks follow their plan tier.
- [ ] **T-44**. Write `SessionReplayPlayer.tsx` (replays chunks into a `TerminalPane` renderer instance; slider 1 s / 10 s steps; speed `1× 2× 4×`; driver-span marks) and the **Re-watch** entry on the detail and the Run receipt; the footer's recording state and toggle; the "nothing to play" variants.
    - **Test**: `SessionReplayPlayer.unit.spec.tsx`; e2e `apps/web/e2e/flow-fleet-sessions-replay.spec.ts`.
- [ ] **T-45**. Write `apps/web/e2e/flow-fleet-sessions-a11y.spec.ts` — keyboard-only operation of tab, dialog, detail and player; an axe pass; `Esc Esc` releases the keyboard.
    - **Test**: green; the sweep is clean.

---

# PHASE 4 — Docs and rollout

- [ ] **T-46**. Write the user doc `docs/features/fleet-sessions.md` (what a session is, owner vs Agent, consents, limits, recording, cost sentence) and list it in `apps/docs/sidebarsPlatform.ts` beside `features/fleet` (`:183`); cross-link from `docs/features/fleet.md` and `docs/features/agent-terminals.md` (the "Terminal sessions are dispatched onto the configured job runtime" paragraph gains the pointer to node sessions).
    - **Test**: `pnpm --filter ever-works-docs build` has no broken-link warning.
- [ ] **T-47**. Update trackers: `docs/specs/features/fleet/TRACKER.md` (FL-04 impl per phase) and `docs/specs/features/agent-workspace/TRACKER.md` (`:25`, AW-11 P3 terminal recording delivered by FL-04; `AW-11 tasks.md` T50–T55 note). No plugin doc change (no plugin).
    - **Test**: both rows link to this folder.
- [ ] **T-48**. Flag and gate: `FLEET_SESSIONS_ENABLED` read in `apps/web/src/lib/fleet-flags.ts` and the API guard; default off in production; the existing `GET /api/health/ready` lists the flag state under `fleet`.
    - **Test**: with the flag off every new route 404s and the tab is absent; with it on, everything above.
- [ ] **T-49**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`, the banned-terms grep, and the node conformance spec (`apps/node/src/core/node-contract.conformance.spec.ts`); confirm green.

## Definition of done

- All checkboxes ticked; every `ACC-FL04-nn` in `spec.md` §9 has a passing test named above.
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` green locally and in CI; `pnpm --filter ever-works-docs build` has no broken-link warnings.
- The banned-terms grep over `docs apps packages` prints nothing.
- A session started on a Node survives `ever-works-node` stop/start (ACC-FL04-01) and a machine reboot ends it with its last screen (ACC-FL04-06), both demonstrated on Linux, macOS and Windows.
- Constitution gates in `spec.md` §10 confirmed; CONTRACTS clarifications in `spec.md` §8b resolved or recorded as accepted.

---

# Addenda (added at the bottom, per "never renumber")

- [ ] **T-50**. Model usage limits for Agent sessions (spec FR-43a; EXISTING-SUBSTRATE §1.8, §2.6): make `agent-session` take the same path as `agent-task` in the platform lease (`packages/agent/src/fleet/fleet-job.service.ts` `throttledProviders` `:1495`, park `:784`) and in the node worker loop (`apps/node/src/core/worker-loop.ts` throttle hold, `apps/node/src/core/runtime.ts:662-664`); the session card reads the existing `queuedReason: 'model-usage-limit'` and the reset time. No new throttle state.
    - **Test**: extend `packages/agent/src/fleet/__tests__/fleet-job.service.spec.ts` — a pinned `agent-session` for a throttled CLI is not leased and parks with `model-usage-limit`; `apps/node/src/core/worker-loop.spec.ts` — the node does not lease it while the CLI is held; `SessionCard.unit.spec.tsx` — the waiting copy with the reset time.
