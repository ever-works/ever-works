# AW-10 — Schedules, calendar and heartbeats · Implementation plan

> Implementation detail for [spec.md](./spec.md). Behaviour lives there; nothing here changes it.
> Every path below was opened in the working tree before being written down.

**Epic ID:** `AW-10-schedules-calendar` · **Branch:** `feat/aw-10-schedules-calendar`
**Program:** [Agent Workspace](../README.md) · Wave 2 · **Depends on:** [AW-09](../AW-09-runs-receipts/plan.md)

---

## 1. Current state in the codebase

### 1.1 The unified read model already exists and is good

| What exists | Where | What it already gives us |
| --- | --- | --- |
| `ScheduleView` projection types | [`packages/agent/src/schedules/schedule-view.types.ts`](../../../../../packages/agent/src/schedules/schedule-view.types.ts) | `id` (`${sourceType}:${ownerId}`), `sourceType` (7 values incl. `inbound_trigger`), `ownerType`, `ownerId`, `ownerName`, `ownerLink`, `cadenceRaw`, `cadenceHuman`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `status` (`active\|paused\|disabled\|error\|ended`), `enabled`. Plus `ScheduleQueryFilters` and `ScheduleScope`. |
| The aggregation service | [`packages/agent/src/schedules/schedules.service.ts`](../../../../../packages/agent/src/schedules/schedules.service.ts) | `getSchedules(scope, filters)` runs seven independently try/catch-wrapped source queries (`recurringTasks`, `agentHeartbeats`, `workSchedules`, `missionTicks`, `sourceValidation`, `dataSync`, `inboundTriggers`), each `take(MAX_PER_SOURCE = 500)`, then `sortByNextRun`. A single bad cron degrades one slice, never the response. |
| Cadence helpers | [`packages/agent/src/schedules/cadence.ts`](../../../../../packages/agent/src/schedules/cadence.ts) | `describeCron`, `describeRrule`, `describeWorkCadence`, `describeIntervalMinutes`, `describeEventDriven`, and `computeNextCronFire(expr, from)` — a bounded minute-walk with `MAX_LOOKAHEAD_MINUTES = 31 * 24 * 60` that returns `null` past the horizon. **Its own comment says a yearly / 29-Feb expression legitimately returns `null`** — which is exactly why NEVER RUNS must not be derived from it (spec FR-40). |
| Cron parser | [`packages/agent/src/missions/cron-matcher.ts`](../../../../../packages/agent/src/missions/cron-matcher.ts) | `parseCron` — hand-rolled 5-field parser producing per-field `Set`s plus `domRestricted` / `dowRestricted` flags for Vixie OR semantics. All evaluation is UTC. |
| Recurrence helpers | [`packages/agent/src/tasks-domain/recurrence.ts`](../../../../../packages/agent/src/tasks-domain/recurrence.ts) | `validateRecurrenceRule`, `validateRecurrenceCron`, `computeNextOccurrence`, `computeNextTemplateOccurrence`, `cloneRecurringTaskAsInstance`. Its header states: *all datetime math is UTC; the per-template `recurrenceTimezone` column is a hint for UI rendering, not for the dispatcher.* This is the factual basis for spec FR-11 and open question §9.1. |
| Read endpoint | [`apps/api/src/schedules/schedules.controller.ts`](../../../../../apps/api/src/schedules/schedules.controller.ts) + [`schedules.module.ts`](../../../../../apps/api/src/schedules/schedules.module.ts) + [`dto/schedules-query.dto.ts`](../../../../../apps/api/src/schedules/dto/schedules-query.dto.ts) | `GET /api/schedules` returning a bare `ScheduleView[]`, scoped by `@CurrentUser()` + `ScopeContextService`, filters `sourceType` / `entityKind` / `enabledOnly` only, `forbidNonWhitelisted` on the DTO. |
| Web client + action | [`apps/web/src/lib/api/schedules.ts`](../../../../../apps/web/src/lib/api/schedules.ts), [`apps/web/src/app/actions/dashboard/schedules.ts`](../../../../../apps/web/src/app/actions/dashboard/schedules.ts) | `schedulesAPI.getAll(params)` (server-only) and the `getSchedules` server action. The client re-declares the row type locally rather than importing a contract package — the documented convention here. |
| Web surface | [`apps/web/src/components/schedules/SchedulesList.tsx`](../../../../../apps/web/src/components/schedules/SchedulesList.tsx), mounted from [`apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>) at line 464 behind `?view=schedules` | A read-only table with source-type and active-only filters. No route of its own. |
| Second consumer | [`apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.ts`](<../../../../../apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.ts>) `getSoonRuns()` | Home's "Soon" block already reads `GET /api/schedules` with `enabledOnly`. **This is why the endpoint's response shape must not change** (Principle X). |
| Existing i18n | [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) → `dashboard.schedules.*` (from ~line 2632) | `title`, `subtitle`, `fetchFailed`, `retry`, `columns`, `filters`, `sourceTypes`, `statuses`, `empty`. Extended, never replaced. |
| Existing tests | [`packages/agent/src/schedules/__tests__/schedules.service.spec.ts`](../../../../../packages/agent/src/schedules/__tests__/schedules.service.spec.ts), [`cadence.spec.ts`](../../../../../packages/agent/src/schedules/__tests__/cadence.spec.ts), [`apps/api/src/schedules/schedules.controller.spec.ts`](../../../../../apps/api/src/schedules/schedules.controller.spec.ts), [`dto/schedules-query.dto.spec.ts`](../../../../../apps/api/src/schedules/dto/schedules-query.dto.spec.ts) | Extended, not rewritten. |

### 1.2 The seven sources and how each is paused today

| Source | Owning row | Enabled predicate today | Reversible pause today? |
| --- | --- | --- | --- |
| `recurring_task` | `tasks` ([`task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts)) `isRecurring`, `recurrenceRule` xor `recurrenceCron`, `recurrenceTimezone`, `nextOccurrenceAt`, `recurrenceEndsAt`, `recurrenceMaxOccurrences`, `recurrenceOccurredCount`, `parentRecurringTaskId`, index `idx_tasks_recurrence_due (isRecurring, nextOccurrenceAt)` | `isRecurring = true AND parentRecurringTaskId IS NULL` | **No.** `DELETE /api/tasks/:id/recurring` clears the cadence — destructive. |
| `agent_heartbeat` | `agents` ([`agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts)) `heartbeatCadence` (cron or `'manual'`), `nextHeartbeatAt`, `lastRunAt`, `lastRunStatus`, `errorCount`, `pauseAfterFailures` (default 3), index `idx_agents_next_heartbeat (status, nextHeartbeatAt)` | `heartbeatCadence IS NOT NULL` | **No.** Only by pausing the whole Agent, which also stops assigned Task work. |
| `work_schedule` | `work_schedules` ([`work-schedule.entity.ts`](../../../../../packages/agent/src/entities/work-schedule.entity.ts)) `cadence`, `status`, `nextRunAt`, `lastRunAt`, `lastRunStatus`, `failureCount`, `maxFailureBeforePause` (default 3) | `status = active` | **Yes** — `WorkScheduleStatus.PAUSED`. |
| `mission_tick` | `missions` ([`mission.entity.ts`](../../../../../packages/agent/src/entities/mission.entity.ts)) `type = scheduled`, `schedule` (cron), `status` (`MissionStatus`: `active` \| `paused` \| `completed` \| `failed`) | `status = active` | **Yes, but coarse** — pause writes `status = paused`, which stops the tick raising new Ideas; Ideas and Works already raised are untouched, and `runNow` still works on a paused Mission (spec FR-19). |
| `source_validation` | `works` `sourceValidationEnabled`, `sourceValidationCadence`, `sourceValidationNextRunAt` | flag on | **Yes** — flip the flag; the cadence column survives. |
| `data_sync` | `works` `syncIntervalMinutes`, `lastPolledAt` | interval > 0 | Partially — clearing the interval loses it. |
| `inbound_trigger` | `inbound_triggers` ([`inbound-trigger.entity.ts`](../../../../../packages/agent/src/entities/inbound-trigger.entity.ts)) `status: active\|paused` | `status = active` | **Yes.** |

### 1.3 The dispatchers that will gain a pause predicate

| Worker | Cron | Service | Due-scan |
| --- | --- | --- | --- |
| [`packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts) | `* * * * *` | [`task-recurrence-dispatcher.service.ts`](../../../../../packages/agent/src/tasks-domain/task-recurrence-dispatcher.service.ts) `dispatchDue` / `dispatchDueScheduled` | `TaskRepository.findDueRecurringTemplates(limit, now)` and `findDueScheduledTasks` in [`task.repository.ts`](../../../../../packages/agent/src/database/repositories/task.repository.ts). CAS-claims by advancing `nextOccurrenceAt`; agent resolution is assignees → `task.agentId`, and on failure it raises a `task_run_no_agent` notification ([`task-notification.service.ts`](../../../../../packages/agent/src/tasks-domain/task-notification.service.ts)) rather than skipping silently. |
| [`agent-heartbeat-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-heartbeat-dispatcher.task.ts) | `*/N * * * *` | [`agent-schedule-dispatcher.service.ts`](../../../../../packages/agent/src/agents/agent-schedule-dispatcher.service.ts) `dispatchDue`, exporting `AGENT_HEARTBEAT_TRIGGER` | Scans `agents` for `nextHeartbeatAt <= now`, CAS-claims `active → running`. |
| [`mission-tick.task.ts`](../../../../../packages/tasks/src/tasks/trigger/mission-tick.task.ts) | `* * * * *` | [`mission-tick.service.ts`](../../../../../packages/agent/src/missions/mission-tick.service.ts) | `tickDue` cron-matches every `status = ACTIVE`, `type = SCHEDULED` Mission and asks the generator for Ideas (`WorkProposal` rows, capped at `MAX_IDEAS_PER_TICK = 5`), queueing them for build when `autoBuildWorks` is on. **It creates no Task and dispatches no `AgentRun`** — its only record of a fire is an `ActivityActionType.MISSION_TICK` row, and cron-no-match minutes are deliberately not logged. Dispatcher untouched by this epic; §3.5 reads that activity row for the calendar. |
| [`work-schedule-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts) | config-driven | `WorkScheduleDispatcherService` | Untouched. |

Dispatch indirection to respect (Constitution IV): [`packages/agent/src/tasks-domain/task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts) declares `AGENT_TASK_EXECUTE_DISPATCHER`, `AGENT_CHAT_REPLY_DISPATCHER`, `TERMINAL_SESSION_STARTER` and `JOB_RUNTIME_NOT_CONFIGURED_REASON`. Nothing in `packages/agent` imports a third-party SDK; the adapters live in `packages/tasks` / `apps/api`.

### 1.4 Where a fire becomes a Run — and where it does not

- Recurring Task fires clone a **Task instance** via `cloneRecurringTaskAsInstance` (the clone
  points back at its template through `parentRecurringTaskId`) and dispatch through the same gated
  path a manual run uses, producing an `AgentRun`
  ([`agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts)) with
  `triggerKind = 'task'`.
