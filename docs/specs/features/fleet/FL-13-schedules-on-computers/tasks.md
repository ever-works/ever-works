# FL-13 — Schedules on computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI).

**Feature ID**: `fl-13-schedules-on-computers`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-10-18

---

## How to use

- Paths are repo-relative. `packages/agent`, `apps/api`, `packages/tasks` use **Jest**;
  `apps/node`, `packages/contracts`, `apps/cli`, `apps/web` unit use **Vitest**; e2e is **Playwright**.
- FL-12 must have landed (entities, runner, confirm token). FL-04 is needed from P2 on.
- Everything is behind `FLEET_COMMANDS_ENABLED`. Commit style `feat(fleet-schedules): …`.
- Add tasks at the bottom; never renumber.

## P1.A — Contracts and schema

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-schedule-cadence.ts` — `FleetScheduleCadence`, `nextFire`, `describeCadence`, `isValidCadence`, constants (plan §4.3); export from `packages/contracts/src/fleet/index.ts`.
  **Test**: `packages/contracts/src/fleet/__tests__/fleet-schedule-cadence.spec.ts` — six forms; spring-forward and fall-back days in `Europe/Paris`, `America/New_York`, `Asia/Kolkata`; invalid cron refused.
- [ ] **T-02**. Add the `schedule.*` link message types to `packages/contracts/src/fleet/fleet-commands.types.ts`; add optional `timeZone` to `FleetNodeSelfDescription` and `FleetNodeView` in `packages/contracts/src/fleet/fleet-node.types.ts` (`:329`, `:532`).
  **Test**: `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` + fixture `packages/contracts/fixtures/fleet-node-contract.v1.json` extended; old fixture still conforms.
- [ ] **T-03**. Add `node.schedule.create|update|delete|run|pause|resume` to `packages/contracts/src/fleet/fleet-panic.types.ts` (`:60-148`).
  **Test**: `fleet-panic.spec.ts` union/array parity.
- [ ] **T-04**. Add `'node_schedule'` to `ScheduleSourceType`, the optional node fields on `ScheduleView`, the three health reasons and two control reason keys in `packages/agent/src/schedules/schedule-view.types.ts`; update the stale "six sources" comments (`:4-5`, `:34`) to "eight".
  **Test**: type-check; `schedule-view.types` consumers compile.
- [ ] **T-05**. Add the columns of plan §4.1 to `packages/agent/src/entities/fleet-command.entity.ts`, `fleet-command-run.entity.ts`, `fleet-node.entity.ts`.
  **Test**: entity metadata spec; no `@ManyToOne`.
- [ ] **T-06**. Author `apps/api/src/migrations/1796130000000-AddFleetCommandCadence.ts` (hand-check: `ADD COLUMN` only, two indexes, no drops).
  **Test**: applies twice; empty re-generate diff.

## P1.B — Platform domain

- [ ] **T-07**. Add `packages/agent/src/fleet/fleet-schedule.service.ts` — create/update/move/delete (soft), pause/resume with reason, `runNow`, `bumpSync`, `recordReconciledRuns`, failure-streak logic, `nextRunAt` maintenance via `nextFire`. Register/export in `packages/agent/src/fleet/fleet.module.ts`.
  **Test**: `packages/agent/src/fleet/__tests__/fleet-schedule.service.spec.ts` — every refusal; streak pause at 5 and reset; sync generation bump on each change; offline save allowed.
- [ ] **T-08**. Add the `node_schedule` collector to `packages/agent/src/schedules/schedules.service.ts` (`SOURCE_TYPES` at `:85-93`; new `collectNodeSchedules` reading `fleet_commands WHERE cadence IS NOT NULL AND deletedAt IS NULL`); add the additive `ScheduleOwnerType` value `'node'` in `schedule-view.types.ts:31` so a Command schedule's owner is the computer, with `ownerLink` pointing at the computer page's Schedules tab.
  **Test**: `src/schedules/__tests__/schedules.service.node-schedule.spec.ts` — thirteen fields; `countsBySourceType.node_schedule`; degraded source handling.
- [ ] **T-09**. Extend `packages/agent/src/schedules/schedule-controls.ts` (`buildScheduleControls`, `:39`) for `node_schedule` (reassign = move computer; new reasons `nodeOffline`, `consentMissing`) and `schedule-control.service.ts` (`SOURCE_TYPES` `:78-86`; delegate run-now/pause/resume to `FleetScheduleService`).
  **Test**: `schedule-controls.spec.ts`, `schedule-control.service.spec.ts` extended.
- [ ] **T-10**. Extend `packages/agent/src/schedules/schedule-health.service.ts` — cadence kind `node-cadence`, reasons `consent-missing` (none), `node-removed` (choice), `node-unsupported` (none); `proposeScheduleRepair` for `node-removed` returns the move proposal.
  **Test**: `schedule-health.spec.ts` — each reason produced by exactly its fixture; a paused node schedule is not flagged.
- [ ] **T-11**. Register the `schedule-failed` producer in FL-01's `packages/agent/src/fleet/needs-a-look.registry.ts` from `packages/agent/src/fleet/fleet-schedule-needs-a-look.producer.ts`.
  **Test**: `__tests__/fleet-schedule-needs-a-look.producer.spec.ts` — raised after two failures or one `skipped-offline`; cleared on success; one item per schedule.

## P1.C — API

- [ ] **T-12**. Extend `apps/api/src/fleet/fleet-commands.controller.ts` (FL-12) with cadence on create, `PATCH /:id`, `DELETE /:id`, `POST /:id/run-now|pause|resume`, `GET /:id/runs`; DTOs in `apps/api/src/fleet/dto/fleet-schedules.dto.ts`.
  **Test**: `apps/api/src/fleet/fleet-commands.controller.schedules.spec.ts` — every §8 code with hint; `busy`; offline save.
- [ ] **T-13**. Add `GET /api/fleet/nodes/:id/schedules` to `apps/api/src/fleet/fleet.controller.ts` (beside `@Get('nodes/:id')` `:293`).
  **Test**: controller spec — both kinds listed; cross-user 404.
- [ ] **T-14**. Extend `apps/api/src/schedules/schedules.controller.ts` — `?node=` on `/page`; `ParseScheduleIdPipe` accepts `node_schedule:<uuid>`.
  **Test**: `schedules.controller.spec.ts` extended.
- [ ] **T-15**. Add `apps/api/src/fleet/fleet-schedule-sync.service.ts` — opens the `schedule` channel on link open, sends the full definition set, tracks `syncedGeneration`, handles `schedule.synced`, runs `schedule.runs` on open.
  **Test**: `fleet-schedule-sync.service.spec.ts` with a fake link — full-replace semantics; generation ack; refusal mapping to `unsupported_on_node`.
- [ ] **T-16**. Heartbeat: accept `timeZone` in `apps/api/src/fleet/fleet.controller.ts` (`@Post('heartbeat')` `:620`) and persist on `FleetNode`.
  **Test**: `fleet.controller.spec.ts` — stored and returned; absent field tolerated.

## P1.D — Node

- [ ] **T-17**. Add `apps/node/src/core/schedules/schedule-store.ts` — `<configDir>/schedules/<id>.json`, atomic replace, owner-only (0600 / `icacls` via `apps/node/src/node-io.ts`).
  **Test**: `schedule-store.spec.ts` — replace deletes stale files; modes.
- [ ] **T-18**. Add `apps/node/src/core/schedules/schedule-clock.ts` — `nextFire` from contracts, `dueSince(lastFireAt, now, grace)` collapsing to one.
  **Test**: `schedule-clock.spec.ts` — grace edges ±1 s; two missed → one.
- [ ] **T-19**. Add `apps/node/src/core/schedules/schedule-loop.ts` — single armed timer, per-schedule mutex, runs via FL-12 `command-runner.ts` with `timeoutSec = 21600`, `skipped-overlap`, kill-switch stop/resume, re-arm on sync.
  **Test**: `schedule-loop.spec.ts` with fake timers — overlap skip; cap; kill switch; re-arm.
- [ ] **T-20**. Add `apps/node/src/core/schedules/schedule-history.ts` — `runs.jsonl` + `<runId>.log`, ring of 30, `since` query.
  **Test**: `schedule-history.spec.ts` — eviction; `since` idempotency.
- [ ] **T-21**. Add `apps/node/src/core/schedules/schedule-channel.ts` — `schedule.sync|runs|runNow|pause|resume`; refusals; register in `apps/node/src/core/runtime.ts` with `--manage`; advertise tag `schedules`; report `timeZone` in heartbeat (`apps/node/src/core/heartbeat.ts`).
  **Test**: `schedule-channel.spec.ts`; `heartbeat.spec.ts` extended; `capabilities.spec.ts` — `schedules` only with `--manage`.

## P1.E — Web and CLI

- [ ] **T-22**. Register the `schedules` computer tab in `apps/web/src/components/fleet/registry.ts`; add `apps/web/src/components/fleet/schedules/` — `ComputerSchedulesTab.tsx`, `NodeScheduleRow.tsx`, `ScheduleRunHistory.tsx`, `ScheduleTimeZoneNote.tsx`, `schedules.shared.ts`.
  **Test**: `schedules.shared.unit.spec.ts` — two-zone text; hidden parentheses when zones match.
- [ ] **T-23**. Add `NewNodeScheduleDialog.tsx` (command variant) with the six cadence forms and next-three preview; wire from the tab and from FL-12 `CommandComposer.tsx` (**Schedule this…**).
  **Test**: `NewNodeScheduleDialog.unit.spec.tsx` — sandbox sentence; invalid cadence blocked.
- [ ] **T-24**. Extend `apps/web/src/components/schedules/ScheduleSourceChips.tsx`, `SchedulesFilters.tsx` (`?node=`), `SchedulesCreateMenu.tsx` (On a computer…), `ScheduleRowMenu.tsx` (Move, Delete), `ScheduleHealthBadge.tsx` (reasons).
  **Test**: existing unit specs extended (`ScheduleRowMenu.unit.spec.tsx`, `ScheduleHealthBadge.unit.spec.tsx`, `SchedulesCreateMenu.unit.spec.tsx`).
- [ ] **T-25**. Server actions in `apps/web/src/app/actions/dashboard/schedules.ts` and API client `apps/web/src/lib/api/schedules.ts` for the fleet routes.
  **Test**: `apps/web/e2e/flow-fleet-schedules-contract.spec.ts`.
- [ ] **T-26**. i18n `fleet.schedules.*` in `apps/web/messages/en.json` (camelCase, no dots), including `unattendedCredentialNote`.
  **Test**: no literal strings in `components/fleet/schedules/`.
- [ ] **T-27**. CLI `apps/cli/src/commands/fleet/schedule.ts` — `create|list|get|update|run|pause|resume|runs|delete`, `--json`, exit codes; register in the `fleet` group.
  **Test**: `apps/cli/src/commands/fleet/__tests__/schedule.spec.ts`.
- [ ] **T-28**. Reconciler `packages/tasks/src/tasks/trigger/fleet-schedule-reconciler.task.ts` (every 5 min, `*_DISPATCHER` symbol in `packages/agent/src/fleet/fleet-schedule.dispatcher.ts`); registered beside `fleet-job-lease-sweeper.task.ts`.
  **Test**: `packages/tasks/src/__tests__/fleet-schedule-reconciler.task.spec.ts` — idempotent upsert; streak; producer.
- [ ] **T-29**. Playwright `apps/web/e2e/flow-fleet-schedules.spec.ts` — create, two-zone cadence, run now, pause/resume, history with skip reasons, delete with retained history.
  **Test**: green locally and in CI.

## P2 — Agent-session schedules, repairs, breaker, tools, cost

- [ ] **T-30**. Add `POST /api/fleet/nodes/:id/schedules/agent-session` in `apps/api/src/fleet/fleet-commands.controller.ts` → `packages/agent/src/fleet/fleet-schedule.service.ts#createAgentSessionSchedule` (creates a recurring Task via `TasksService`, verifies affinity via `FleetAgentNodeAffinityService.getAffinity`, refuses unpinned with the U9 hint).
  **Test**: controller + service specs — unpinned refused; Task carries `isRecurring`, cadence, assignee.
