# FL-12 — Commands on computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI).

**Feature ID**: `fl-12-commands`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root. `packages/agent` and `apps/api` use **Jest**;
  `apps/node`, `packages/contracts`, `apps/cli`, `apps/web` unit use **Vitest**; `apps/web` e2e
  uses **Playwright**.
- Migrations are authored from `apps/api/`; the API self-applies on boot.
- Everything is behind `FLEET_COMMANDS_ENABLED` (default off in production).
- Add tasks at the bottom; never renumber. Commit style `feat(fleet-commands): …`.

## P1.A — Contracts and schema

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-commands.types.ts` (views, statuses, constants, link message types from plan §4.3); export from `packages/contracts/src/fleet/index.ts`.
  **Test**: `packages/contracts/src/fleet/__tests__/fleet-commands.spec.ts` — every union has its `readonly` array and `isX` guard; constants equal CONTRACTS §10.
- [ ] **T-02**. Add `node.command.run` and `node.command.cancel` to `FleetAuditAction` and `FLEET_AUDIT_ACTIONS` in `packages/contracts/src/fleet/fleet-panic.types.ts` (union at `:60-114`, array `:116-148`).
  **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts` — union and array stay in sync.
- [ ] **T-03**. Add `packages/agent/src/entities/fleet-command.entity.ts` and `fleet-command-run.entity.ts` per plan §4.1; register in `packages/agent/src/entities/index.ts` and `packages/agent/src/database/_entities-inventory.ts`.
  **Test**: `packages/agent/src/entities/__tests__/fleet-command.entity.spec.ts` — metadata loads; no `@ManyToOne`.
- [ ] **T-04**. Author `apps/api/src/migrations/1796120000000-CreateFleetCommands.ts` and `1796120100000-CreateFleetCommandRuns.ts` (`pnpm typeorm migration:generate -d typeorm.config.ts …` from `apps/api/`, then hand-check: additive only, no FK on `nodeId`).
  **Test**: apply twice on a fresh and a populated database; a re-generate yields an empty diff.

## P1.B — Domain service

- [ ] **T-05**. Add `packages/agent/src/fleet/fleet-command.policy.ts` — pure: `resolveTargets(nodes, caller, role)` → per node `runnable | reason`, `clampTimeout`, `COMMAND_LIMITS`.
  **Test**: `packages/agent/src/fleet/__tests__/fleet-command.policy.spec.ts` — truth table over status × consent × audience; clamp at ±1 s.
- [ ] **T-06**. Add `packages/agent/src/fleet/fleet-command.service.ts` — `confirm`, `run`, `cancel`, `get`, `listRecent`, `onData` (head/tail rings), `onExit`, `onLinkLost`; kill-switch check via `FleetKillSwitchService`; audit via `FleetAuditService.tryRecord`. Register and export in `packages/agent/src/fleet/fleet.module.ts`.
  **Test**: `packages/agent/src/fleet/__tests__/fleet-command.service.spec.ts` — every refusal code; head/tail exactly 64 KiB; `link-lost` after 2 min; redaction of a token-shaped command line.
- [ ] **T-07**. Add `packages/agent/src/fleet/fleet-command-confirmation.ts` — HMAC confirmation token bound to `sha256(command + nodeIds + cwd + timeoutSec)`, TTL 5 min.
  **Test**: `__tests__/fleet-command-confirmation.spec.ts` — a changed payload invalidates the token; expiry.

## P1.C — API and relay

- [ ] **T-08**. Add `apps/api/src/fleet/fleet-commands.controller.ts` (`api/fleet/commands`, routes per plan §5, DTOs under `apps/api/src/fleet/dto/fleet-commands.dto.ts`); mount in `apps/api/src/fleet/fleet.module.ts`; add `FleetFlagGuard('FLEET_COMMANDS_ENABLED')` at `apps/api/src/fleet/guards/fleet-flag.guard.ts`.
  **Test**: `apps/api/src/fleet/fleet-commands.controller.spec.ts` — every §8 code with its hint; cross-user 404; throttles.