- Heartbeat fires produce an `AgentRun` with `triggerKind = 'heartbeat'`.
- **A Mission tick becomes neither.** `MissionTickService.tickDue` raises `WorkProposal` rows
  (Ideas) and may queue them for build through `IDEA_BUILD_EXECUTE_DISPATCHER`; the only trace that
  the cadence fired is an `ActivityActionType.MISSION_TICK` activity row. That row — not a missing
  `AgentRun` — is the evidence the calendar must read for `mission_tick` occurrences (spec FR-62).
  The same holds for the other sources that keep their own outcome columns instead of dispatching a
  Run (`work_schedules.lastRunStatus`, `works.sourceValidationLastRunAt`, `works.lastPolledAt`).
- Terminal transitions run through
  [`agent-run-post-processor.ts`](../../../../../packages/agent/src/agents/agent-run-post-processor.ts)
  — the seam where announcements and the failure streak are updated.
- `ActivityActionType`
  ([`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts))
  already declares `SCHEDULE_CREATED/UPDATED/DELETED/EXECUTED` (lines 41–44),
  `AGENT_HEARTBEAT_STARTED/COMPLETED/FAILED` (197–199) and `TASK_RECURRENCE_FIRED` (248).

### 1.5 Migrations

Migrations live in **`apps/api/src/migrations/`** (the highest timestamp on `develop` at time of writing is
`1790100000000-AddReleaseVerification.ts`; each migration this epic adds takes a slot from AW-10's reserved
block — [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow) — and is re-stamped before merge if `develop` has moved past it). Note the drift: the constitution text says
`apps/api/src/database/migrations/`, and the repo `CLAUDE.md` says `apps/api/src/migrations/` —
the second is correct on disk and is what this plan uses. Style to copy from
`1789100000000-AddTaskGraphFanout.ts`:
forward-only, existence-guarded, portable `TableColumn` DDL because the e2e stack runs
better-sqlite3 while production runs Postgres. Adding an entity also requires registering it in
[`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts)
and [`_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts), and
exporting it from [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts).

### 1.6 Summary of the delta

Nothing about how a schedule fires has to be rebuilt. Five things are genuinely missing:

1. **A reversible pause** for recurring Tasks and for heartbeats, independent of the owner's status.
2. **Authored options** on a standing definition: model, time limit, announce, board visibility.
3. **A satisfiability verdict** — a real "can this ever fire?" answer, distinct from "does it fire
   inside a 31-day walk".
4. **Occurrence expansion** over a window, and matching those occurrences against Runs.
5. **An exact-undo record** for bulk pause and bulk repair.

Plus one new read/write surface at `/schedules`.

---

## 2. Architecture and the seam it plugs into

```
  apps/web                                apps/api                     packages/agent
  ────────────────────────────────────    ─────────────────────────    ──────────────────────────
  /schedules  (new route)                 SchedulesController          SchedulesService  (extend)
   ├─ SchedulesShell                       ├─ GET  /api/schedules       ├─ getSchedules()  (extend
   │   ├─ SchedulesListView   ────────────▶│        (unchanged shape)   │    rows with health +
   │   ├─ SchedulesCalendarView ──────────▶├─ GET  /api/schedules/page  │    controls + agent)
   │   ├─ ScheduleHealthBanner ───────────▶├─ GET  /api/schedules/       ├─ getPage()      (new)
   │   ├─ BreakerUndoBanner    ───────────▶│        calendar             └─ getCalendar()  (new)
   │   ├─ ScheduleEditorDialog ───────────▶├─ GET  /api/schedules/health
   │   ├─ FixAllDialog         ───────────▶├─ POST /api/schedules/health/fix   ScheduleHealthService (new)
   │   ├─ DisableAllDialog     ───────────▶├─ POST /api/schedules/disable-all   ├─ evaluate()
   │   └─ ReassignDialog       ───────────▶├─ POST /api/schedules/bulk/:id/undo ├─ proposeRepair()
   │                                       └─ POST /api/schedules/:id/          └─ applyRepairs()
   │                                              {run-now,pause,resume,
   │                                               duplicate,reassign}   ScheduleControlService (new)
   │                                                                      └─ fans out to the
   Activity ?view=schedules  (kept)        TasksController                   owning domain service
   Home "Soon" block         (kept)         └─ POST /api/tasks/:id/
                                                   recurring/run-now      ScheduleOccurrenceService (new)
                                            AgentsController               └─ expand() + matchRuns()
                                             └─ POST /api/agents/:id/
                                                   heartbeat/{pause,resume}  ScheduleBulkActionService (new)
                                             └─ GET  /api/agents/:id/         └─ record / undo
                                                   schedule-overlaps        HeartbeatOverlapService (new)

  packages/tasks (job runtime)
   └─ schedule-health-sweep.task.ts   cron 17 6 * * *  ─▶  ScheduleHealthService.sweep()
```

**Seam rules.**

- `SchedulesService` stays the single definition of "what is scheduled". The new services *decorate*
  its rows; none of them re-queries a source table to build a second list.
- `ScheduleControlService` never writes an owning table directly. It resolves the synthetic id and
  calls the domain service that already owns that write (`TasksService`, `AgentsService`,
  `MissionsService`, the Work schedule service, the inbound-trigger service), so every existing
  ownership check, throttle and activity emission is inherited unchanged.
- Nothing in this epic enqueues work directly. Run-now goes through `AGENT_TASK_EXECUTE_DISPATCHER`
  (recurring Task) or `AGENT_HEARTBEAT_TRIGGER` (heartbeat); the sweep is a cron task registered on
  the configured job-runtime provider.

---

## 3. Data model

### 3.1 `tasks` — the standing definition's options (migration B, P2) and its pause (migration A, P1)

Added to [`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts),
grouped with the existing recurrence block:

| Column | Type | Null | Default | Phase | Meaning |
| --- | --- | --- | --- | --- | --- |
| `recurrencePausedAt` | timestamp (`PortableDateColumn`) | yes | `null` | **A / P1** | Non-null = paused. The cadence, `nextOccurrenceAt` and every bound are untouched. |
| `recurrenceProviderId` | `varchar(64)` | yes | `null` | B / P2 | Per-Schedule AI provider override. `null` = inherit the Agent. |
| `recurrenceModelId` | `varchar(128)` | yes | `null` | B / P2 | Per-Schedule model override. |
| `recurrenceTimeoutSeconds` | `int` | yes | `null` | B / P2 | 60–14 400. `null` = inherit the Agent's `maxRunDurationSeconds` (AW-09), then the deployment default. |
| `recurrenceAnnounce` | `boolean` | no | `true` | B / P2 | Announce on completion. Seeded per FR-29 at creation, not by the column default. |
| `recurrenceHideInstances` | `boolean` | no | `false` | B / P2 | When true, each spawned instance is stamped `hiddenFromBoard = true` (a column that already exists and is already server-written-only). |
| `recurrenceFailureStreak` | `int` | no | `0` | B / P2 | Consecutive failed fires. Reset to 0 on any success and on resume. |
| `recurrenceHealth` | `varchar(32)` | yes | `null` | B / P2 | Cached verdict: `null` = OK, else one of the seven reason codes. |
| `recurrenceHealthCheckedAt` | timestamp | yes | `null` | B / P2 | When the verdict was computed. Drives the "health is stale" notice. |
| `recurrenceLastFiredAt` | timestamp | yes | `null` | B / P2 | Last time the template actually spawned and dispatched. Today this is only derivable by scanning instances. |

Indexes (additive, existing ones untouched):

```
@Index('idx_tasks_recurrence_due_active', ['isRecurring', 'recurrencePausedAt', 'nextOccurrenceAt'])   // migration A
@Index('idx_tasks_recurrence_health', ['userId', 'recurrenceHealth'])                                   // migration B
```

`idx_tasks_recurrence_due` stays exactly as it is — the new composite is added beside it so a
rollback of the app without a rollback of the schema still finds a usable index.

### 3.2 `agents` — an independent heartbeat pause (migration A, P1)

Added to [`agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts):

| Column | Type | Null | Default | Meaning |
| --- | --- | --- | --- | --- |
| `heartbeatPausedAt` | timestamp (`PortableDateColumn`) | yes | `null` | Non-null = the heartbeat is paused. `heartbeatCadence` and `nextHeartbeatAt` are preserved. Orthogonal to `AgentStatus`. |

Index: `@Index('idx_agents_heartbeat_due', ['status', 'heartbeatPausedAt', 'nextHeartbeatAt'])`,
added beside the existing `idx_agents_next_heartbeat`.

### 3.3 `schedule_bulk_actions` — the exact-undo record (migration C, P3)

New entity `packages/agent/src/entities/schedule-bulk-action.entity.ts`, table
`schedule_bulk_actions`. The only new table in this epic.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | uuid PK | no | |
| `userId` | uuid | no | Owner. Indexed with `createdAt`. |
| `tenantId` | uuid | yes | Tier A scope stamping, copied from the acting scope. |
| `organizationId` | uuid | yes | Tier A scope stamping. |
| `kind` | `varchar(16)` | no | `pause` \| `fix`. |
| `scopeKind` | `varchar(16)` | no | `agent` \| `workspace` \| `selection`. |
| `agentId` | uuid | yes | Set when `scopeKind = 'agent'`. No FK — the Agent may be hard-deleted; the record is an audit fact. |
| `entries` | `simple-json` | no | Up to 500 `{ scheduleId, sourceType, ownerId, before, after }`. `before`/`after` hold only the fields this epic changes, never instructions or anything secret. |
| `entryCount` | `int` | no | Denormalised for the banner without parsing `entries`. |
| `undoneAt` | timestamp | yes | Set once. A batch is undoable exactly once. |
| `undoneByUserId` | uuid | yes | |
| `undoSkipped` | `int` | no, default 0 | How many entries undo skipped because state had changed. |
| `createdAt` / `updatedAt` | timestamp | no | |

`@Index('idx_schedule_bulk_actions_user_created', ['userId', 'createdAt'])`.
Registered in `_entities-inventory.ts`, `_entity-names.ts` and `entities/index.ts`.
Retention: the health sweep deletes batches older than **30 days**.

### 3.4 `ActivityActionType` additions (no migration — the column is a free `varchar`)

Appended to [`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts),
nothing reordered:

```
SCHEDULE_PAUSED           = 'schedule_paused'
SCHEDULE_RESUMED          = 'schedule_resumed'
SCHEDULE_DUPLICATED       = 'schedule_duplicated'
SCHEDULE_REASSIGNED       = 'schedule_reassigned'
SCHEDULE_ANNOUNCED        = 'schedule_announced'
SCHEDULE_AUTO_PAUSED      = 'schedule_auto_paused'
SCHEDULE_HEALTH_FIXED     = 'schedule_health_fixed'
SCHEDULES_DISABLED_BULK   = 'schedules_disabled_bulk'
SCHEDULES_BULK_UNDONE     = 'schedules_bulk_undone'
```

`SCHEDULE_CREATED/UPDATED/DELETED/EXECUTED` are reused as they are.

### 3.5 Projection types (no table)

Extended in [`schedule-view.types.ts`](../../../../../packages/agent/src/schedules/schedule-view.types.ts) —
every field **added**, none changed or removed, so `GET /api/schedules` stays wire-compatible for
`getSoonRuns()` and `SchedulesList.tsx` (Principle X):

```ts
export type ScheduleHealthReason =
    | 'impossible-date' | 'ended' | 'exhausted' | 'past-one-shot'
    | 'unparseable' | 'no-agent' | 'owner-archived';

export type ScheduleRepairClass = 'automatic' | 'choice' | 'none';

export interface ScheduleHealth {
    ok: boolean;
    reason: ScheduleHealthReason | null;
    /** Plain-language sentence, already localised key-side by the client. */
    reasonKey: string | null;
    repair: ScheduleRepairClass;
    checkedAt: string | null;
}

export interface ScheduleControls {
    runNow: boolean; pause: boolean; resume: boolean;
    edit: boolean; duplicate: boolean; reassign: boolean;
    /** Per-control reason key when false, e.g. 'dataSyncConfiguredOnWork'. */
    disabledReasons: Partial<Record<keyof Omit<ScheduleControls, 'disabledReasons'>, string>>;
}

export interface ScheduleOccurrence {
    scheduleId: string;
    expectedAt: string;              // ISO, UTC
    outcome: 'ran' | 'failed' | 'did-not-run' | 'unknown' | 'upcoming' | 'paused';
    /** How a past outcome was established. 'none' ⇒ outcome is 'unknown' or 'upcoming'. */
    evidence: 'run' | 'sourceRecord' | 'none';
    runId: string | null;            // set for ran / failed only when evidence === 'run'
    /** Where to send the user when there is no receipt: the owning entity's link. */
    ownerLink: string | null;
    durationMs: number | null;       // null for sourceRecord evidence
    costCents: number | null;        // null for sourceRecord evidence
    notRunReasonKey: string | null;  // 'pausedAtTheTime' | 'noAgent' | null
}

// added to ScheduleView
interface ScheduleViewAdditions {
    agentId: string | null;
    agentName: string | null;
    health: ScheduleHealth;
    controls: ScheduleControls;
    pausedAt: string | null;
    failureStreak: number;
    announce: boolean | null;
    timeoutSeconds: number | null;
    timeoutSource: 'schedule' | 'agent' | 'deployment' | null;
    modelLabel: string | null;
    overlapCount: number;            // 0 unless heartbeat/schedule overlap detected
}

export interface SchedulePage {
    items: ScheduleView[];
    nextCursor: string | null;
    total: number;
    countsBySourceType: Record<ScheduleSourceType, number>;
    healthCounts: { ok: number; neverRuns: number; overlap: number };
    degradedSources: ScheduleSourceType[];   // sources whose query failed
    healthCheckedAt: string | null;
}
```

`evidence` is what keeps spec FR-62 honest. `recurring_task` and `agent_heartbeat` fires produce an
`AgentRun`, so their occurrences resolve with `evidence: 'run'` and a receipt link. A `mission_tick`
fire produces Ideas rather than a Run, so its occurrences resolve with `evidence: 'sourceRecord'`
from the `MISSION_TICK` activity row inside the same ±10 minute window, carry no `runId`, `durationMs`
or `costCents`, and link to the Mission; with no such row the outcome is `unknown` — never
`did-not-run`, which would be inferred from the absence of something that was never created. The
same rule covers `work_schedule`, `source_validation` and `data_sync`, which keep their own outcome
columns (§1.4).

The web mirror in [`apps/web/src/lib/api/schedules.ts`](../../../../../apps/web/src/lib/api/schedules.ts)
is updated in lockstep, following the local-interface convention that file already documents.

### 3.6 Migrations

Three forward-only migrations in `apps/api/src/migrations/`, one per phase, each existence-guarded
and written with portable `TableColumn` DDL:

| File | Phase | Contents |
| --- | --- | --- |
| `1791100000000-AddSchedulePauseColumns.ts` | P1 | `tasks.recurrencePausedAt`; `agents.heartbeatPausedAt`; indexes `idx_tasks_recurrence_due_active`, `idx_agents_heartbeat_due`. No backfill — `NULL` on every existing row reads as "not paused", which is the current behaviour exactly. |
| `1791100100000-AddScheduleDefinitionOptions.ts` | P2 | The nine remaining `tasks.recurrence*` columns and `idx_tasks_recurrence_health`. `recurrenceAnnounce` defaults `true` and `recurrenceHideInstances` defaults `false`, both of which reproduce today's behaviour for existing rows (they announce nothing today because nothing reads the column, and their instances are already visible). |
| `1791100200000-CreateScheduleBulkActions.ts` | P3 | The `schedule_bulk_actions` table and its index. |

No column is renamed, no data is destroyed, and every `down()` drops only what its `up()` added.

---

## 4. API

All new endpoints live in `apps/api/src/schedules/`. Literal-segment routes (`page`, `calendar`,
`health`, `disable-all`, `bulk`) are declared **before** the `:id` routes, the same ordering
discipline `agents.controller.ts` documents for `GET /api/agents/runs`. Schedule ids are synthetic
(`${sourceType}:${ownerId}`), contain a colon, and are **never** run through `ParseUUIDPipe`; a
dedicated `ParseScheduleIdPipe` validates the source-type against the union and the owner id
against a UUID pattern, rejecting anything else with `400`.

### 4.1 `GET /api/schedules` — unchanged shape (P1)

Still returns a bare `ScheduleView[]`. Rows gain the additive fields of §3.5. `getSoonRuns()` and
`SchedulesList.tsx` keep working with no change.

### 4.2 `GET /api/schedules/page` (P1)

`SchedulePageQueryDto` (`forbidNonWhitelisted`, mirroring `schedules-query.dto.ts`):

| Param | Rule |
| --- | --- |
| `cursor` | `@IsOptional() @IsString() @MaxLength(512)` — opaque, `{nextRunAt, id}` base64. |
| `limit` | `@IsInt() @Min(1) @Max(50)`, default 50. |
| `sourceType`, `entityKind`, `enabledOnly` | as today. |
| `agentId` | `@IsOptional() @IsUUID()`. |
| `status` | `@IsOptional() @IsIn(['active','paused','disabled','error','ended'])`. |
| `health` | `@IsOptional() @IsIn(['ok','never-runs','overlap'])`. |
| `q` | `@IsOptional() @IsString() @MaxLength(120)` — matched against owner name and instructions. |

Returns `SchedulePage`. Auth: the global session guard; scope from `ScopeContextService`.

### 4.3 `GET /api/schedules/calendar` (P2)

`ScheduleCalendarQueryDto`: `from` / `to` (ISO, both required, `to - from ≤ 92 days`, else `400`
`CALENDAR_RANGE_TOO_WIDE`), plus the same narrowing params as `/page`.
Returns `{ from, to, generatedAt, occurrences: ScheduleOccurrence[], truncated: { scheduleId, shown, cap }[] }`.
`generatedAt` lets the client compute countdowns against server time.

### 4.4 `GET /api/schedules/health` (P1 read, P3 bulk)

Returns `{ checkedAt, counts: { ok, neverRuns, byReason }, flagged: [{ id, ownerName, reason, repair, before, after }] }`.
This is a **dry run**: `before`/`after` are the exact values a repair would write, so the client
renders the preview without a second round trip. Capped at 200 flagged rows per call.

### 4.5 `POST /api/schedules/health/fix` (P3)

Body: `{ scheduleIds?: string[] (≤200), all?: boolean, expected: Record<scheduleId, beforeHash> }`.
The `expected` map is what makes FR-48 real: a repair is skipped when the current before-state no
longer hashes to what was previewed. Returns
`{ bulkActionId, applied: string[], skipped: [{ id, reasonKey }] }`. Throttled `10/min`.

### 4.6 `POST /api/schedules/disable-all` (P3)

Body: `{ scope: 'agent' | 'workspace', agentId?: string, confirm?: 'PAUSE' }`.
`confirm` is required for `workspace`. Refuses with `409 SCHEDULE_SCOPE_TOO_LARGE` above 500.
Returns `{ bulkActionId, pausedCount, includedHeartbeat, inFlightRunCount, skipped }`.
Throttled `5/min`.

### 4.7 `POST /api/schedules/bulk/:bulkActionId/undo` (P3)

Path param is a real UUID. Refuses `409 UNDO_WINDOW_CLOSED` beyond 15 minutes of `createdAt`, and
`409 ALREADY_UNDONE` when `undoneAt` is set. Returns `{ restored, skipped, skippedReasons }`.

### 4.8 Per-schedule controls (P1 unless noted)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/schedules/:id/run-now` | — | Throttled `10/min` per user. `409` codes: `SCHEDULE_ALREADY_RUNNING`, `SCHEDULE_NO_AGENT`, `SCHEDULE_OWNER_ARCHIVED`, `SCHEDULE_CREDITS_EXHAUSTED`. Returns `{ runId }`. Never touches `nextOccurrenceAt` / `nextHeartbeatAt`. |
| `POST` | `/api/schedules/:id/pause` | `{ acknowledgeMissionPause?: boolean }` | `409 MISSION_PAUSE_NOT_ACKNOWLEDGED` for `mission_tick` without the flag. |
| `POST` | `/api/schedules/:id/resume` | — | Resets `recurrenceFailureStreak` to 0 (P2). |
| `PATCH` | `/api/schedules/:id` (P2) | `UpdateScheduleDto` | Name, instructions, cadence, options. `recurring_task` only; `409 SCHEDULE_NOT_EDITABLE` otherwise. |
| `POST` | `/api/schedules/:id/duplicate` (P2) | — | `recurring_task` only. Copy starts paused. Returns the new `{ id }`. |
| `POST` | `/api/schedules/:id/reassign` (P2) | `{ agentId }` | `recurring_task` only. `409 AGENT_ARCHIVED`, `404` for an unreachable Agent. |

Every one of these resolves the synthetic id, re-checks ownership through the owning domain
service, and returns `404` — never `403` — for a foreign or missing id, matching the posture the
schedules and escalations controllers already use.

### 4.9 Endpoints added to existing controllers

| Method | Path | File | Phase | Why here |
| --- | --- | --- | --- | --- |
| `POST` | `/api/tasks/:id/recurring/run-now` | [`apps/api/src/tasks/tasks.controller.ts`](../../../../../apps/api/src/tasks/tasks.controller.ts) | P1 | Closes the gap the existing schedules spec flagged (no run-now for a recurring template). The Task detail page needs it too, so it belongs in the Task domain; `/api/schedules/:id/run-now` delegates to it. Throttled `10/min`. |
| `POST` | `/api/agents/:id/heartbeat/pause` · `/resume` | [`apps/api/src/agents/agents.controller.ts`](../../../../../apps/api/src/agents/agents.controller.ts) | P1 | Pausing a heartbeat is an Agent-domain write. Declared before the existing `:id` param routes are reached for these literal sub-segments. Throttled `30/min`, matching the other Agent writes. |
| `GET` | `/api/agents/:id/schedule-overlaps` | same | P2 | Returns `{ coincidences: [{ scheduleId, sameMinuteFires }], duty: [{ scheduleId, overlapScore }], heartbeatTooTight: boolean }`. Read-only, no side effects. |
| `PATCH` | `/api/tasks/:id` | same | P2 | Gains the five optional option fields on `UpdateTaskDto` in [`tasks.dto.ts`](../../../../../apps/api/src/tasks/tasks.dto.ts) with `@Min(60) @Max(14400)` on the timeout. No new guard. |

---

## 5. Web

### 5.1 Route and navigation

- New route group: `apps/web/src/app/[locale]/(dashboard)/schedules/page.tsx` (RSC entry, fetches
  the first page + health server-side) and `schedules-client.tsx` (the interactive shell).
- `ROUTES.DASHBOARD_SCHEDULES = '/schedules'` in
  [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts), beside
  `DASHBOARD_ACTIVITY` (line 110).
- A nav entry in
  [`DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx),
  inserted after `navigation.tasks` (line 166), using `t('navigation.schedules')` and the
  `CalendarClock` icon.
- [`activity-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx>)
  keeps its `?view=schedules` tab and its `<SchedulesList />` mount at line 464 exactly as they
  are; a single "Open Schedules" link is added above the list. Nothing is removed.
- View state (`list` / `calendar`), filters and the calendar anchor date are held in the URL
  (`?view=`, `?agent=`, `?source=`, `?status=`, `?health=`, `?q=`, `?date=`) and mirrored to
  `localStorage` under `schedules-view` — the same pattern `activity-client.tsx` uses for
  `activity-tab`.

### 5.2 Components (all under `apps/web/src/components/schedules/`)

| Component | Phase | Responsibility |
| --- | --- | --- |
| `SchedulesShell.tsx` | P1 | View switch, shared filter state, banners, keyboard map. |
| `SchedulesListView.tsx` | P1 | The paged table, `Load more`, per-row `ScheduleRowMenu`. |
| `ScheduleRow.tsx` | P1 | One row incl. source label, UTC + local cadence, countdown, health badge. |
| `ScheduleCountdown.tsx` | P1 | 1 s tick, `aria-live="polite"` throttled to once a minute. |
| `ScheduleHealthBadge.tsx` | P1 | `OK` / `NEVER RUNS` / `OVERLAP` with the reason in the accessible name. |
| `ScheduleHealthBanner.tsx` | P1 | Count + `Review and fix`; session dismissal in `sessionStorage`. |
| `ScheduleRowMenu.tsx` | P1 | Six controls, disabled entries kept in place with their reason. |
| `SchedulesFilters.tsx` | P1 | Agent / source / status / health / search, URL-synced. |
| `SchedulesEmptyState.tsx` | P1 | Two variants (nothing scheduled, filters match nothing). |
| `SchedulesDegradedNotice.tsx` | P1 | Renders `degradedSources` with `Retry`. |
| `ScheduleEditorDialog.tsx` | P2 | Guided form + free text + cadence picker + options; shows the next three fires. |
| `GuidedInstructionForm.tsx` | P2 | The six slots; composes to plain text; `Edit as text` swaps to a textarea. |
| `CadencePicker.tsx` | P2 | Three styles; validates on blur via a server action; renders UTC + local. |
| `ScheduleOptionsPanel.tsx` | P2 | Model / time limit / announce / board visibility with inherited-value labels. |
| `SchedulesCalendarView.tsx` | P2 | Week + Month grids as a semantic table. |
| `OccurrenceChip.tsx` | P2 | Outcome marker, tooltip, links to the Schedule or the Run receipt. |
| `ReassignDialog.tsx` | P2 | Agent picker excluding archived Agents. |
| `OverlapWarning.tsx` | P2 | Coincidence + duty evidence, 30-day dismissal in `localStorage` keyed by pair. |
| `FixAllDialog.tsx` | P3 | Preview list with before/after, checkbox selection, skip reasons, apply. |
| `DisableAllDialog.tsx` | P3 | Both scopes; type-`PAUSE` confirm for workspace; in-flight Run count. |
| `BreakerUndoBanner.tsx` | P3 | Countdown to the end of the undo window; `Undo`. |
| `SchedulesBulkBar.tsx` | P3 | Multi-select pause/resume, cap 100 rows. |

### 5.3 Data fetching

- Server action file `apps/web/src/app/actions/dashboard/schedules.ts` (exists) gains
  `getSchedulePage`, `getScheduleCalendar`, `getScheduleHealth`, and the mutation actions
  (`runScheduleNow`, `pauseSchedule`, `resumeSchedule`, `duplicateSchedule`, `reassignSchedule`,
  `updateSchedule`, `fixSchedules`, `disableAllSchedules`, `undoScheduleBulkAction`). Each
  `revalidatePath(ROUTES.DASHBOARD_SCHEDULES)` on success.
- [`apps/web/src/lib/api/schedules.ts`](../../../../../apps/web/src/lib/api/schedules.ts) gains the
  matching `schedulesAPI.*` methods over `serverFetch`, keeping `import 'server-only'`.
- No BFF route handler is needed: everything goes through server actions, like the existing
  Schedules and Activity reads. Nothing on this surface streams.
- Poll: the shell re-reads the current page every **60 s** and on `visibilitychange → visible`,
  cancelling in-flight reads on unmount. Countdowns are computed client-side from
  `generatedAt`, never from the browser clock alone.

### 5.4 State rules

- The list, the calendar, the health banner and the breaker banner each own their own request and
  their own error state (FR-79). A rejected promise renders that section's notice and nothing else.
- Mutations are optimistic only for `pause`/`resume` (a reversible, instantly visible flip) and
  never for `run-now`, `fix`, `disable-all` or `undo`, which wait for the server so the count in
  the toast is the real one.
- The fix preview holds the `before` hashes it was given and sends them back on apply; it never
  recomputes them client-side.

---

## 6. Background work

All through the configured job-runtime provider (Constitution IV) — no direct queue calls, no
third-party SDK import inside `packages/agent`.

| Task | Cron | File | Calls |
| --- | --- | --- | --- |
| `schedule-health-sweep` | `17 6 * * *` | new `packages/tasks/src/tasks/trigger/schedule-health-sweep.task.ts`, exported from [`packages/tasks/src/tasks/trigger/index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) | `ScheduleHealthService.sweep()` — recompute `recurrenceHealth` for every recurring template, raise at most **one** notification per user per day summarising newly-flagged Schedules, and delete `schedule_bulk_actions` older than 30 days. Boots a transient `NestApplicationContext(TriggerInternalModule)` and closes it, the shape every task in that folder already uses. |

Changed predicates in existing workers (no new workers):

- `TaskRepository.findDueRecurringTemplates` adds `recurrencePausedAt IS NULL`
  ([`task.repository.ts`](../../../../../packages/agent/src/database/repositories/task.repository.ts)).
- `AgentScheduleDispatcherService.dispatchDue` adds `heartbeatPausedAt IS NULL`
  ([`agent-schedule-dispatcher.service.ts`](../../../../../packages/agent/src/agents/agent-schedule-dispatcher.service.ts)).

Changed post-processing (no new worker):

- [`agent-run-post-processor.ts`](../../../../../packages/agent/src/agents/agent-run-post-processor.ts)
  gains, for runs whose originating Task is a recurring instance: increment or reset
  `recurrenceFailureStreak`, stamp `recurrenceLastFiredAt`, emit `schedule_announced` per FR-68–70
  through [`ActivityLogService`](../../../../../packages/agent/src/activity-log/activity-log.service.ts)
  and [`NotificationService`](../../../../../packages/agent/src/notifications/notification.service.ts),
  and auto-pause at a streak of 5 (`schedule_auto_paused`).
- Announcement rows carry a deterministic idempotency key (`sched-announce:{taskId}:{runId}`) so a
  retried terminal transition cannot double-post.

Run-now dispatch:

- `recurring_task` → the existing gated dispatch path via `AGENT_TASK_EXECUTE_DISPATCHER`
  ([`task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts)).
  A `JobRuntimeNotConfiguredError` surfaces as a `503` with the actionable reason, never a silent
  success.