- [ ] **T-31**. Computer chip on pinned recurring Tasks in `schedules.service.ts` (join affinity → `nodeId`, `nodeName`).
  **Test**: `schedules.service.node-schedule.spec.ts` extended.
- [ ] **T-32**. Ensure the router places pinned recurring-Task Runs as FL-04 `agent-session` jobs: extend `apps/api/src/fleet/fleet-run-router.service.ts` and `fleet-agent-task-planner.service.ts` for `executionMode: 'session'` when the Task originates from a node schedule.
  **Test**: router spec — `targetNodeId` from affinity; job kind `agent-session`.
- [ ] **T-33**. Missed-fire sweeper for Agent-session schedules in the reconciler (`skipped-offline`, Task instance cancelled with reason).
  **Test**: reconciler spec extended.
- [ ] **T-34**. Dialog Agent-session variant in `NewNodeScheduleDialog.tsx` — pinned Agents only, prompt, checkout picker (FL-14), FR-26 sentence, cost note.
  **Test**: `NewNodeScheduleDialog.unit.spec.tsx` — sentence verbatim; unpinned disabled with reason.
- [ ] **T-35**. Cost on rows and history: read `AgentRun.costCents` for Agent-session runs and FL-20's 30-day roll-up; tokens-only fallback.
  **Test**: `ScheduleRunHistory.unit.spec.tsx`.
