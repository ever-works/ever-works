# Schedules — Task Checklist

**Status:** Draft v1 · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Granular checklist agents and reviewers tick off as work lands. JIRA Epic + Story keys added once tickets exist (see "JIRA linkage" at the bottom).

---

## Phase 1 (P1) — Rename + toggle + aggregation endpoint + Schedules list

### Rename (i18n values only — keys untouched)

- [ ] `apps/web/messages/en.json` — `dashboard.activity.title` (line ~1219) `"Activity Log"` → `"Activity"`.
- [ ] `apps/web/messages/en.json` — `metadata.pages.activity` (line ~5053) `"Activity Log"` → `"Activity"`.
- [ ] Mirror both values into all 20 locales (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh`), translated, "Log" qualifier dropped.
- [ ] Verify NO change to: `ActivityLog` entity, `activity_log` table, `ActivityLogService`, `/activity-log` routes, i18n keys, `activity-log.csv` filename.

### Contracts

- [ ] `packages/contracts/src/api/schedule/schedule.enum.ts` — `ScheduleSourceType` (6 members).
- [ ] `packages/contracts/src/api/schedule/schedule.dto.ts` — `ScheduleDto`, `ScheduleControls`, `SchedulesResponseDto`.
- [ ] Export from `packages/contracts/src/api/index.ts`.

### API

- [ ] `apps/api/src/schedules/schedules.module.ts`.
- [ ] `apps/api/src/schedules/schedules.controller.ts` — `GET /api/schedules` (auth-guarded, scope-aware, query params `sourceType`/`entityKind`/`enabledOnly`, OpenAPI annotated).
- [ ] `apps/api/src/schedules/schedules.service.ts` — six scoped source queries → `ScheduleDto[]` → sort (null-last) → `countsByType`; `controls` all-`false` in P1.
- [ ] Status normalization map ([spec.md §4.5](spec.md#45-status-normalization)).
- [ ] Owning-entity `link` builder ([spec.md §5.4](spec.md#54-owning-entity-links-scheduledtolink)).
- [ ] `computeNextCronFire(expr, from)` added to `packages/agent/src/missions/cron-matcher.ts`.
- [ ] `describeCadence(sourceType, raw)` (RRULE→text via `recurrence.ts`, cron→text, `WorkScheduleCadence`→label, interval→"Every N min").
- [ ] Scope: consume `ScopeContext`; `userId` always, `organizationId` when Org scope active, `organizationId IS NULL` + legacy `tenantId IS NULL` in bare-Tenant scope; `userId`-only fallback where scope plumbing absent.

### Web

- [ ] `activity-client.tsx` — `activeTab` state + `activity-tab` localStorage persistence (mirror `viewMode` lines 60–68).
- [ ] Segmented `Log | Schedules` control above `PageHeader`.
- [ ] Gate body: `log` unchanged; `schedules` renders `<SchedulesView />`, hides Log chrome (status cards, `ActivityFilters`, `ViewModeSwitch`, Export, 5s poll).
- [ ] Optional `?tab=schedules` URL reflection via existing `router.replace` block (lines 72–84).
- [ ] `apps/web/src/app/actions/schedules.ts` — `getSchedules(filters)` server action.
- [ ] `apps/web/src/lib/api/schedules.ts` — `schedulesAPI.getAll(filters)` via `serverFetch` (+ `X-Scope-Slug`).
- [ ] `apps/web/src/components/activity-log/schedules/SchedulesView.tsx`.
- [ ] `ScheduleRow.tsx`, `ScheduleCard.tsx`.
- [ ] `SchedulesFilters.tsx` (source-type chips + "Active only").
- [ ] `SchedulesEmptyState.tsx`.
- [ ] i18n additive keys `dashboard.activity.tabs.{log,schedules}`, `dashboard.activity.schedules.*` in all locales.

### Tests

- [ ] `schedules.service.spec.ts` — per-source mapping, scope filter, status normalization, sort order, `countsByType`.
- [ ] `schedules.controller.spec.ts` — auth guard + query-param filters.
- [ ] Web unit — toggle persistence; `schedules` tab hides Log chrome; empty state.
- [ ] E2E — seed one of each source → switch to Schedules → six rows with cadence + next-run.

---

## Phase 2 (P2) — Activity-gap emitters

### Enum

- [ ] Append `MISSION_TICK = 'mission_tick'` + `IDEA_GENERATED = 'idea_generated'` to `ActivityActionType` (`packages/agent/src/entities/activity-log.types.ts`) — additive, no migration.

### Emitters

- [ ] `schedule_executed` on cron path — `packages/agent/src/services/work-schedule-dispatcher.service.ts` (`dispatchDue`) + NestJS fallback `apps/api/src/works/tasks/work-schedule-dispatcher-cron.service.ts`. `ingestEventId = schedule-exec:${workId}:${generationHistoryId}`.
- [ ] `agent_heartbeat_started/completed/failed` — `packages/agent/src/agents/agent-run.service.ts` (guard `triggerKind === 'heartbeat'`); optional `started` at claim in `agent-schedule-dispatcher.service.ts`. `ingestEventId` keyed on `agentRunId`.
- [ ] `mission_tick` — `packages/agent/src/missions/mission-tick.service.ts` (`tickDue`, per matched Mission). `ingestEventId = mission-tick:${missionId}:${tickTimestamp}`.
- [ ] `idea_generated` — `packages/agent/src/user-research/work-proposal.service.ts` `generate` (covers Mission-tick + scheduled rerun). `ingestEventId` keyed on new WorkProposal id.
- [ ] (optional) `task_recurrence_fired` — `packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts` spawn path. Include if small; else defer.

### Scope + idempotency

- [ ] Every emitter stamps `userId`, `workId` (where applicable), `tenantId`, `organizationId` from the parent entity. Never NULL.
- [ ] Deterministic `ingestEventId` on every emitter (dedupe on `activity_log` partial-unique `(workId, ingestEventId)`).

### Tests

- [ ] Per-emitter unit — one row, right `actionType`, scope set, stable `ingestEventId`.
- [ ] Idempotency — second dispatch with same `ingestEventId` writes no duplicate.
- [ ] Feed — `activity-feed.service` surfaces cron-emitted `schedule_executed`.

---

## Phase 3 (P3) — Controls polish

### API / contracts

- [ ] Populate `ScheduleDto.controls` per source in `schedules.service.ts`.
- [ ] Confirm NO new mutation endpoints — all controls map to existing routes ([spec.md §4.6](spec.md#46-endpoints-reused-by-p3-controls-no-new-write-endpoints)).

### Web

- [ ] `ScheduleControlsMenu.tsx` — trailing menu, only enabled controls.
- [ ] Run-now → mapped endpoint (`agents :id/run-now`, `me/missions :id/run-now`, `works/:id/schedule/run`, `works/:id/sync-data`); toast + optimistic state.
- [ ] Pause/Resume → `agents :id/pause|resume`, `me/missions :id/pause|resume`, `PUT works/:id/schedule` status; flip status pill.
- [ ] Change-period dialog → RRULE builder (tasks) / cron/interval input; PATCH owning entity (`tasks :id/recurring`, `PATCH agents :id`, `PATCH me/missions :id`, `PUT works/:id/schedule`, `PUT works/:id/source-validation`, data-sync interval).
- [ ] Reuse existing server actions/BFF routes (e.g. `app/actions/dashboard/work-schedule.ts`); add thin actions for agents/missions where none exist.
- [ ] Re-fetch `GET /api/schedules` after any mutation.

### Tests

- [ ] Unit — controls menu renders only enabled controls per `ScheduleDto.controls`.
- [ ] E2E — pause a Work schedule from Schedules view → pill flips → `work_schedules.status = paused`.
- [ ] E2E — run-now an Agent heartbeat → `agent_heartbeat_started` appears in Log tab (needs P2).

---

## Cross-cutting

- [ ] No existing UI strings changed other than the two renamed values (NN #20).
- [ ] No new tables/columns; the only schema-adjacent change is two additive enum members (no migration).
- [ ] Every emitter respects Tenant/Org scope stamping (Tier C rule).
- [ ] All PRs target `develop`; never `main`/`stage` directly (NN #21).
- [ ] Green CI (typecheck, lint, agent suite) on every PR.

---

## JIRA linkage

JIRA Epic and per-phase Stories live in the `EW` project at <https://evertech.atlassian.net> (keys assigned at ticket creation):

- **Epic:** EW-TBD — Schedules (unified Activity → Schedules view + activity coverage)
    - P1 — Rename + toggle + aggregation endpoint + Schedules list: EW-TBD
    - P2 — Activity-gap emitters: EW-TBD
    - P3 — Controls polish: EW-TBD