- `agent_heartbeat` → the existing `AGENT_HEARTBEAT_TRIGGER` binding, the same one
  `POST /api/agents/:id/run-now` uses.
- `mission_tick` → the existing `POST /api/me/missions/:id/run-now`
  ([`apps/api/src/missions/missions.controller.ts`](../../../../../apps/api/src/missions/missions.controller.ts)),
  which runs one tick through `MissionsService.runNow` (gated to `ACTIVE | PAUSED`). It returns a
  `MissionTickOutcome`, not a `runId`, so the response carries no Run link and the toast points at
  the Mission and the Ideas the tick raised (spec FR-14).
- The other four sources delegate to their existing run-now endpoints; where none exists the row's
  `controls.runNow` is `false` with a reason.

---

## 7. Plugin boundaries

- **No new plugin package and no new external integration.** Every source, every write and every
  dispatch is first-party.
- The per-Schedule **model** option stores `{ providerId, modelId }` and is resolved at dispatch
  through the existing AI facade cascade, exactly as the Agent-level model is today. No plugin id
  is referenced by name anywhere in `apps/api`, `apps/web` or `packages/agent` as a result of this
  epic (Constitution II).
- The editor's model picker is populated from the plugins-capabilities endpoint that already backs
  the Agent settings model picker. It renders whatever that returns; it hardcodes no list.