- [ ] **T-09**. Add `apps/api/src/fleet/fleet-command-bridge.service.ts` — opens one `command` channel per node through the FL-02 relay, forwards `DATA`/`EXIT` to the service and to attached viewers, handles `command.cancel`.
  **Test**: `apps/api/src/fleet/fleet-command-bridge.service.spec.ts` with a fake link — refusal mapping, cancel, link drop.
- [ ] **T-10**. Add the viewer gateway path `/ws/fleet/command/:commandId` to the FL-02 fleet WS service (`apps/api/src/fleet/fleet-link-ws.service.ts`), role `viewer` only.
  **Test**: extend its spec — query string refused; token in first frame; a viewer cannot send input.

## P1.D — Node

- [ ] **T-11**. Add `apps/node/src/core/commands/command-runner.ts` — login shell per OS (lift `resolveNodeShell` from `apps/node/src/core/screen/terminal-channel.ts:27-34` into `apps/node/src/core/node-shell.ts` and re-export), `stdio: ['ignore','pipe','pipe']`, process-group kill, 10 MiB cap, `buildNodeCheckEnv` environment.
  **Test**: `apps/node/src/core/commands/command-runner.spec.ts` — stdin is EOF; timeout kills a child's child; cap stops at 10 MiB; Windows argv.
- [ ] **T-12**. Add `apps/node/src/core/commands/command-output-store.ts` — `<configDir>/commands/<runId>.log`, ring of 30, owner-only mode.
  **Test**: `command-output-store.spec.ts` — 31st run evicts the oldest; files are 0600.
- [ ] **T-13**. Add `apps/node/src/core/commands/command-channel.ts` — link channel handler for `command.run`, `command.cancel`, `command.output`, kill-switch termination; register in `apps/node/src/core/runtime.ts` beside `:1062` only when `--manage` is on.
  **Test**: `command-channel.spec.ts` — `consent_missing` refusal without `--manage`; cancel → `EXIT 130`; kill switch → `EXIT 137`; `cwd` escape refused.

## P1.E — Web and CLI

- [ ] **T-14**. Add `DASHBOARD_FLEET_COMMANDS` to `apps/web/src/lib/constants.ts`; page `apps/web/src/app/[locale]/(dashboard)/fleet/commands/page.tsx`; registry entry in `apps/web/src/components/fleet/registry.ts`.
  **Test**: `apps/web/src/components/fleet/registry.unit.spec.ts` — the panel is present with the flag on, absent off.
- [ ] **T-15**. Add `apps/web/src/components/fleet/commands/` — `commands.shared.ts`, `CommandsPanel.tsx`, `CommandComposer.tsx`, `CommandNodePicker.tsx`, `CommandConfirmDialog.tsx`, `CommandRunCard.tsx`, `CommandSummaryLine.tsx`, `RecentCommands.tsx`, `use-command-attach.ts`.
  **Test**: `commands.shared.unit.spec.ts` (preselection and reasons); `CommandConfirmDialog.unit.spec.tsx` (sandbox sentence verbatim, shell and user named).
- [ ] **T-16**. Add BFF routes `apps/web/src/app/api/fleet/commands/confirm/route.ts`, `apps/web/src/app/api/fleet/commands/route.ts`, `apps/web/src/app/api/fleet/commands/[id]/attach-token/route.ts`.
  **Test**: `apps/web/e2e/flow-fleet-commands-contract.spec.ts` — refusal bodies pass through with code and hint.
- [ ] **T-17**. Add i18n `fleet.commands.*` and `fleet.errors.*` keys to `apps/web/messages/en.json` (camelCase leaves, no literal dots).
  **Test**: no literal user-visible string in `apps/web/src/components/fleet/commands/`.
