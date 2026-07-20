# Schedules — Product Spec

**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-07-18
**Audience:** Product, Engineering (backend + frontend), Design
**Internal codename:** "Cadence"
**Related code today:**

- Activity page — [`apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>) (view-mode persistence at lines 60–68; URL-sync block at 72–84), RSC entry [`activity/page.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/activity/page.tsx>), route `ROUTES.DASHBOARD_ACTIVITY = '/activity'` ([`apps/web/src/lib/constants.ts:70`](../../../../apps/web/src/lib/constants.ts)), sidebar entry [`DashboardSidebar.tsx:128`](../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx).
- i18n rename targets — [`apps/web/messages/en.json`](../../../../apps/web/messages/en.json) `dashboard.activity.title` (line ~1219) and `metadata.pages.activity` (line ~5053), plus the 20 sibling locale files in `apps/web/messages/`.
- ActivityLog — entity [`packages/agent/src/entities/activity-log.entity.ts`](../../../../packages/agent/src/entities/activity-log.entity.ts) (`@Entity('activity_log')`), enum [`activity-log.types.ts`](../../../../packages/agent/src/entities/activity-log.types.ts) (`ActivityActionType`), service [`packages/agent/src/activity-log/activity-log.service.ts`](../../../../packages/agent/src/activity-log/activity-log.service.ts).
- Scheduled sources — recurring `tasks` ([`task.entity.ts`](../../../../packages/agent/src/entities/task.entity.ts)), `agents` heartbeats ([`agent.entity.ts`](../../../../packages/agent/src/entities/agent.entity.ts)), `work_schedules` ([`work-schedule.entity.ts`](../../../../packages/agent/src/entities/work-schedule.entity.ts)), `missions` scheduled ticks ([`mission.entity.ts`](../../../../packages/agent/src/entities/mission.entity.ts)), item source-validation + data-sync columns on `works` ([`work.entity.ts`](../../../../packages/agent/src/entities/work.entity.ts)).
- Cron dispatchers (activity-gap emitters) — [`work-schedule-dispatcher.service.ts`](../../../../packages/agent/src/services/work-schedule-dispatcher.service.ts), [`agent-schedule-dispatcher.service.ts`](../../../../packages/agent/src/agents/agent-schedule-dispatcher.service.ts) + [`agent-run.service.ts`](../../../../packages/agent/src/agents/agent-run.service.ts), [`mission-tick.service.ts`](../../../../packages/agent/src/missions/mission-tick.service.ts), [`work-proposal.service.ts`](../../../../packages/agent/src/user-research/work-proposal.service.ts).
- Control endpoints reused by the Schedules view — `POST /api/agents/:id/run-now|pause|resume`, `POST /api/me/missions/:id/run-now|pause|resume`, `POST works/:id/schedule/run`, `PUT/DELETE works/:id/schedule`.