- Plugin-contributed schedule sources remain out of scope (spec §7.4), so `ScheduleSourceType`
  stays a closed union.

---

## 8. i18n

All keys under the existing `dashboard.schedules` namespace in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) (block begins ~line 2632).
Existing keys (`title`, `subtitle`, `fetchFailed`, `retry`, `columns`, `filters`, `sourceTypes`,
`statuses`, `empty`) are **kept and reused**. Leaf names are camelCase and contain no literal dot.

```
dashboard.schedules
  pageSubtitle                     "Everything that runs without you"
  views:            list · calendar
  summaryLine                      "{total} schedules · {active} active · {paused} paused"
  timezoneNote                     "UTC ({local} local)"
  neverRunYet                      "never run yet"
  loadMore · loading · showingRange
  columns (extend):  health · lastOutcome
  filters (extend):  agent · status · health · search · clear · unfilteredTotal
  actions:          runNow · pause · resume · edit · duplicate · reassign
                    openTask · openAgent · openMission · openWork   (owner entry, per source)
                    seePastRuns · seeIdeasRaised
                    fix · fixAll · disableAll · undo · apply · cancel
  health:
    ok · neverRuns · overlap · bannerCount · reviewAndFix · dismiss · staleNotice
    reasons:        impossibleDate · ended · exhausted · pastOneShot
                    unparseable · noAgent · ownerArchived
    repairs:        clampDayOfMonth · clearEndDate · clearOccurrenceCap · moveForward
                    needsDecision · needsEditing
  fix:
    dialogTitle · lead · beforeLabel · afterLabel · nothingChangedUntilApply
    applyCta · appliedToast · racedToast · skippedTitle · capNotice · undoCta · undoneToast
  breaker:
    agentCta · workspaceCta · agentDialogTitle · workspaceDialogTitle
    agentBody · workspaceBody · nothingDeleted · inFlightNotice · seeRunsInFlight
    restructureHint · confirmWordLabel · confirmWord · pauseCta · pausedToast
    scopeTooLarge · filterByAgent · undoBanner · undoMinutesLeft
    windowClosed · showPaused · partialUndo
  editor:
    newTitle · editTitle · nameLabel · agentLabel
    instructionsLabel · instructionsHelp · guidedToggle · editAsText
    guided:         readLabel · doLabel · outputLabel · ifLabel · thenLabel · neverLabel
    cadenceLabel · cadenceDaily · cadenceWeekly · cadenceAdvanced · cadenceHelp · nextThreeFires
    optionsTitle · modelLabel · modelInherit · timeoutLabel · timeoutHelp
    announceLabel · announceHelp · showOnBoardLabel
    saveCta · savedToast
    errors:         minInterval · tightCadence · agentCap · workspaceCap · unparseable
  overlap:
    title · coincidenceEvidence · dutyEvidence · guidance
    openHeartbeat · keepBoth · snoozeThirtyDays · heartbeatTooTight · changeToThirty
  calendar:
    week · month · today · previous · next · firesExpected
    outcomes:       ran · failed · paused · didNotRun · unknown · upcoming
    notRunReasons:  pausedAtTheTime · noAgent
    legend · rangeTooWide · tooManyOccurrences · emptyWeek · jumpToNext
    openSchedule · openReceipt · openOwner · ranRaisedIdeas
  runNow:
    queuedToast · doesNotShiftNote · missionTickToast   (no run link — links to the Mission)
    refused:        alreadyRunning · noAgent · ownerArchived · credits · rateLimited
  duplicate:        doneToast · startsPausedNote · openTheCopy
  reassign:         dialogTitle · currentlyRunsAs · moveItTo · movesWithIt
                    noModelWarning · archivedError · doneToast
  autoPause:        bannerTitle · bannerBody · openLastReceipt · raiseTimeLimit · resumeCta
  announce:         completed · failed · rolledUp
  missionPause:     confirmTitle · confirmBody · alreadyRaisedNote · openMissionInstead
  degraded:         sourceFailed · totalsExclude
  errors:           listFailed · calendarFailed · healthFailed · nothingWasChanged
  keyboard:         sheetTitle · move · open · runNow · pauseResume · edit · duplicate
                    switchView · prevNext · today · search · escape · thisSheet
```