- [ ] **T-18**. Add the CLI group root `apps/cli/src/commands/fleet/index.ts` (if FL-19 has not landed it) and `apps/cli/src/commands/fleet/command.ts` — `run --on --timeout --cwd --json -- <cmd>`; register in `apps/cli/src/main.ts`; exit codes `0/1/2/124`.
  **Test**: `apps/cli/src/commands/fleet/__tests__/command.spec.ts` — exit codes; `--json` shape equals `FleetCommandRunView`.
- [ ] **T-19**. Playwright `apps/web/e2e/flow-fleet-commands.spec.ts` — golden path on two fake nodes, greyed reasons, timeout card, recent list of 8.
  **Test**: green locally and in CI.

## P2 — Agent tool, computer page, operations

- [ ] **T-20**. Extend `packages/agent/src/fleet/agent-fleet-tools.ts` with `fleet_commands_run` (destructive, `confirmationClass: 'confirm'`, AW-24 `machine.run`), `fleet_commands_get`, `fleet_commands_list` (read-only), through the FL-19 gate helper `packages/agent/src/fleet/fleet-tool-gate.ts`.
  **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-tools.spec.ts` — refusal outside the audience; `requestedBy: agent:<id>` in the audit row.
- [ ] **T-21**. Add MCP whitelist entries `run_fleet_command`, `get_fleet_command`, `list_fleet_commands` in `apps/mcp/src/openapi-tools/whitelist.ts` (annotations per plan §9).
  **Test**: `apps/mcp/src/openapi-tools/__tests__/whitelist.spec.ts` — entries resolve against the OpenAPI spec.
- [ ] **T-22**. Add `⋯ › Run a command…` to the computer page header (FL-01's `apps/web/src/components/fleet/computer/ComputerHeaderMenu.tsx`) linking to `/fleet/commands?node=<id>`; show "Last command" on the Overview tab.
  **Test**: extend `apps/web/e2e/flow-fleet-commands.spec.ts`.
- [ ] **T-23**. Implement `POST /commands/:id/runs/:runId/output` as an FL-02 operation; node `command.output`; download response with `Content-Disposition: attachment`, `nosniff`.
  **Test**: controller spec — offline node → `unreachable` with last-seen hint.
- [ ] **T-24**. Implement cancel end to end (controller → bridge → node → `EXIT 130` → `node.command.cancel`).
  **Test**: service and channel specs extended.

## P3 — Folder picker, re-run, hand-over

- [ ] **T-25**. Folder picker from FL-14 checkouts in `CommandComposer.tsx` (falls back to a path field when FL-14 is off).
  **Test**: `CommandComposer.unit.spec.tsx`.
- [ ] **T-26**. Re-run from Recent (opens the confirm dialog pre-filled).
  **Test**: Playwright extension.
- [ ] **T-27**. Retention sweep for `fleet_command_runs` bodies in `apps/api/src/fleet/fleet-job-retention.service.ts` (null head/tail after 30 days, keep rows).
  **Test**: extend its spec.

## Docs and rollout

- [ ] **T-28**. User doc `docs/features/fleet-commands.md`; add to `apps/docs/sidebarsPlatform.ts` under the fleet entry (`:183`); link from `docs/features/fleet.md`.
- [ ] **T-29**. Update `docs/specs/features/fleet/TRACKER.md` (FL-12 Impl) and this folder's status lines.
- [ ] **T-30**. Run `pnpm format && pnpm lint && pnpm test && pnpm build`; confirm `pnpm --filter ever-works-docs build` has no broken links; run the banned-terms grep on this folder.

## Definition of done

- All boxes ticked; every FR has a test (unit, controller or e2e); `FLEET_COMMANDS_ENABLED` off hides the whole surface.
- Spec §9 acceptance criteria verified on a fake fleet of three nodes (one unmanaged, one offline).
- No output bytes, command lines or secrets in any log or audit row (asserted by test).
