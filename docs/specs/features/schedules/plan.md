# Schedules — Implementation Plan

**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)

> This plan is **additive**. It adds one read-only endpoint, one in-page toggle, one new view, and a set of activity-log emitters on cron paths that currently emit nothing. It removes and renames **nothing internal** — the `ActivityLog` entity, `activity_log` table, `ActivityLogService`, and `/activity-log` routes are untouched. The only "rename" is two user-facing i18n string values.

The plan is **3 phases** matching the spec's P1/P2/P3. Each phase ships as one PR against `develop` (P1 may split into an API PR + a web PR if review-friendly).

---

## Phase 1 (P1) — Rename + toggle + aggregation endpoint + Schedules list

**Goal:** A working `Log | Schedules` toggle on the (renamed) Activity page, with a read-only Schedules list backed by `GET /api/schedules`.

### 1a. Rename (i18n values only)

1. Edit `apps/web/messages/en.json`:
    - `dashboard.activity.title` (line ~1219): `"Activity Log"` → `"Activity"`.
    - `metadata.pages.activity` (line ~5053): `"Activity Log"` → `"Activity"`.
2. Mirror the same value change into all 20 sibling locales (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh`), translating to each locale's word for "Activity" (drop the "Log" qualifier). Keys unchanged.
3. **Do not touch** entity/table/service class names, `/activity-log` API paths, i18n keys, or the `activity-log.csv` filename ([spec.md §3.2](spec.md#32-what-must-not-change-hard-invariants)).

### 1b. Contracts

1. New `packages/contracts/src/api/schedule/`:
    - `schedule.enum.ts` — `ScheduleSourceType` (6 members per [spec.md §4.2](spec.md#42-response-dto)).
    - `schedule.dto.ts` — `ScheduleDto`, `ScheduleControls`, `SchedulesResponseDto`.
    - Export from `packages/contracts/src/api/index.ts`.

### 1c. API — aggregation endpoint

1. New module `apps/api/src/schedules/`:
    - `schedules.module.ts` — imports the repositories/services for tasks, agents, work-schedules, missions, works.
    - `schedules.controller.ts` — `GET /api/schedules` (auth-guarded, scope-aware), optional query params `sourceType`, `entityKind`, `enabledOnly`. OpenAPI annotations so the MCP server picks it up.
    - `schedules.service.ts` — `getSchedules(userId, scope, filters)`:
        1. Run six scoped source queries via the existing repositories ([spec.md §4.3](spec.md#43-how-the-service-queries-each-source)) — `TaskRepository`, `AgentRepository`, `WorkScheduleRepository` (join `works` for name), `MissionRepository`, `WorkRepository` (×2 for source-validation + data-sync).
        2. Map each row to `ScheduleDto` (status normalization per [spec.md §4.5](spec.md#45-status-normalization); links per [spec.md §5.4](spec.md#54-owning-entity-links-scheduledtolink)).
        3. Compute `nextRunAt` for cron sources via `computeNextCronFire` and `cadenceHuman` via `describeCadence` ([spec.md §4.4](spec.md#44-cadence--next-run--human-text-server-side-helpers)).
        4. Sort by `nextRunAt` asc (null last); build `countsByType`; return `SchedulesResponseDto`.
        5. `controls` returns all-`false` in P1.
2. Scope: consume the request-scoped `ScopeContext` (from the Tenants work); filter `userId` always, `organizationId` when an Org scope is active, `organizationId IS NULL` (+ legacy `tenantId IS NULL`) in bare-Tenant scope. If the Tenants scope plumbing is not yet deployed in the target environment, fall back to `userId`-only (both are correct supersets for a single-scope user).
3. Helpers:
    - Extend `packages/agent/src/missions/cron-matcher.ts` with `computeNextCronFire(expr, from)` (bounded forward walk reusing `matchesCron`).
    - `describeCadence(sourceType, raw)` in `schedules.service.ts` — RRULE→text via the existing `recurrence.ts` helper, cron→text, `WorkScheduleCadence`→label, interval-minutes→"Every N minutes".

### 1d. Web — toggle + Schedules view

1. `activity-client.tsx`:
    - Add `activeTab: 'log' | 'schedules'` state + `activity-tab` localStorage persistence (mirror the `viewMode` pattern at lines 60–68).
    - Render the segmented control above `PageHeader`.
    - Gate the body: `log` → today's tree unchanged; `schedules` → `<SchedulesView />`, hiding the Log-specific chrome (status cards, filters, `ViewModeSwitch`, Export, 5s activity poll).
    - Optional `?tab=schedules` reflection via the existing `router.replace` block (lines 72–84).
2. `apps/web/src/app/actions/schedules.ts` — `getSchedules(filters)` server action (auth-guarded; mirror `app/actions/activity-log.ts`).
3. `apps/web/src/lib/api/schedules.ts` — `schedulesAPI.getAll(filters)` via `serverFetch` (server-only; attach `X-Scope-Slug`).
4. `apps/web/src/components/activity-log/schedules/`:
    - `SchedulesView.tsx` (fetch + summary strip + list/cards + filter state).
    - `ScheduleRow.tsx`, `ScheduleCard.tsx`.
    - `SchedulesFilters.tsx` (source-type chips + "Active only").
    - `SchedulesEmptyState.tsx`.
5. i18n: additive keys `dashboard.activity.tabs.{log,schedules}` and `dashboard.activity.schedules.*` across all locales.

**Out of scope this phase:** any mutation from the Schedules view (P3); any activity emitter changes (P2).

**Tests:**

- `schedules.service.spec.ts` — each source maps correctly; scope filter applied; status normalization; sort order (null-last); `countsByType`.
- `schedules.controller.spec.ts` — auth guard; query-param filters.
- Web unit: toggle persistence; `schedules` tab hides Log chrome; empty state.
- E2E: seed one of each source type → `/activity`, switch to Schedules → all six rows render with cadence + next-run.

---

## Phase 2 (P2) — Activity-gap emitters

**Goal:** Automated cron fires write `activity_log` rows so the Log tab (and the per-Work activity feed) show them — not just manual CRUD.

### 2a. Enum

1. Append `MISSION_TICK = 'mission_tick'` and `IDEA_GENERATED = 'idea_generated'` to `ActivityActionType` in `packages/agent/src/entities/activity-log.types.ts` (additive; `actionType` is `varchar(50)`, **no migration**).

### 2b. Emitters ([spec.md §8](spec.md#8-activity-emission-gaps-to-close-p2))

1. **`schedule_executed` on the cron path** — `packages/agent/src/services/work-schedule-dispatcher.service.ts` (`dispatchDue` around `runScheduledUpdate`); mirror in the NestJS fallback `apps/api/src/works/tasks/work-schedule-dispatcher-cron.service.ts`. Deterministic `ingestEventId = schedule-exec:${workId}:${generationHistoryId}`.
2. **`agent_heartbeat_started/completed/failed`** — `packages/agent/src/agents/agent-run.service.ts` run lifecycle, guarded by `triggerKind === 'heartbeat'`; optional `started` at claim in `agent-schedule-dispatcher.service.ts`. `ingestEventId` keyed on `agentRunId`.
3. **`mission_tick`** — `packages/agent/src/missions/mission-tick.service.ts` (`tickDue`, per matched Mission). `ingestEventId = mission-tick:${missionId}:${tickTimestamp}`.
4. **`idea_generated`** — `packages/agent/src/user-research/work-proposal.service.ts` `generate` (covers both Mission-tick generation and the scheduled user-research rerun). `ingestEventId` keyed on the new WorkProposal id.
5. **(optional) `task_recurrence_fired`** — `packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts` spawn path. Include if the diff stays small; else defer.

### 2c. Scope + idempotency

- Every emitter stamps `userId`, `workId` (where applicable), `tenantId`, `organizationId` from the **parent entity being processed** (Tier C scope-stamping rule). Never NULL.
- Deterministic `ingestEventId` on every emitter so Trigger.dev + NestJS-fallback double-fires dedupe on the `activity_log` partial-unique `(workId, ingestEventId)` index ([spec.md §7](spec.md#7-security)).

**Out of scope this phase:** any UI change; any new endpoint; `missions.lastTickAt` column (open question §11.1).

**Tests:**

- Per-emitter unit test: one `activity_log` row written with the right `actionType`, scope columns set, and stable `ingestEventId`.
- Idempotency test: a second dispatch with the same `ingestEventId` does not create a duplicate row.
- Feed test: `activity-feed.service` surfaces the new cron-emitted `schedule_executed` (whitelist already includes it).

---

## Phase 3 (P3) — Controls polish

**Goal:** Run-now / pause-resume / change-period directly from the Schedules view, each delegating to an existing per-entity endpoint.

### 3a. Contracts / API

1. Populate `ScheduleDto.controls` per source in `schedules.service.ts` ([spec.md §4.6](spec.md#46-endpoints-reused-by-p3-controls-no-new-write-endpoints)) — e.g. `agent_heartbeat` → `{ runNow: true, pauseResume: true, changePeriod: true }`; `recurring_task` → `{ runNow: false, pauseResume: false, changePeriod: true }`; etc.
2. **No new mutation endpoints.** All controls map to existing routes ([spec.md §4.6 table](spec.md#46-endpoints-reused-by-p3-controls-no-new-write-endpoints)).

### 3b. Web

1. `ScheduleControlsMenu.tsx` — trailing "⋯" menu rendering only enabled controls.
2. Run-now: POST the mapped endpoint; toast; optimistic "running" state.
3. Pause/Resume: POST pause/resume (or `PUT works/:id/schedule` status); flip the status pill.
4. Change-period: dialog reusing the per-entity cadence editor (RRULE builder for tasks; cron/interval input otherwise); PATCH the owning entity.
5. Reuse existing server actions / BFF routes where present (e.g. `app/actions/dashboard/work-schedule.ts`); add thin server actions for agents/missions run-now/pause/resume if none exist.
6. After any mutation, re-fetch `GET /api/schedules`.

**Out of scope this phase:** schedule creation/deletion from this view (users do that on the entity's own page); run-now for `recurring_task` / `source_validation` (no endpoint today — open question §11.3).

**Tests:**

- Unit: controls menu renders only enabled controls per `ScheduleDto.controls`.
- E2E: pause a Work schedule from the Schedules view → status pill flips → row reflects `paused` on refetch → the underlying `work_schedules.status` is `paused`.
- E2E: run-now an Agent heartbeat → toast → an `agent_heartbeat_started` activity row appears in the Log tab (depends on P2).

---

## Cross-cutting concerns

### Additive-only / DB safety

- **No new tables, no new columns** for the read model. The only schema-adjacent change is two additive TypeScript enum members (no migration — `actionType` is `varchar(50)`).
- No DROP / ALTER / data deletion anywhere.

### Scope correctness

- The aggregation and every emitter respect the Tenant/Org scope columns (Tier A on the owning entities; Tier C stamping on emitted `activity_log` rows). Reuse `ScopeContext`; do not invent a parallel scoping path.

### Tests

Each phase ships with unit + integration tests; P1/P3 add E2E flows on the real Activity page. The bar: the existing agent test suites and the e2e suite stay green.

### Rollout

- **No feature flag needed.** P1 is a read-only view behind an in-page toggle defaulting to `log`; P2 adds rows to an existing feed; P3 reuses guarded endpoints. Deploy in phase order via the standard `develop → stage → main` cascade.

---

## Sequencing summary

| Phase | Title                                                   | Depends on                               | PR target |
| ----- | ------------------------------------------------------- | ---------------------------------------- | --------- |
| P1    | Rename + toggle + `GET /api/schedules` + Schedules list | — (Tenants scope columns already landed) | `develop` |
| P2    | Activity-gap emitters                                   | — (independent of P1 UI)                 | `develop` |
| P3    | Controls polish                                         | P1                                       | `develop` |

P1 and P2 can proceed in parallel. P3 depends on P1's view shell; P3's run-now E2E assertion depends on P2's emitters.