Plus `dashboard.sidebar.navigation.schedules` = `"Schedules"` and
`metadata.pages.schedules` = `"Schedules"`.

The 20 sibling locale files in `apps/web/messages/` receive the same key tree. Untranslated leaves
fall back to English through the existing next-intl fallback rather than being omitted, so no key
is missing at runtime.

---

## 9. Telemetry and failure modes

### 9.1 Analytics

Emitted through the existing monitoring package binding (`packages/monitoring`), one event per
user action, no free text and no instruction bodies in properties:

| Event | Properties |
| --- | --- |
| `schedule_surface_viewed` | `view`, `totalSchedules`, `neverRunsCount`, `degradedSources` |
| `schedule_run_now` | `sourceType`, `outcome` (`dispatched` / refusal code) |
| `schedule_paused` / `schedule_resumed` | `sourceType`, `origin` (`row` / `bulk` / `breaker`) |
| `schedule_created` / `schedule_updated` | `sourceType`, `cadenceStyle`, `usedGuidedForm`, `hasModelOverride`, `hasTimeoutOverride`, `announce` |
| `schedule_health_previewed` / `schedule_health_fixed` | `flaggedCount`, `automaticCount`, `appliedCount`, `skippedCount` |
| `schedule_breaker_used` / `schedule_breaker_undone` | `scope`, `count`, `secondsToUndo` |
| `schedule_overlap_warned` / `schedule_overlap_snoozed` | `coincidenceFires`, `dutyScore` |
| `schedule_calendar_range` | `view`, `days`, `occurrenceCount`, `truncated` |