> **Hard rule (NN #20 — additive by default):** this feature EXTENDS the existing Activity page and the per-entity scheduling surfaces. It removes and renames **nothing internal** — not the `ActivityLog` entity, the `activity_log` table, `ActivityLogService`, the `/activity-log` API paths, the i18n _keys_, or the `activity-log.csv` export filename. The only "rename" is two user-facing i18n string **values** ("Activity Log" → "Activity"). Every column, endpoint, component, and enum member below is added on top of what ships today.

---

## 0. TL;DR

Today a user's recurring machinery is scattered: recurring Tasks live on the Task detail, Agent heartbeats on Agent settings, Work scheduled generations on the Work schedule page, Mission ticks on the Mission detail, item source-validation on a Work card, data-sync on another Work card. There is **no single place to answer "what is scheduled to run, and when."** And the cron paths that actually fire these schedules write **run records** (`AgentRun`, `WorkGenerationHistory`) or Trigger.dev summaries — **not `ActivityLog` rows** — so automated runs are invisible in the Activity feed.

This spec does three things:

1. **Renames the user-facing page** "Activity Log" → **"Activity"** (two i18n values only).
2. Adds a **`Log | Schedules` toggle** inside the existing Activity page. `Log` is today's activity feed, unchanged. `Schedules` is a new **read-only aggregated view of everything scheduled** — one row per recurring Task / Agent heartbeat / Work schedule / Mission tick / source-validation check / data-sync poll, showing cadence, next run, status.
3. **Closes the activity-emission gaps** so automated cron fires (`schedule_executed`, `agent_heartbeat_*`, new `mission_tick` / `idea_generated`) land in the same `activity_log` the Log tab reads.

```
                     ┌──────────────────────────────────────────────┐
                     │  /activity   (page header: "Activity")       │
                     │  ┌───────────────┐                           │
                     │  │ Log │Schedules│  ← segmented toggle        │
                     │  └───────────────┘    (persist: activity-tab) │
                     ├──────────────────────┬───────────────────────┤
   (unchanged) ◄─────┤  LOG                 │  SCHEDULES  (new)      │
   status cards      │  ActivityTable /     │  GET /api/schedules    │
   filters, export   │  ActivityKanbanView  │  union of 6 sources:   │
   5s poll           │  reads activity_log  │   • recurring tasks    │
                     │                      │   • agent heartbeats   │
                     │                      │   • work schedules     │
                     │                      │   • mission ticks      │
                     │                      │   • source-validation  │
                     │                      │   • data-sync          │
                     └──────────────────────┴───────────────────────┘
                                 ▲                       │
      P2: cron paths emit ───────┘        P3: run-now / pause-resume /
      ActivityLog rows so the             change-period reuse EXISTING
      LOG tab shows automated             per-entity endpoints
      fires, not just manual CRUD
```

- **P1** — rename + toggle + aggregation endpoint + read-only Schedules list.
- **P2** — activity-gap emitters (make automated fires show up in the Log tab).
- **P3** — inline controls (run-now / pause-resume / change-period) wired to existing endpoints.

Nothing scheduled is _created_ or _deleted_ from this view in P1. It is a **reader** over data that already exists in six tables.

---

## 1. Concepts

### 1.1 "Activity" (renamed page) vs "Activity Log" (internal name)

The dashboard page at `/activity` is **user-facing "Activity"** from now on. Internally the concept, table, entity, service, and API stay **"Activity Log" / `activity_log`**. This is a wording-only change to two strings (§3.1). The sidebar label is _already_ "Activity" (`dashboard.sidebar.navigation.activity`) — no change there.

### 1.2 Log vs Schedules — two views of the same domain

|                     | **Log** (existing)                                   | **Schedules** (new)                                     |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Question it answers | "What _happened_?"                                   | "What _is scheduled_ to happen?"                        |
| Data                | `activity_log` rows (run history / events)           | union of 6 per-entity schedule tables                   |
| Shape               | reverse-chron feed, 5s poll, paginated               | one row per active schedule, sorted by next run         |
| Mutability          | read-only (with existing Stop control)               | read-only in P1; run-now/pause/period in P3             |
| Backing call        | `getActivityLog` server action → `/api/activity-log` | `getSchedules` server action → **`GET /api/schedules`** |

The two are complementary: a **Schedule** row is the _definition_ ("Work X regenerates every day at 09:00"); a **Log** row is an _occurrence_ ("Work X schedule_executed at 09:00 today"). P2 makes those occurrences actually appear in the Log for automated fires.

### 1.3 A "Schedule" (the aggregation unit)

A **Schedule** is a synthetic, read-model row unifying six heterogeneous sources. It is **not a new table** — it is projected on the fly from the owning entity. Every Schedule has:

- a **source type** (which mechanism),
- an **owning entity** (Task / Agent / Work / Mission) with a link,
- a **cadence** (raw + human-readable),
- a **next run** (persisted or computed from the cadence),
- a **status** and an **enabled** flag,
- and, in P3, an **available-controls** descriptor.

The six source types (v1):

| Source type (`ScheduleSourceType`) | Owning entity | "What is scheduled"                                           |
| ---------------------------------- | ------------- | ------------------------------------------------------------- |
| `recurring_task`                   | Task          | A recurring Task template spawns instances on its RRULE.      |
| `agent_heartbeat`                  | Agent         | An Agent wakes on its heartbeat cadence to do scheduled work. |
| `work_schedule`                    | Work          | A Work regenerates its content on a cadence.                  |
| `mission_tick`                     | Mission       | A scheduled Mission generates Ideas on a cron.                |
| `source_validation`                | Work          | A Work re-checks item source reachability on a cadence.       |
| `data_sync`                        | Work          | A Work polls its data repo for changes on an interval.        |

Maintenance / platform-global crons (KB reconcile, notification cleanup, cache warm-up, etc.) are **explicitly out of scope** — they are not user-owned schedules (§9).

---

## 2. Data model

**No new tables. No new columns for P1's read model.** The Schedules view is a projection over existing entity columns. The only schema-adjacent change is **two additive `ActivityActionType` enum members** in P2 (§2.3).

### 2.1 Source columns the aggregation reads (all already exist)

| Source type         | Table                             | Columns read                                                                                                                                                                                     | Enabled predicate                                                                                |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `recurring_task`    | `tasks`                           | `isRecurring`, `recurrenceRule`, `recurrenceTimezone`, `nextOccurrenceAt`, `recurrenceEndsAt`, `recurrenceMaxOccurrences`, `recurrenceOccurredCount`, `parentRecurringTaskId`, `title`, `userId` | `isRecurring = true AND parentRecurringTaskId IS NULL` (templates only, never spawned instances) |
| `agent_heartbeat`   | `agents`                          | `heartbeatCadence`, `nextHeartbeatAt`, `status`, `lastRunStatus`, `name`, `userId`                                                                                                               | `heartbeatCadence IS NOT NULL`                                                                   |
| `work_schedule`     | `work_schedules` (+ `works.name`) | `cadence`, `status`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `workId`, `userId`                                                                                                               | `status IN (active, paused)` (surface disabled/canceled greyed)                                  |
| `mission_tick`      | `missions`                        | `schedule` (cron), `type`, `status`, `title`, `userId`                                                                                                                                           | `type = 'scheduled'`                                                                             |
| `source_validation` | `works`                           | `sourceValidationEnabled`, `sourceValidationCadence`, `sourceValidationNextRunAt`, `sourceValidationLastRunAt`, `name`, `userId`                                                                 | `sourceValidationEnabled = true`                                                                 |
| `data_sync`         | `works`                           | `syncIntervalMinutes`, `lastPolledAt`, `pendingSyncRequestedAt`, `lastSyncedDataRepoSha`, `name`, `userId`                                                                                       | `syncIntervalMinutes IS NOT NULL AND syncIntervalMinutes > 0`                                    |

> **Missions carry no persisted `nextRunAt`/`lastRunAt`.** The tick worker matches the cron string every minute (`packages/agent/src/missions/cron-matcher.ts`) rather than storing a next-fire timestamp. So for `mission_tick`, `nextRunAt` is **computed** from `missions.schedule` at query time (see §4.4) and `lastRunAt` is **`null` in P1** — it becomes derivable once P2 emits `mission_tick` ActivityLog rows (§8). This asymmetry is deliberate; see §9 open question.

### 2.2 Scope columns (Tier A convention, EW-651)

Every owning entity in §2.1 (`tasks`, `agents`, `work_schedules`, `missions`, `works`) is a **Tier A** entity and carries `tenantId` + `organizationId` per the Tenants & Organizations rollout ([tenants-and-organizations/spec.md §2.3](../tenants-and-organizations/spec.md)). The aggregation endpoint therefore scopes exactly like every other Tier A read:

- Always filter `userId = :currentUserId`.
- When an Organization scope is active (resolved via `ScopeContext.organizationId` / the `X-Scope-Slug` header), additionally filter `organizationId = :activeOrgId`.
- When the bare-Tenant scope is active, filter `organizationId IS NULL` (plus legacy `tenantId IS NULL` rows for the owning user), consistent with §2.2 of the Tenants spec.

No new scope columns are introduced. The Schedules read piggybacks on columns that already land in Tier A Phase 3.

### 2.3 New `ActivityActionType` members (P2 only)

Two additive enum members in [`packages/agent/src/entities/activity-log.types.ts`](../../../../packages/agent/src/entities/activity-log.types.ts) — appended, nothing reordered or removed:

```ts
// Missions / Ideas (NEW — no mission_*/idea_* members exist today)
((MISSION_TICK = 'mission_tick'), (IDEA_GENERATED = 'idea_generated'));
```

The `schedule_*` (`schedule_created/updated/deleted/executed`), `agent_heartbeat_started/completed/failed`, and `task_recurrence_fired` members **already exist** in the enum — P2 only adds _emitters_ for them, no enum change. This is additive and requires **no migration** (`actionType` is a free `varchar(50)` column; the enum is a TypeScript-side constraint only).

---

## 3. The rename — "Activity Log" → "Activity"

### 3.1 Exact edit surface (P1)

Change **only the string values**, never the keys, in `apps/web/messages/en.json`:

| Key                        | Line (approx) | Today            | After        |
| -------------------------- | ------------- | ---------------- | ------------ |
| `dashboard.activity.title` | ~1219         | `"Activity Log"` | `"Activity"` |
| `metadata.pages.activity`  | ~5053         | `"Activity Log"` | `"Activity"` |

Then mirror the same value change into all 20 sibling locale files (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk, vi, zh`), translating to each locale's word for "Activity" and **dropping the "Log" qualifier** (e.g. de `"Aktivität"`, fr `"Activité"`, es `"Actividad"`, ru `"Активность"`). Do not half-translate — every locale gets both values updated.

Optional (Product's call, not required): reword `dashboard.activity.subtitle` ("Track all operations across your works"). Left as-is unless Design asks.

### 3.2 What must NOT change (hard invariants)

- The `ActivityLog` entity, `@Entity('activity_log')` table, `ActivityLogService`, `ActivityLogRepository`, `ActivityLogModule` — untouched.
- All `/activity-log` API routes (`apps/api/src/activity-log/activity-log.controller.ts`) — untouched.
- The i18n **keys** `dashboard.activity.*` and `metadata.pages.activity` — untouched (values only).
- The CSV export filename `activity-log.csv` ([activity-client.tsx:272](<../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>), [export route](../../../../apps/web/src/app/api/activity-log/export/route.ts)) — internal, leave it.
- The sidebar label — already "Activity", no change.

---

## 4. API surface

### 4.1 New endpoint: `GET /api/schedules`

A single read-only aggregation endpoint. Auth-guarded (standard `@CurrentUser()`), scope-aware (§2.2), no body.

- **Module/controller:** new `apps/api/src/schedules/schedules.controller.ts` + `schedules.module.ts`.
- **Service:** new `apps/api/src/schedules/schedules.service.ts` — runs the six scoped source queries, maps each to `ScheduleDto`, unions, sorts.
- **Query params (all optional):**
    - `sourceType` — filter to one `ScheduleSourceType`.
    - `enabledOnly` — `true` to drop disabled/paused rows.
    - `entityKind` — filter to `task | agent | work | mission`.
    - (No pagination in P1 — per-user schedule counts are small; add cursor pagination later if a user exceeds a few hundred, see §9.)

### 4.2 Response DTO

Defined in `packages/contracts/src/api/schedule/` (new) so the MCP server and web client share the type.

```ts
export enum ScheduleSourceType {
	RECURRING_TASK = 'recurring_task',
	AGENT_HEARTBEAT = 'agent_heartbeat',
	WORK_SCHEDULE = 'work_schedule',
	MISSION_TICK = 'mission_tick',
	SOURCE_VALIDATION = 'source_validation',
	DATA_SYNC = 'data_sync'
}

export interface ScheduleControls {
	runNow: boolean; // P3 — is a run-now endpoint wired for this source?
	pauseResume: boolean; // P3 — can it be paused/resumed?
	changePeriod: boolean; // P3 — can the cadence be edited from here?
}

export interface ScheduleDto {
	id: string; // synthetic stable key: `${sourceType}:${entityId}`
	sourceType: ScheduleSourceType;
	entityKind: 'task' | 'agent' | 'work' | 'mission';
	entityId: string; // owning entity id (taskId | agentId | workId | missionId)
	title: string; // owning entity display name (task title / agent name / work name / mission title)
	link: string; // web route to the owning entity (see §5.4)
	cadence: string | null; // raw cadence (RRULE | cron | WorkScheduleCadence | 'PT15M'-style)
	cadenceHuman: string; // human-readable ("Every day at 09:00", "Every 15 minutes")
	nextRunAt: string | null; // ISO 8601; computed for cron/RRULE sources
	lastRunAt: string | null; // ISO 8601; null for sources that don't persist it (missions P1)
	lastRunStatus: string | null; // e.g. GenerateStatusType / agent lastRunStatus, when available
	status: string; // normalized status label (see §4.5)
	enabled: boolean; // whether this schedule is currently active/ticking
	controls: ScheduleControls; // P1 returns all-false; P3 populates
}

export interface SchedulesResponseDto {
	schedules: ScheduleDto[];
	total: number;
	countsByType: Record<ScheduleSourceType, number>;
}
```

### 4.3 How the service queries each source

`SchedulesService.getSchedules(userId, scope, filters)` runs six scoped queries (each via the existing repository for that entity — no raw cross-table UNION SQL, to keep scope filters and TypeORM entity mapping intact) and concatenates:

1. **`recurring_task`** — `TaskRepository`: `WHERE userId = :uid AND isRecurring = true AND parentRecurringTaskId IS NULL` (+ scope). Map: `cadence = recurrenceRule`, `nextRunAt = nextOccurrenceAt`, `enabled = recurrenceEndsAt IS NULL OR recurrenceEndsAt > now()` (and not exhausted by `recurrenceMaxOccurrences`).
2. **`agent_heartbeat`** — `AgentRepository`: `WHERE userId = :uid AND heartbeatCadence IS NOT NULL` (+ scope). Map: `cadence = heartbeatCadence`, `nextRunAt = nextHeartbeatAt`, `status = agent.status`, `lastRunStatus`, `enabled = status = 'active'`.
3. **`work_schedule`** — `WorkScheduleRepository` joined to `works` for the name: `WHERE ws.userId = :uid` (+ scope). Map: `cadence`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `status`, `enabled = status = 'active'`.
4. **`mission_tick`** — `MissionRepository`: `WHERE userId = :uid AND type = 'scheduled'` (+ scope). Map: `cadence = schedule`, `nextRunAt = computeNextCronFire(schedule, now)` (§4.4), `lastRunAt = null`, `status = mission.status`, `enabled = status = 'active'`.
5. **`source_validation`** — `WorkRepository`: `WHERE userId = :uid AND sourceValidationEnabled = true` (+ scope). Map: `cadence = sourceValidationCadence`, `nextRunAt = sourceValidationNextRunAt`, `lastRunAt = sourceValidationLastRunAt`, `enabled = true`.
6. **`data_sync`** — `WorkRepository`: `WHERE userId = :uid AND syncIntervalMinutes > 0` (+ scope). Map: `cadence = 'every ' + syncIntervalMinutes + ' min'`, `nextRunAt = lastPolledAt + syncIntervalMinutes` (or `now` if never polled), `lastRunAt = lastPolledAt`, `enabled = true`.

The endpoint then sorts by `nextRunAt` ascending with `null` last, computes `countsByType`, and returns. Six indexed reads per call (all owning tables have `(userId, …)` or `(status, nextRunAt)` indexes today); acceptable for an interactive page load.

### 4.4 Cadence → next-run + human text (server-side helpers)

- **Cron sources** (`mission_tick`): reuse/extend [`packages/agent/src/missions/cron-matcher.ts`](../../../../packages/agent/src/missions/cron-matcher.ts) to expose a `computeNextCronFire(expr, from)` (walk forward minute-by-minute up to a bounded horizon, matching the existing `matchesCron` logic — no new dependency required).
- **RRULE sources** (`recurring_task`): `nextRunAt` already persisted as `nextOccurrenceAt`; for `cadenceHuman`, use the RRULE-to-text helper the recurrence code already relies on ([`recurrence.ts`](../../../../packages/agent/src/tasks-domain/recurrence.ts)).
- **`cadenceHuman`** is produced by a provider-agnostic `describeCadence(sourceType, raw)` in `SchedulesService` — maps `WorkScheduleCadence` enum values to labels, RRULE → text, cron → text, interval-minutes → "Every N minutes". Kept server-side so all clients (web, MCP) get identical strings.

### 4.5 Status normalization

Each source has its own status enum; the DTO's `status` is a normalized label so the UI renders one pill vocabulary:

| DTO status | Mapped from                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`   | task recurring & not ended; `AgentStatus.ACTIVE`; `WorkScheduleStatus.ACTIVE`; `MissionStatus.ACTIVE`; source-validation/data-sync enabled                                       |
| `paused`   | `AgentStatus.PAUSED`; `WorkScheduleStatus.PAUSED`; `MissionStatus.PAUSED`                                                                                                        |
| `disabled` | `WorkScheduleStatus.DISABLED`; source-validation/data-sync when the underlying flag is off (these are excluded by the enabled predicate but the mapping exists for completeness) |
| `error`    | `AgentStatus.ERROR`; last `WorkScheduleStatus` after `maxFailureBeforePause` auto-pause; `MissionStatus.FAILED`                                                                  |
| `ended`    | recurring task past `recurrenceEndsAt` / exhausted `recurrenceMaxOccurrences`; `WorkScheduleStatus.CANCELED`; `MissionStatus.COMPLETED`                                          |

### 4.6 Endpoints reused by P3 controls (no new write endpoints)

The Schedules view issues no new mutations. Every control delegates to an existing, already-authz-guarded per-entity endpoint:

| Control           | Source type         | Existing endpoint                                                                                                                         |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Run now**       | `agent_heartbeat`   | `POST /api/agents/:id/run-now` ([agents.controller.ts:386](../../../../apps/api/src/agents/agents.controller.ts))                         |
|                   | `mission_tick`      | `POST /api/me/missions/:id/run-now` ([missions.controller.ts:230](../../../../apps/api/src/missions/missions.controller.ts))              |
|                   | `work_schedule`     | `POST works/:id/schedule/run` ([works.controller.ts:1244](../../../../apps/api/src/works/works.controller.ts))                            |
|                   | `data_sync`         | `POST works/:id/sync-data`                                                                                                                |
| **Pause**         | `agent_heartbeat`   | `POST /api/agents/:id/pause` ([agents.controller.ts:242](../../../../apps/api/src/agents/agents.controller.ts))                           |
|                   | `mission_tick`      | `POST /api/me/missions/:id/pause` ([missions.controller.ts:180](../../../../apps/api/src/missions/missions.controller.ts))                |
|                   | `work_schedule`     | `PUT works/:id/schedule` with `status: paused` ([works.controller.ts:1171](../../../../apps/api/src/works/works.controller.ts))           |
| **Resume**        | `agent_heartbeat`   | `POST /api/agents/:id/resume` ([agents.controller.ts:263](../../../../apps/api/src/agents/agents.controller.ts))                          |
|                   | `mission_tick`      | `POST /api/me/missions/:id/resume` ([missions.controller.ts:191](../../../../apps/api/src/missions/missions.controller.ts))               |
|                   | `work_schedule`     | `PUT works/:id/schedule` with `status: active`                                                                                            |
| **Change period** | `recurring_task`    | `POST /api/tasks/:id/recurring` (set/replace RRULE)                                                                                       |
|                   | `agent_heartbeat`   | `PATCH /api/agents/:id` with `{ heartbeatCadence }` ([agents.controller.ts:196](../../../../apps/api/src/agents/agents.controller.ts))    |
|                   | `mission_tick`      | `PATCH /api/me/missions/:id` with `{ schedule }` ([missions.controller.ts:145](../../../../apps/api/src/missions/missions.controller.ts)) |
|                   | `work_schedule`     | `PUT works/:id/schedule` with `{ cadence }`                                                                                               |
|                   | `source_validation` | `PUT works/:id/source-validation` with `{ cadence }`                                                                                      |
|                   | `data_sync`         | `PATCH works/:id` (or the data-sync settings PUT) with `{ syncIntervalMinutes }`                                                          |

`ScheduleDto.controls` tells the client which of these exist for a given row (recurring-task run-now and source-validation run-now have no dedicated endpoint today → `runNow: false`; those cells stay disabled until a follow-up adds them — see §9).

---

## 5. Web UI

### 5.1 The `Log | Schedules` toggle (inside `activity-client.tsx`)

A **segmented control** added inside the existing [`activity-client.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>). It sits **above the `PageHeader`** (or as the leading element of the page body) so it governs the whole view, not just the table.

- New state `activeTab: 'log' | 'schedules'`, initialized and persisted exactly like the existing `viewMode` at lines 60–68:

    ```ts
    const [activeTab, setActiveTab] = useState<'log' | 'schedules'>(() => {
    	if (typeof window === 'undefined') return 'log';
    	return (localStorage.getItem('activity-tab') as 'log' | 'schedules') || 'log';
    });
    const handleTabChange = (tab: 'log' | 'schedules') => {
    	setActiveTab(tab);
    	localStorage.setItem('activity-tab', tab);
    };
    ```

- Optional deep-linking: reflect `?tab=schedules` through the existing `router.replace` URL-sync block (lines 72–84). localStorage is the primary persistence; the query param is for shareable links.
- **When `activeTab === 'log'`:** render exactly today's tree — the `ViewModeSwitch`, `Export` button, the 5 status summary cards, `ActivityFilters`, and `ActivityTable`/`ActivityKanbanView`. Zero behavioral change.
- **When `activeTab === 'schedules'`:** hide the Log-specific chrome (status cards, `ActivityFilters`, `ViewModeSwitch`, `Export`, the 5s poll for activity rows) and render the new `<SchedulesView />`. The `PageHeader` title stays `t('title')` ("Activity"); a lightweight sub-label can read "Schedules".

Reasoning for keeping it inside one page (not a second sidebar entry): the sidebar has a single "Activity" item ([DashboardSidebar.tsx:128](../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx)); adding a nav item would be a heavier IA change and duplicate the route. The toggle mirrors the existing in-page `ViewModeSwitch` pattern users already know.

### 5.2 `SchedulesView` component

New components under `apps/web/src/components/activity-log/schedules/`:

- `SchedulesView.tsx` — fetches via a new server action `getSchedules` (§5.3); holds filter state (`sourceType`, `enabledOnly`); renders a summary strip (counts per type from `countsByType`), then a list or card grid.
- `ScheduleRow.tsx` (table) / `ScheduleCard.tsx` (card) — one Schedule: a **source-type badge**, the **title** as a link to the owning entity (§5.4), **cadenceHuman**, **nextRunAt** as a relative time ("in 3h"), **status pill** (using the same status-pill vocabulary as the Log tab where possible), and an **enabled** indicator. In P3 a trailing **controls menu** (§5.5).
- `SchedulesEmptyState.tsx` — "Nothing scheduled yet" with links to create a recurring Task / set a Work schedule / create a scheduled Mission.
- `SchedulesFilters.tsx` — a small source-type filter (chips) + "Active only" toggle. Deliberately lighter than `ActivityFilters` (no free-text search in P1).

The Schedules view **may reuse the `ViewModeSwitch` (table/card)** if Design wants parity with the Log tab, persisted under a separate key `schedules-view-mode`. Optional for P1.

### 5.3 Data plumbing (mirror the activity-log pattern)

- **Server action:** new `apps/web/src/app/actions/schedules.ts` exporting `getSchedules(filters)` (auth-guarded, same shape as [`app/actions/activity-log.ts`](../../../../apps/web/src/app/actions/activity-log.ts)).
- **API client:** new `apps/web/src/lib/api/schedules.ts` (`schedulesAPI.getAll(filters)` via `serverFetch`, server-only) — mirrors [`lib/api/activity-log.ts`](../../../../apps/web/src/lib/api/activity-log.ts). The `X-Scope-Slug` header (from the Tenants work) is attached so the API applies the active Organization scope.
- The Schedules list does **not** need a BFF route handler in P1 (like the activity list, it goes through the server action). P3 control calls reuse existing server actions / BFF routes where they already exist (e.g. Work schedule mutations already have [`app/actions/dashboard/work-schedule.ts`](../../../../apps/web/src/app/actions/dashboard/work-schedule.ts)).

### 5.4 Owning-entity links (`ScheduleDto.link`)

| Source type         | Link target                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `recurring_task`    | Task detail (`/tasks/:id` equivalent)                                                                                                        |
| `agent_heartbeat`   | Agent detail / settings                                                                                                                      |
| `work_schedule`     | `works/:id/generator/schedule` ([existing page](<../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/generator/schedule/page.tsx>)) |
| `mission_tick`      | Mission detail                                                                                                                               |
| `source_validation` | Work detail (source-validation card)                                                                                                         |
| `data_sync`         | Work detail (data-sync card)                                                                                                                 |

`link` is computed server-side from route constants so the client stays dumb.

### 5.5 Controls menu (P3)

A trailing "⋯" menu per row exposes only the controls where `ScheduleDto.controls.*` is `true`:

- **Run now** — POSTs the run-now endpoint (§4.6); toast on success; optimistic "running" state.
- **Pause / Resume** — toggles via the pause/resume (or `PUT schedule status`) endpoint; the row's status pill flips.
- **Change period** — opens a small dialog reusing the per-entity cadence editor (RRULE builder for tasks, cron/interval input for the others) and PATCHes the owning entity.

All three are thin wrappers over existing endpoints — no new mutation surface, no new authz. Destructive-cancel (deleting a schedule) is intentionally **not** offered from this view in P3; users cancel from the entity's own page.

---

## 6. Plugin points

None required. This feature reads first-party entity tables and reuses first-party endpoints. It introduces no plugin contract, no new pipeline step, and no provider surface. (If a future plugin wants to register its own schedule source, that would be a `ScheduleSourceType` extension + a provider interface — flagged as out-of-scope in §9, not built here.)

---

## 7. Security

- **Read isolation:** `GET /api/schedules` returns **only the caller's own rows** — every source query is filtered `userId = :currentUserId` plus the active Organization scope (§2.2). No cross-user or cross-org leakage is possible because there is no "all schedules" path that bypasses the user filter.
- **No new write surface (P1/P2):** the aggregation is read-only; P2 emitters write `activity_log` rows in worker context only.
- **P3 controls inherit existing guards:** every control calls a per-entity endpoint that already enforces ownership (the IDOR guards hardened in EW-711 / EW-712 across `agents`, `missions`, `works`). The Schedules view adds **no** new authorization logic — if a user can't pause Agent X from the Agent page today, the same 403/404 applies here.
- **Cron-emitter idempotency (P2):** the work-schedule dispatcher has both a Trigger.dev path and a NestJS `@Cron` fallback ([`work-schedule-dispatcher-cron.service.ts`](../../../../apps/api/src/works/tasks/work-schedule-dispatcher-cron.service.ts)); only one runs per environment (gated by `shouldUseTrigger`), but retries can double-fire. Emitters MUST set a **deterministic `ingestEventId`** (e.g. `schedule-exec:${workId}:${generationHistoryId}`) so the `activity_log` partial-unique index `(workId, ingestEventId)` dedupes duplicate rows. Same rule for `agent_heartbeat_*` (key on `agentRunId`) and `mission_tick` (key on `missionId:tickTimestamp`).
- **Scope stamping on emitted rows:** P2 emitters run outside a request context, so they must stamp `userId`, `workId` (where applicable), `tenantId`, and `organizationId` from the **parent entity being processed** — consistent with the Tier C scope-stamping rule ([tenants-and-organizations/spec.md §2.3](../tenants-and-organizations/spec.md)). Never leave these NULL on cron-emitted activity.

---

## 8. Activity-emission gaps to close (P2)

Each row below is a cron/worker path that fires a schedule today but writes **no `activity_log` row** (it writes a run record or a Trigger.dev summary instead). P2 adds the emitter. All use `ActivityLogService.log(...)` with a deterministic `ingestEventId` (§7).

| #            | Emitter file to touch                                                                                                                                                                                                                                                                                                                                                              | Action type                                                                        | When it fires                                                                                          | Enum status today                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1            | [`packages/agent/src/services/work-schedule-dispatcher.service.ts`](../../../../packages/agent/src/services/work-schedule-dispatcher.service.ts) (`dispatchDue` → around `runScheduledUpdate`); mirror in the NestJS fallback [`apps/api/src/works/tasks/work-schedule-dispatcher-cron.service.ts`](../../../../apps/api/src/works/tasks/work-schedule-dispatcher-cron.service.ts) | `schedule_executed`                                                                | An automated (non-manual) Work scheduled generation is dispatched                                      | **exists** (only the manual `POST works/:id/schedule/run` emits it today)                                |
| 2            | [`packages/agent/src/agents/agent-run.service.ts`](../../../../packages/agent/src/agents/agent-run.service.ts) run lifecycle (guarded by `triggerKind === 'heartbeat'`); `started` may also be emitted at claim in [`agent-schedule-dispatcher.service.ts`](../../../../packages/agent/src/agents/agent-schedule-dispatcher.service.ts)                                            | `agent_heartbeat_started` / `agent_heartbeat_completed` / `agent_heartbeat_failed` | A heartbeat-triggered Agent run starts / completes / fails                                             | **exist** (declared, emitted nowhere)                                                                    |
| 3            | [`packages/agent/src/missions/mission-tick.service.ts`](../../../../packages/agent/src/missions/mission-tick.service.ts) (`tickDue`, per matched Mission)                                                                                                                                                                                                                          | `mission_tick`                                                                     | A scheduled Mission's cron matches and a tick runs                                                     | **NEW** (§2.3)                                                                                           |
| 4            | [`packages/agent/src/user-research/work-proposal.service.ts`](../../../../packages/agent/src/user-research/work-proposal.service.ts) `generate` (and the call site in `mission-tick.service.ts` where `WorkProposalService.generate({ source: MISSION })` runs)                                                                                                                    | `idea_generated`                                                                   | An Idea (WorkProposal) is generated — whether from a Mission tick or the scheduled user-research rerun | **NEW** (§2.3)                                                                                           |
| 5 (optional) | [`packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts`](../../../../packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts) (spawn path)                                                                                                                                                                                                          | `task_recurrence_fired`                                                            | A recurring Task template spawns an instance                                                           | **exists** (only an in-app notification `task_recurrence_fired` is emitted today, no `activity_log` row) |

Notes:

- Row 5 is flagged **optional** — it closes an adjacent gap the same way, and the enum member (`TASK_RECURRENCE_FIRED`) already exists. Include it in P2 if the diff is small; otherwise defer to a follow-up.
- The activity-feed whitelist [`apps/api/src/works/activity-feed/activity-feed.service.ts`](../../../../apps/api/src/works/activity-feed/activity-feed.service.ts) already lists the `schedule_*` types, so once row 1 emits on the cron path, **automated scheduled runs immediately appear in the per-Work activity feed** with no further wiring.
- After P2, the **Log tab** answers "did my schedules actually run?" for automated fires — closing the loop with the Schedules tab's "what is scheduled."

---

## 9. Naming

| Surface                        | Name                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| User-facing page               | **Activity** (renamed value)                                                                                             |
| In-page tabs                   | **Log** / **Schedules**                                                                                                  |
| Internal entity/table/service  | `ActivityLog` / `activity_log` / `ActivityLogService` (unchanged)                                                        |
| New endpoint                   | `GET /api/schedules`                                                                                                     |
| New NestJS module              | `SchedulesModule` / `SchedulesController` / `SchedulesService` (`apps/api/src/schedules/`)                               |
| New contract types             | `ScheduleDto`, `SchedulesResponseDto`, `ScheduleSourceType`, `ScheduleControls` (`packages/contracts/src/api/schedule/`) |
| New web components             | `apps/web/src/components/activity-log/schedules/*`                                                                       |
| New server action / API client | `app/actions/schedules.ts`, `lib/api/schedules.ts`                                                                       |
| New localStorage key           | `activity-tab` (values `'log'                                                                                            | 'schedules'`); optional `schedules-view-mode` |
| New i18n keys (additive)       | `dashboard.activity.tabs.log`, `dashboard.activity.tabs.schedules`, `dashboard.activity.schedules.*`                     |
| New action types (P2)          | `mission_tick`, `idea_generated`                                                                                         |

---

## 10. Phasing

### P1 — Rename + toggle + aggregation endpoint + read-only Schedules list

- Two i18n value edits across all 21 locales (§3.1).
- `Log | Schedules` segmented toggle in `activity-client.tsx`, `activity-tab` persistence (§5.1).
- `GET /api/schedules` + `SchedulesModule/Controller/Service`, `ScheduleDto`/`SchedulesResponseDto` contracts (§4).
- `SchedulesView` + row/card/empty-state components + `getSchedules` server action + `schedules.ts` API client (§5).
- Additive i18n keys for tabs + schedules copy.
- `controls` returns all-`false` (read-only).

### P2 — Activity-gap emitters

- Add `MISSION_TICK` + `IDEA_GENERATED` enum members (§2.3).
- Wire the 4 (+1 optional) emitters in §8 with deterministic `ingestEventId` and parent-derived scope stamping (§7).
- No new endpoint, no migration; verify automated fires now surface in both the Log tab and the per-Work activity feed.

### P3 — Controls polish

- `ScheduleDto.controls` populated per source (§4.6).
- Row controls menu: run-now / pause-resume / change-period, each delegating to the mapped existing endpoint (§5.5).
- Optimistic UI + toasts; re-fetch `GET /api/schedules` after a mutation.

Sequencing: P1 ships first (pure read + rename, lowest risk). P2 is independent of P1's UI and can land in parallel. P3 depends on P1's view shell.

---

## 11. Open questions

1. **Mission `lastRunAt`.** Missions persist no last-tick timestamp (§2.1). P1 shows `null`. Do we (a) leave it null until P2's `mission_tick` ActivityLog rows exist and then derive last-run from the newest such row, or (b) add a persisted `missions.lastTickAt` column (Tier A migration, out of this feature's additive-only read scope)? Recommendation: (a) — derive from ActivityLog after P2, no schema change.
2. **Cadence human-text library.** `describeCadence` needs cron→text and RRULE→text. Reuse the RRULE text helper already in `recurrence.ts`; for cron, extend `cron-matcher.ts` vs pull a small formatter. Confirm no new heavy dependency.
3. **Run-now for `recurring_task` and `source_validation`.** No dedicated run-now endpoint exists for these two today. P3 leaves those cells disabled. Do we add `POST /api/tasks/:id/recurring/run-now` and reuse `PUT works/:id/source-validation` with a "run now" flag, or defer? Defer unless Product wants parity.
4. **Pagination / caching.** P1 is un-paginated and live. If power users accumulate hundreds of schedules, add cursor pagination and/or a 30–60s cache on `GET /api/schedules`. Not needed for launch.
5. **Plugin-contributed schedules.** Should third-party pipeline plugins be able to register schedule sources (a `ScheduleSourceType` + provider)? Out of scope for v1; revisit if a connector plugin needs it.
6. **Maintenance crons visibility.** Confirmed out of scope: KB reconcile, notification/plugin-usage cleanup, cache warm-up, community-PR/comparison schedulers, deploy-ready poller, anonymous-user cleanup. These are platform-global, not user-owned. Keep them off the Schedules view.

---

## 12. Cross-references

- Implementation plan: [plan.md](plan.md)
- Task checklist: [tasks.md](tasks.md)
- Tenants & Organizations (scope columns + `ScopeContext`): [tenants-and-organizations/spec.md](../tenants-and-organizations/spec.md)
- Scheduled Updates (Work schedules): [scheduled-updates/](../scheduled-updates/)
- Item source-validation: [item-source-validation/](../item-source-validation/)
- Data-repo instant sync: [data-repo-instant-sync/](../data-repo-instant-sync/)
- Missions → Ideas → Works: [missions-ideas-works/](../missions-ideas-works/)
- Task tracking (recurring tasks): [task-tracking/](../task-tracking/)
- Agents (heartbeats): [agents/](../agents/)