- [ ] **T-36**. Breaker scope `node` in AW-10's `POST /api/schedules/disable-all` (`apps/api/src/schedules/schedules.controller.ts`) and `DisableAllDialog.tsx`; **Pause all** button on the computer tab.
  **Test**: `schedules.controller.breaker.spec.ts` extended — only that computer's rows; undo.
- [ ] **T-37**. Agent tools `fleet_schedules_*` in `packages/agent/src/fleet/agent-fleet-tools.ts` through the FL-19 gate; MCP whitelist entries in `apps/mcp/src/openapi-tools/whitelist.ts`.
  **Test**: `agent-fleet-tools.spec.ts`; `whitelist.spec.ts`.
- [ ] **T-38**. Playwright `apps/web/e2e/flow-fleet-schedules-agent-session.spec.ts` — create, fire (fake dispatcher), session visible on the computer Sessions tab, Run cost on the row.

## P3 — Native fallback and editors

- [ ] **T-39**. `apps/node/src/core/schedules/native-scheduler/{cron,launchd,task-scheduler}.ts` + CLI verb `ever-works-node schedule-run <id>` in `apps/node/src/cli/program.ts`; install only when the node is not running as a service; remove on unenroll.
  **Test**: per-OS spec with a fake command runner — block markers, idempotent install/remove.
- [ ] **T-40**. Editors for `missedRunGraceSec` and `pauseAfterFailures` in the dialog's **Advanced** section.
  **Test**: unit spec — clamps 0–360 min and 1–20.

## Docs and rollout

- [ ] **T-41**. User doc `docs/features/fleet-schedules.md` (incl. the FR-26 sentence and the service-install note); add to `apps/docs/sidebarsPlatform.ts` under fleet (`:183`); cross-link from `docs/features/fleet.md` and `docs/features/activity.md`.
- [ ] **T-42**. Update `docs/specs/features/schedules/spec.md` §6 note (a source type extension now exists) and `docs/specs/features/fleet/TRACKER.md`.
- [ ] **T-43**. `pnpm format && pnpm lint && pnpm test && pnpm build`; docs build without broken links; banned-terms grep on this folder prints nothing.

## Definition of done

- All boxes ticked; every FR has a test; flag off hides the tab, the source and the routes.
- Spec §9 verified on a fake fleet with one managed node, one unmanaged node and one node stopped across a fire.
- No credential, output byte or secret in logs or audit (asserted by test); the FR-26 sentence appears exactly once as a key.