### 9.2 Activity log

Every control writes one row through `ActivityLogService` with a deterministic idempotency key and
parent-derived scope stamping (`userId`, `tenantId`, `organizationId`), using the action types of
§3.4. Bulk operations write **one** row for the batch plus the `bulkActionId` in `details`, not one
row per Schedule — a 500-row batch must not flood the feed.

### 9.3 Failure modes

| Failure | Detection | Handling |
| --- | --- | --- |
| One source query throws | Existing per-source try/catch in `SchedulesService` | The slice is empty, its type is listed in `degradedSources`, the client renders the notice and excludes it from totals (FR-79 / U1). |
| `computeNextCronFire` returns `null` for a valid rare cadence | Horizon exhausted at 31 days | `nextRunAt = null` with a "fires beyond the next month" note. **Never** a NEVER RUNS verdict (FR-40). |
| Health sweep never runs (no job runtime) | `recurrenceHealthCheckedAt` older than 48 h | The staleness notice (spec §6.20). Health is still recomputed on every write, so edited rows are always right. |
| Two clients fix the same Schedule | `expected` before-hash mismatch on apply | Skipped and counted; nothing is overwritten (FR-48 / U4). |
| Undo races a teammate's edit | Per-entry state comparison before restore | That entry is skipped, `undoSkipped` incremented, and the count reported (FR-56 / U6). |
| Breaker scope explodes past 500 | Counted before any write | `409 SCHEDULE_SCOPE_TOO_LARGE`; nothing is paused (FR-54 / U7). |
| Run-now storms | `@Throttle` at 10/min per user | `429` with the copy in spec §6.18. |
| Announcement storm | Per-Schedule daily counter | Rolled up hourly above 20/day (FR-70). |
| Repeated fire failures | `recurrenceFailureStreak` in the post-processor | Auto-pause at 5, notify regardless of the announce setting (FR-71). |
| Occurrence expansion explodes | Caps at 500/Schedule and 2 000/request | Truncation is reported per Schedule, never silently (FR-65 / U9). |
| A Schedule's Runs have aged out of retention | Run lookup returns nothing and the occurrence predates the retention floor | Rendered `unknown`, never `did not run` (FR-63). |
| A source produces no Run at all (`mission_tick` raising Ideas; the three Work-owned sources) | `evidence` resolution finds no `AgentRun` because none is ever created | Resolved from that source's own record — the `MISSION_TICK` activity row, or the source's `lastRun*` columns — and rendered `unknown` when no record is held. Never `did not run` (FR-62 / §3.5). |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest)

| File | Covers |
| --- | --- |
| `packages/agent/src/schedules/__tests__/schedule-health.spec.ts` | All seven reasons produced by a matching fixture and by nothing else; a yearly cron, a 29-Feb cron and a paused row are **not** flagged; repair class per reason. |
| `packages/agent/src/schedules/__tests__/schedule-repair.spec.ts` | `impossible-date` clamps to the last day existing in every named month (Feb → 28); end-date clear; occurrence-cap clear; past one-shot moves ≥5 min into the future; before-hash mismatch is refused. |
| `packages/agent/src/schedules/__tests__/schedule-occurrence.spec.ts` | Expansion for cron and RRULE across a 92-day window; per-Schedule 500 and per-request 2 000 caps; ±10 min Run matching; `unknown` past the retention floor; paused occurrences marked, not dropped; a `mission_tick` occurrence resolving from its `MISSION_TICK` activity row with `evidence: 'sourceRecord'`, and reading `unknown` — never `did-not-run` — when no such row exists. |
| `packages/agent/src/schedules/__tests__/schedule-controls.spec.ts` | The control descriptor per source type, and each disabled reason. |
| `packages/agent/src/schedules/__tests__/schedule-bulk-action.service.spec.ts` | Record contents, 15-minute window, single-undo enforcement, per-entry skip on changed state, 30-day pruning. |
| `packages/agent/src/schedules/__tests__/heartbeat-overlap.spec.ts` | Coincidence at exactly 1 vs 2 fires in 7 days; duty score at 0.34 vs 0.35; the tight-heartbeat rule at 15 min with 0 and 1 Schedules. |
| `packages/agent/src/schedules/__tests__/schedules.service.spec.ts` (extend) | Cursor paging, the new filters, `degradedSources`, and that `getSchedules` keeps its bare-array shape. |
| `packages/agent/src/schedules/__tests__/cadence.spec.ts` (extend) | Next-three-fires helper; UTC/local rendering inputs. |
| `packages/agent/src/tasks-domain/__tests__/task-recurrence-pause.spec.ts` | `findDueRecurringTemplates` excludes paused templates; resume restores dispatch; pause preserves every recurrence column. |
| `packages/agent/src/agents/__tests__/heartbeat-pause.spec.ts` | `dispatchDue` excludes `heartbeatPausedAt IS NOT NULL`; the Agent's status and assigned-Task dispatch are unaffected. |
| `packages/agent/src/agents/__tests__/schedule-announce.spec.ts` | Announce on completion; forced announce on the second consecutive failure; roll-up above 20/day; auto-pause at 5 and reset on resume; idempotency key prevents a double post. |

### 10.2 Controller specs — API (Jest, beside the controller)

| File | Covers |
| --- | --- |
| `apps/api/src/schedules/schedules.controller.spec.ts` (extend) | `GET /api/schedules` shape unchanged; additive fields present. |
| `apps/api/src/schedules/schedules.controller.page.spec.ts` | Paging, every filter, DTO rejection of unknown params, scope isolation, 404-never-403. |
| `apps/api/src/schedules/schedules.controller.calendar.spec.ts` | 92-day refusal, truncation reporting, `generatedAt`. |
| `apps/api/src/schedules/schedules.controller.controls.spec.ts` | Each control's success and every `409` code; `ParseScheduleIdPipe` rejecting a malformed id; the Mission-pause acknowledgement gate; run-now throttling. |
| `apps/api/src/schedules/schedules.controller.health.spec.ts` | Dry-run preview, 200-row cap, `expected`-hash enforcement, bulk-undo windows. |
| `apps/api/src/schedules/schedules.controller.breaker.spec.ts` | Both scopes, the typed confirm, the 500 cap, in-flight Run count, undo and partial undo. |
| `apps/api/src/tasks/tasks.controller.recurring-controls.spec.ts` | `POST /api/tasks/:id/recurring/run-now` including the no-agent refusal; the new option fields on `PATCH /api/tasks/:id` with their bounds. |
| `apps/api/src/agents/agents.controller.heartbeat-pause.spec.ts` | Heartbeat pause/resume, cadence preservation, `GET /api/agents/:id/schedule-overlaps`. |
| `apps/api/src/schedules/dto/schedules-query.dto.spec.ts` (extend) | The new page/calendar DTOs. |

### 10.3 Web unit (Vitest, beside the component)

- `apps/web/src/components/schedules/ScheduleHealthBadge.unit.spec.tsx`
- `apps/web/src/components/schedules/ScheduleRowMenu.unit.spec.tsx` — disabled entries keep their
  place and carry their reason.
- `apps/web/src/components/schedules/CadencePicker.unit.spec.tsx` — the three styles, the UTC/local
  line, refusal under 5 minutes.
- `apps/web/src/components/schedules/GuidedInstructionForm.unit.spec.tsx` — composition to plain
  text and the `Edit as text` swap without data loss.
- `apps/web/src/components/schedules/OccurrenceChip.unit.spec.tsx` — all six outcomes and their
  accessible names.
- `apps/web/src/components/schedules/DisableAllDialog.unit.spec.tsx` — the confirm stays disabled
  until `PAUSE` matches exactly.
- `apps/web/src/components/schedules/FixAllDialog.unit.spec.tsx` — before/after rendering, skip
  reasons, nothing sent until apply.

### 10.4 End-to-end (Playwright, `apps/web/e2e/`)

| File | Golden path |
| --- | --- |
| `flow-schedules-workspace-list.spec.ts` | Open `/schedules` from the sidebar, see all sources, filter, page, run-now a Schedule and confirm the next fire is unchanged. |
| `flow-schedules-pause-preserves-cadence.spec.ts` | Pause a recurring Schedule and a heartbeat, reload, confirm cadence and instructions survive, resume, confirm firing resumes. |
| `flow-schedules-never-runs-fix.spec.ts` | Create an impossible cadence, see the badge and banner, preview the repair, apply, undo inside the window. |
| `flow-schedules-standing-definition.spec.ts` | Author a Schedule through the guided form with options, see the next three fires, save, confirm the row. |
| `flow-schedules-calendar.spec.ts` | Week and Month, step and Today, a past occurrence links to its receipt, a range over 92 days snaps back with filters intact. |
| `flow-schedules-circuit-breaker.spec.ts` | Agent scope, then workspace scope with the typed confirm, the undo banner, undo, and the closed-window refusal. |
| `flow-schedules-duplicate-reassign.spec.ts` | Duplicate starts paused; reassign moves options and leaves the next fire alone; an archived Agent is not offered. |
| `flow-agent-heartbeat-overlap.spec.ts` | A tight heartbeat plus an overlapping Schedule raises both warnings, neither blocks, and the 30-day snooze holds. |
| `flow-schedules-a11y.spec.ts` | Axe pass on both views plus keyboard traversal of §6.21. |

Existing specs that must stay green unchanged: `flow-schedules-list-projection-2.spec.ts`,
`flow-schedules-ui-journey.spec.ts`, `flow-schedules-validation-matrix.spec.ts`,
`flow-schedules-view-deep.spec.ts`, `cron-schedules.spec.ts`,
`flow-agent-heartbeat-dispatch-lifecycle.spec.ts`, `flow-tasks-recurring-reviewers.spec.ts`.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green on its own.

### P1 — The workspace list (migration A)

- Migration A: `tasks.recurrencePausedAt`, `agents.heartbeatPausedAt`, two indexes.
- Dispatcher predicates for both new pause columns.
- `ScheduleHealthService.evaluate()` (read-time only, no cached column yet) and the control
  descriptor; `ScheduleView` gains `agentId`, `agentName`, `health`, `controls`, `pausedAt`.
- `GET /api/schedules/page`, `GET /api/schedules/health`, `POST /api/schedules/:id/{run-now,
  pause, resume}`, `POST /api/tasks/:id/recurring/run-now`,
  `POST /api/agents/:id/heartbeat/{pause,resume}`.
- `/schedules` route, sidebar entry, List view, filters, health badge and banner, single-row Fix
  with preview, degraded-source notice, empty and error states, keyboard map.
- i18n for everything above in `en.json` + the 20 locales.
- **Ships without:** the calendar, authored options, announcements, duplicate, reassign, bulk
  anything. The Activity tab and Home's Soon block are untouched and keep working.

### P2 — The standing definition and the calendar (migration B)

- Migration B: the nine option/telemetry columns and the health index.
- The Schedule editor: guided form, cadence picker with next-three-fires, options panel with
  inherited-value labels, caps and cadence-floor refusals.
- `PATCH /api/schedules/:id`, `POST /api/schedules/:id/{duplicate,reassign}`, option fields on
  `PATCH /api/tasks/:id`.
- Announce on completion, forced failure announcement, roll-up, auto-pause at 5, streak reset.
- `GET /api/schedules/calendar` + Week/Month views with did-it-run markers and over-limit copy.
- `GET /api/agents/:id/schedule-overlaps` + the overlap warning on both the editor and the Agent's
  heartbeat setting.
- `schedule-health-sweep` cron task and the cached health columns.

### P3 — Bulk safety (migration C)

- Migration C: `schedule_bulk_actions`.
- `POST /api/schedules/health/fix` with `expected`-hash enforcement, `POST /api/schedules/
  disable-all`, `POST /api/schedules/bulk/:id/undo`.
- `FixAllDialog`, `DisableAllDialog` (both scopes, typed confirm), `BreakerUndoBanner`,
  `SchedulesBulkBar` (multi-select pause/resume, cap 100).
- Bulk activity rows (one per batch), the 30-day pruning in the sweep.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** No external integration is added; no inline client is written. The
      model option resolves through the existing AI facade.
- [x] **II — Capability-driven resolution.** The editor's model list comes from the capabilities
      endpoint; no plugin id appears in `apps/web`, `apps/api` or `packages/agent` because of this
      epic.
- [x] **III — Source-of-truth repositories.** Schedules are platform metadata, which the principle
      explicitly assigns to the database. No Work content moves in or out of a repository.
- [x] **IV — Job runtime.** The one new cron (`schedule-health-sweep`) is registered on the
      configured provider in `packages/tasks`; every dispatch goes through
      `AGENT_TASK_EXECUTE_DISPATCHER` / `AGENT_HEARTBEAT_TRIGGER`; no third-party SDK is imported in
      `packages/agent`.
- [x] **V — Forward-only migrations.** Three additive migrations in `apps/api/src/migrations/`,
      existence-guarded, portable DDL, no rename and no data loss; each ships in the same PR as its
      entity change.
- [x] **VI — Tests are a prerequisite.** §10 names 11 agent-package suites, 9 controller specs, 7
      web unit specs and 9 end-to-end specs, phased with the code they cover.
- [x] **VII — Secrets.** Instructions go through the same secret scan the Agent instruction fields
      use; `entries.before/after` never store instruction text; nothing marked secret is rendered
      or logged.
- [x] **VIII — Plugin counts.** No plugin list changes, so the canonical doc is untouched.
- [x] **IX — Behaviour-first spec.** [spec.md](./spec.md) contains no class name, file path or
      code; all of that lives here.
- [x] **X — Backwards compatibility.** `GET /api/schedules` keeps its bare-array shape and gains
      only additive fields; paging is a new endpoint; every new column is nullable or defaulted to
      today's behaviour; no i18n key is renamed.

---

## 13. References

- Behaviour: [spec.md](./spec.md) · Tasks: [tasks.md](./tasks.md)
- Program: [../README.md](../README.md) · Tracker: [../TRACKER.md](../TRACKER.md)
- Runs and receipts: [../AW-09-runs-receipts/plan.md](../AW-09-runs-receipts/plan.md)
- The existing Schedules read model: [../../schedules/spec.md](../../schedules/spec.md) ·
  [../../schedules/plan.md](../../schedules/plan.md)
- Constitution: [../../../../../.specify/memory/constitution.md](../../../../../.specify/memory/constitution.md)
