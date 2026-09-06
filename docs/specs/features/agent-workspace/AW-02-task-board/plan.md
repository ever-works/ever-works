# AW-02 — Task board · Implementation plan

> Translates [`spec.md`](./spec.md) into architecture, endpoints, components and
> phasing. The plan owns implementation detail; the spec owns behaviour.

**Feature ID**: `aw-02-task-board`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

> **This plan ships no entity change, no new table, no new column and therefore no
> migration.** Every signal the board needs is already stored. Where that constrains
> a design, §3 says so and says what the constraint costs.

---

## 1. Current state in the codebase

Every path below was opened before being cited.

### 1.1 The board that already exists

[`apps/web/src/components/tasks/TasksKanbanView.tsx`](../../../../../apps/web/src/components/tasks/TasksKanbanView.tsx)
— 712 lines. This is the feature. What is in it:

| Concern | What is there |
| --- | --- |
| Columns | A `COLUMNS: ColumnDef[]` table with one entry per `TaskStatus` — `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled` — each with an icon, a dot class, a header class, a count class, a card-border class. **`label` is a hardcoded English string** on every entry |
| Transition affordance | `NEXT_STATUS: Record<TaskStatus, TaskStatus[]>`, a client-side mirror of the server lattice, used for both the `Move →` menu and drop-target refusal. Its own comment says the server stays authoritative |
| Drag and drop | Native HTML5 DnD — `draggable`, `onDragStart` (`text/x-task-id`), `onDragOver` (refuses when `NEXT_STATUS` disallows), `onDragLeave` with a bounding-rect check, `onDrop`. Optimistic move with rollback and a per-card error line |
| Post-drop dispatch | A drop into `in_progress` calls `listTaskRunCandidatesAction` and, when the Task has neither a `task_assignees` row nor its own `agentId`, opens the agent picker rather than moving silently |
| Per-card run | `RunWithAgentMenu` plus an `r` key handler that ignores modifiers, key repeat, text inputs and the open diff sheet |
| Per-column batch | `Run all`, capped at `RUN_ALL_MAX = 20` to mirror the API's `RUN_BATCH_MAX_TASKS`, offered only on `todo` / `backlog` / `in_progress`, reporting `n/m started` |
| Card chips | `TaskBranchChip`, `TaskPrPill` (with the CI dot), `TaskRunChip`, `GateChip`, and a `± N files` button opening `TaskDiffSheet` |
| Polling | `useTaskRunPolling` merging **only** run and PR fields by id, explicitly never status or title, so a poll cannot clobber an in-flight optimistic drag |
| Paging | `MAX_VISIBLE = 15` per column with a `Show N more` button — a client-side slice of an already-fetched array |
| Priority | `PRIORITY_TONES: Record<TaskPriority, string>` for all five of `p0`–`p4`. Rendered. Never sorted by |

**The interaction model is done and this plan does not touch it.** What is missing is
a read model behind it and a card that says where its work came from.

### 1.2 How the board is reached, and what it is given

| File | Today |
| --- | --- |
| [`apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx>) | RSC. Reads `status` / `priority` / `search` / `label` / `offset` search params, builds **one** query with `limit: 50` and `includeRun: true`, calls `tasksAPI.list`, renders `PageHeader` + `TasksTabsNav` + a filter `<form>` + `<TasksList tasks={result.data} />` + offset pagination. Its own doc comment ("Kanban + per-target tabs land in Phase 14") is stale |
| [`apps/web/src/components/tasks/TasksList.tsx`](../../../../../apps/web/src/components/tasks/TasksList.tsx) | Client, 328 lines. `VIEW_TABS = [cards, table, kanban]` with **hardcoded labels**, `useState<ViewKey>('cards')` — not in the URL, not persisted, not defaulting to the board — plus a `STATUS_FILTERS` strip with **hardcoded labels**, and its own `STATUS_TONES` / `PRIORITY_TONES` / `STATUS_DOT` maps. Renders `<TasksKanbanView tasks={filtered} />` when the view is `kanban` |
| [`apps/web/src/components/tasks/TasksScopedSection.tsx`](../../../../../apps/web/src/components/tasks/TasksScopedSection.tsx) | The reusable scoped list every parent entity mounts — `/missions/[id]/tasks`, `/works/[id]/tasks`, `/ideas/[id]/tasks`. It wraps the same `TasksList`, so **the board is already live on all of them** |
| [`apps/web/src/components/tasks/TasksTabsNav.tsx`](../../../../../apps/web/src/components/tasks/TasksTabsNav.tsx) | Server component, two tabs (`Tasks` / `Triggers`), i18n via `dashboard.taskTriggers.tabs`. Its comment says adding a tab is a one-line change |
| [`apps/web/src/lib/api/tasks.ts`](../../../../../apps/web/src/lib/api/tasks.ts) | `tasksAPI` — the server-only typed client. `Task`, `TaskStatus`, `TaskPriority` types |
| [`apps/web/src/app/actions/tasks.ts`](../../../../../apps/web/src/app/actions/tasks.ts) | `transitionTaskAction`, `runTasksBatchAction`, `listTaskRunCandidatesAction`, and the rest |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts) | `DASHBOARD_TASKS: '/tasks'` (214), `DASHBOARD_TASK_NEW` (215), `DASHBOARD_TASK_TRIGGERS` (216), `DASHBOARD_TASK_TRIGGER(id)` (217), `DASHBOARD_TASK(id)` (218), `DASHBOARD_TASK_TEMPLATES` (220). **No new route constant is needed** — the board is a view on `/tasks` |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) | Hardcoded nav array; "Tasks" already points at `ROUTES.DASHBOARD_TASKS`. **No sidebar change is needed** |

**The consequence of one 50-row fetch.** `page.tsx` asks for `limit: 50` with no
status filter; `TasksList` slices client-side; `TasksKanbanView` groups the array by
status and renders `{tasks.length}` as each column's header count. Every column count
on the board today is a count of one page, and nothing on screen says so. This is
spec §2.3 gap 1, and it is the whole reason P1 exists.

### 1.3 Task — the entity, and what it already carries

[`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts).
The board needs nothing added to it. What is already there and what the board reads:

| Need | Column already present |
| --- | --- |
| Column | `status` (`TaskStatus`, 7 values), `previousStatus` |
| Ordering | `priority` (`TaskPriority`, **five** values `p0`–`p4`), `updatedAt`, `createdAt` |
| Card identity | `slug` (per-user `T-n` via `UserTaskCounter`), `title`, `description`, `labels` |
| Provenance — owners | `missionId`, `ideaId`, `workId`, `teamId`, `agentId`, `goalId` — all nullable, all independent, all separately indexed with `(ownerId, status)`, **no `@ManyToOne` by design** (entity import-cycle avoidance) |
| Provenance — creator | `createdByType` (`'user'` or `'agent'`), `createdById` |
| Provenance — delegation | `delegationDepth` (server-written; null reads as 0) |
| Provenance — recurrence | `parentRecurringTaskId` (instance → its template) |
| Provenance — scheduling | `scheduledAt`, `scheduleClaimedAt` |
| Sub-tasks | `parentTaskId`, indexed by `idx_tasks_parent` |
| Recurring template | `isRecurring`, `recurrenceRule` xor `recurrenceCron`, `recurrenceTimezone`, `nextOccurrenceAt`, `recurrenceEndsAt`, `recurrenceMaxOccurrences`, `recurrenceOccurredCount`; indexed by `idx_tasks_recurrence_due (isRecurring, nextOccurrenceAt)` |
| Stall signal | `latestRunStatus` (`queued` / `running` / `completed` / `failed` / `cancelled`), `latestRunId`, `startedAt`, `updatedAt` |
| Hidden work | `hiddenFromBoard` (server-written by a Trigger with `showOnBoard: false`) |
| Existing chips | `branchRef`, `branchState`, `prNumber`, `prUrl`, `prState`, `ciState`, `prChecks`, `conflictPaths`, `linkedPullRequests` |
| Scope | `userId`, `tenantId`, `organizationId` |

> The established pattern in this domain, stated in the capability map §7.3, is that
> **new Task metadata becomes a new `task_*` side table, not a new column**. This
> epic needs neither.

### 1.4 The Task API — what the board can already ask for

[`apps/api/src/tasks/tasks.controller.ts`](../../../../../apps/api/src/tasks/tasks.controller.ts)
(`@Controller('api/tasks')`), 37 routes. Relevant today:

- `GET /api/tasks` — `status` (comma list), `priority` (comma list), `missionId`,
  `ideaId`, `workId`, `teamId`, `agentId`, `goalId`, `parentTaskId`, `label`,
  `search`, `limit` (max 200), `offset`, `includeRun`, `includeHidden`. Returns
  `{ data, meta: { total, limit, offset } }`.
- `POST /api/tasks/:id/transition` — the gated state machine the board already drags
  through.
- `POST /api/tasks/:id/run`, `GET /api/tasks/:id/run-candidates`,
  `POST /api/tasks/run-batch` (capped, 20/min) — the board's run path.
- `GET /api/tasks/:id/subtasks` — the checklist projection the roll-up will link to.
- `GET /api/tasks/:id/escalations`, `POST /api/tasks/:id/escalations/:eid/resolve`.
- `GET /api/tasks/:id/chat`, `POST /api/tasks/:id/chat` (60/min) and
  [`task-chat.controller.ts`](../../../../../apps/api/src/tasks/task-chat.controller.ts)'s
  `PATCH /:id` for the 5-minute edit.

[`packages/agent/src/database/repositories/task.repository.ts`](../../../../../packages/agent/src/database/repositories/task.repository.ts)
`list()` builds the query, counts with `getCount()`, then:

```
qb.orderBy('task.updatedAt', 'DESC').take(limit).skip(offset);
```

**That single `orderBy` is spec §2.3 gap 2.** There is no ordering option on
`ListTasksFilter`, so nothing in the product can ask for priority order.
`ListTasksFilter` (same file, line 12) has no `parentTaskId: null` form, no
`isRecurring` predicate, and no ordering field — the three additive filter gaps P1
and P2 close.

### 1.5 The signals the card flags derive from

| Flag | Source | Note |
| --- | --- | --- |
| Decision — escalation | [`packages/agent/src/entities/agent-escalation.entity.ts`](../../../../../packages/agent/src/entities/agent-escalation.entity.ts) | `status`, `taskId`, `runId`, `userId`; index `idx_agent_escalation_task_status` — a grouped count by `taskId` is an index-only scan |
| Decision — approval | [`packages/agent/src/entities/agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts) | `status` (`pending` default), `runId`, `agentId`, `userId`; reached from a Task through its runs |
| Stalled | `Task.status`, `Task.latestRunStatus`, `Task.updatedAt` | All three are on the row already. No join, no new column |
| Comment count | [`packages/agent/src/entities/task-chat-message.entity.ts`](../../../../../packages/agent/src/entities/task-chat-message.entity.ts) | `idx_task_chat_task_created (taskId, createdAt)` — a grouped count by `taskId` rides the leading column |
| Sub-task roll-up | `Task.parentTaskId` | `idx_tasks_parent` — one grouped `(parentTaskId, status)` count |
| Trigger provenance | [`packages/agent/src/entities/inbound-trigger.entity.ts`](../../../../../packages/agent/src/entities/inbound-trigger.entity.ts) and its fire row | The fire row records the `taskId` it produced. A reverse lookup by `taskId IN (…)` attributes the chip **without a `triggerId` column on Task** |

### 1.6 The comment and steering seam — already solved at Task scope

- [`packages/agent/src/tasks-domain/task-chat.service.ts`](../../../../../packages/agent/src/tasks-domain/task-chat.service.ts)
  — `MAX_CHAT_BYTES = 16 * 1024`, a 5-minute edit window, `@mention` and `[[kb]]`
  parsing with unknown tokens stripped, and a fan-out to `agent-chat-reply`.
- [`packages/agent/src/tasks-domain/run-steering-port.ts`](../../../../../packages/agent/src/tasks-domain/run-steering-port.ts)
  — `RUN_STEERING_PORT`, `steer({ runId, userId, message }) → { dispatched:
  'injected' | 'new-run', runId, queuedCount? }`. When a chat message mentions an
  Agent that already has a live run, the message is **injected into that run's
  pending-input queue** rather than starting a second one. Bound by the API-side
  `@Global()` agents module; unbound in unit tests, where the service falls back to
  dispatching a new run.

**Everything the spec's §4.8 asks for is this seam, already built.** The board opens
the existing thread and posts through the existing endpoint. No new service.

### 1.7 Cross-cutting infrastructure

| Concern | File | Note |
| --- | --- | --- |
| Migrations | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations/) | Timestamp-prefixed, forward-only, self-applied by the API on boot. **Not** `packages/agent/src/migrations/`, which does not exist. **This epic adds none** |
| Entity barrel | [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts) | Untouched — no entity is added |
| Activity log | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) | `TASK_CREATED/UPDATED/DELETED/ASSIGNED/TRANSITIONED/COMMENTED/COMPLETED/RECURRENCE_FIRED/MERGED` already exist. `actionType` is a free `varchar(50)`, so appending a member needs no migration |
| Notifications | [`packages/agent/src/entities/notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts) + [`task-notification.service.ts`](../../../../../packages/agent/src/tasks-domain/task-notification.service.ts) | `NotificationCategory.TASK` **already exists**. The kind→severity map already holds `task_assigned`, `task_mentioned`, `task_status_changed`, `task_blocked`, `task_due_soon`, `task_recurrence_fired`, `task_run_no_agent`. Adding `task_stalled` is one map entry. `deduplicationKey` is uniquely indexed per user — the "once per stalled streak" rule rides on it |
| Job runtime | [`packages/tasks/src/tasks/trigger/`](../../../../../packages/tasks/src/tasks/trigger/) | Shape to copy: the existing `task-recurrence-dispatcher` and `task-pr-status-sync` tasks — `schedules.task({ id, cron, run })` spinning a transient `TriggerInternalModule` Nest context |
| Schedules read model | [`packages/agent/src/schedules/schedule-view.types.ts`](../../../../../packages/agent/src/schedules/schedule-view.types.ts) + [`cadence.ts`](../../../../../packages/agent/src/schedules/cadence.ts) | `sourceType: 'recurring_task'` already exists, and `describeCron` / `describeRrule` already render a cadence in plain language. **The recurring strip reads this, it does not re-derive cadence text** |
| i18n | [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) | `dashboard.tasksPage.status.*` already holds all seven column names; `dashboard.tasksPage.priority.*` already holds all five priority labels; both are already translated across the platform's locales. Leaf keys are camelCase and must never contain a literal `.`; a missing **parent** key collapses a whole subtree |
| Ownership | [`packages/agent/src/database/ownership-scope.ts`](../../../../../packages/agent/src/database/ownership-scope.ts) | `OwnershipScope`, `ownershipWhere`, `ownershipSqlPredicate` — the canonical user + Organization filter every board query uses |

---

## 2. Architecture and the seam

### 2.1 One board read, N column reads, no derived state

```
   Browser  /tasks?view=board&layout=status&label=pricing
        │
        │  RSC first paint: column frames + counters skeleton
        ▼
   apps/web/src/app/[locale]/(dashboard)/tasks/page.tsx
        │  tasksAPI.board(filters)
        ▼
   GET /api/tasks/board?…                     (X-Scope-Slug attached)
        │
        ▼
   apps/api/src/tasks/tasks.controller.ts   @Get('board')
        │
        ▼
   packages/agent/src/tasks-domain/task-board.service.ts
        │
        ├── Q1  per-status COUNT(*) GROUP BY status        → the 7 true totals
        ├── Q2  per-status top-N rows, priority-ordered     → the cards
        ├── Q3  recurring templates due next                → the strip
        └── enrich(cards)  ── one batched read each, all independently guarded:
              ├── E1 open escalations   GROUP BY taskId
              ├── E2 pending approvals  via runs, GROUP BY taskId
              ├── E3 chat messages      GROUP BY taskId
              ├── E4 sub-tasks          GROUP BY parentTaskId, status
              ├── E5 trigger fires      taskId IN (…) → triggerId, name
              └── E6 owner names        one IN-query per distinct owner kind
        │
        ▼
   { columns: [{ status, total, cards[] }], recurring[], counters, window }
```

Three properties this shape buys:

1. **A column count is never a page count.** Q1 answers the header; Q2 answers the
   cards; they share one predicate builder so they cannot disagree.
2. **Columns page independently.** `GET /api/tasks/board/column?status=todo&offset=50`
   returns only that column, so **Show 50 more** never re-reads or re-orders another.
3. **Every enrichment is optional.** E1–E6 each run in their own `try/catch` and each
   failure degrades exactly one chip family. This is the same per-source fault
   isolation the existing schedules aggregator uses, and it satisfies spec FR-13.

The enrichment reads are **batched over the page of cards**, never per card: at most
`7 × 50 = 350` ids in one `IN (…)` per source, six sources, six queries. Not 350 × 6.

### 2.2 Why the column is status and nothing else

A column that is derived — from decisions, from run state, from freshness — can
disagree with the Task's own status, and the first time a user sees a card in
"Needs you" whose detail page says `in_progress`, the board stops being believable.
So:

- **Status layout** — column ↔ status, 1:1, all seven. This is today's board.
- **Focus layout** — column ↔ a named group of statuses, declared in one table, four
  groups plus the toggled `Cancelled`. Still nothing but status.
- **Decisions and stalls are card flags and header counters**, never columns. They
  can occur in any column, which is precisely why they cannot be one.

A shared `packages/agent/src/tasks-domain/task-board-columns.ts` owns both layouts as
pure data, so client and server compute the same mapping from the same table.

### 2.3 Drop resolution in the Focus layout

The existing board's `NEXT_STATUS` mirror handles the seven-column case: a column *is*
a status, so a drop is unambiguous. A grouped column needs a resolution rule:

```
resolveDrop(from: TaskStatus, column: FocusColumn): Resolution
  legal = column.statuses.filter(s => ALLOWED[from].includes(s))
  legal.length === 0  → { kind: 'refuse', reason }
  legal.length === 1  → { kind: 'apply',  to: legal[0] }
  legal.length  >  1  → { kind: 'ask',    options: legal }
```

Against the real lattice, `ask` arises in exactly one place — `in_progress` dropped
on `Needs you`, where both `in_review` and `blocked` are legal — which is a genuine
question, not an implementation wart. Everything else resolves or refuses. The
function is pure and lives beside the column table, unit-tested against the full
7 × 5 matrix.

**The server is unchanged.** Every resolved drop calls the existing
`POST /api/tasks/:id/transition`, which re-checks the lattice. The client rule is an
affordance, exactly as `NEXT_STATUS` is today.

### 2.4 The stall predicate

```
isStalled({ status, latestRunStatus, updatedAt, now, thresholdDays }):
     status === 'in_progress'
  && (latestRunStatus === null || TERMINAL.has(latestRunStatus))
  && now - updatedAt > thresholdDays × 86_400_000
```

Pure, three fields, all on the row. Pushed into SQL for the column ordering (stalled
first) and recomputed in the same function on the client for the flag, so the two
cannot drift.

**What this costs, stated plainly.** `updatedAt` moves when anything on the row
changes, including a title edit or a PR-status cache refresh. So the predicate
**under-reports**: a stalled Task that gets touched loses its flag until the
threshold elapses again. It never over-reports — it cannot claim a Task is stalled
when something is running or something changed. That asymmetry is the reason this is
acceptable without a new column, and §13 records the alternative if it stops being.

### 2.5 What this epic does **not** touch

- `TasksKanbanView`'s drag handlers, optimistic move, rollback, `r` shortcut,
  `RunWithAgentMenu`, `Run all`, diff sheet, or `useTaskRunPolling` merge rules.
- The Cards and Table views in `TasksList`.
- `POST /api/tasks/:id/transition`, `/run`, `/run-batch`, `/chat` — used as-is, not
  modified.
- Any Missions file, route, endpoint, entity or component.
- `apps/web/src/app/[locale]/(dashboard)/tasks/{new,templates,triggers}/`.
- The `Task` entity, the entity barrel, and `apps/api/src/migrations/`.

---

## 3. Data model

**No entity, table or column is added by this epic.** This section records what was
needed, where it comes from instead, and what each substitution costs.

### 3.1 Every board signal, and the stored state it comes from

| Board signal | Comes from | Cost of not storing it |
| --- | --- | --- |
| Column | `Task.status` | — |
| Order | `Task.priority`, `Task.updatedAt` + the stall predicate | Needs an `orderBy` option on the list filter (§3.2) |
| True column total | `COUNT(*) GROUP BY status` under the filter predicate | One extra grouped query per board read; index-only on `idx_tasks_user_status` |
| Mission / Idea / Work / Team / Goal / Agent chip | The six owner columns + one name lookup per distinct kind | Six small `IN` queries; each is a PK read |
| `Raised by {agent}` | `createdByType = 'agent'` + `createdById` | Shares the Agent name lookup |
| `Delegated · depth n` | `delegationDepth` | — |
| `⟳ {template}` on an instance | `parentRecurringTaskId` + a title lookup | One `IN` on `tasks` |
| `Template` on a template | `isRecurring` | Needs an `isRecurring` predicate on the list filter (§3.2) |
| `Scheduled {when}` | `scheduledAt` | — |
| `Trigger · {name}` | Reverse lookup on the trigger fire log by `taskId` | One `IN` on the fire table. Cheaper than a `triggerId` column on `tasks`, which would need a migration, a backfill, and a writer on every fire path |
| Sub-task roll-up | `COUNT(*) GROUP BY parentTaskId, status` | One grouped query on `idx_tasks_parent` |
| Top-level only | `parentTaskId IS NULL` | Needs a "no parent" form on the list filter (§3.2) |
| Decision count | Grouped counts over escalations and pending approvals | Two grouped queries, both index-backed |
| Comment count | `COUNT(*) GROUP BY taskId` on the chat table | One grouped query on `idx_task_chat_task_created`. A denormalised counter would need a writer on post, edit and delete plus a repair job — for a chip |
| Stalled | `status`, `latestRunStatus`, `updatedAt` | Under-reports after an unrelated edit (§2.4) |
| Hidden | `hiddenFromBoard` | — |

### 3.2 Additive filter options — types only, no schema

Three additions to `ListTasksFilter` in
[`packages/agent/src/database/repositories/task.repository.ts`](../../../../../packages/agent/src/database/repositories/task.repository.ts).
All optional; omitting all three reproduces today's query byte for byte.

| Field | Shape | Predicate | Default |
| --- | --- | --- | --- |
| `parentTaskId` | widen from `string` to `string \| 'none'` | `'none'` → `task.parentTaskId IS NULL`; a uuid keeps today's meaning | unchanged |
| `isRecurring` | `boolean \| undefined` | `true` → `isRecurring = true`; `false` → `isRecurring = false`; `undefined` → no predicate, today's behaviour | `undefined` |
| `orderBy` | `'updatedAt' \| 'priorityThenUpdated' \| 'stalledThenPriority'` | `'updatedAt'` is today's `ORDER BY task.updatedAt DESC` and stays the default for every existing caller | `'updatedAt'` |

`'stalledThenPriority'` compiles to:

```sql
ORDER BY
  CASE WHEN task.status = 'in_progress'
        AND (task.latestRunStatus IS NULL
             OR task.latestRunStatus IN ('completed','failed','cancelled'))
        AND task.updatedAt < :stallCutoff
       THEN 0 ELSE 1 END ASC,
  task.priority ASC,          -- 'p0' < 'p1' < … < 'p4' lexicographically
  task.updatedAt ASC
```

`task.priority` is a `varchar(4)` holding `p0`–`p4`, so lexicographic order **is**
priority order. No `CASE` mapping and no numeric column are needed; the comment on
the ordering must say so, because it looks accidental and is not.

### 3.3 The stall threshold

Read from the existing preference row —
[`packages/agent/src/entities/work-agent-preference.entity.ts`](../../../../../packages/agent/src/entities/work-agent-preference.entity.ts),
the same row that already holds `missionDefaultOutstandingCap`. P3 reads it; **if a
dedicated column is wanted rather than a platform constant, that column is the one
schema change in the whole epic and it ships as an additive forward-only migration in
`apps/api/src/migrations/` in the same PR.** P1 and P2 use the constant and touch
nothing.

Default `2` days, clamped `1..30` in a pure `clampStallAfterDays()` beside the
predicate.

### 3.4 Enum-shaped additions that need no migration

- `NotificationCategory.TASK` — **already exists**.
- The stall notification kind `task_stalled` — one entry in the existing kind map in
  `task-notification.service.ts`; the column is a free `varchar`.
- `ActivityActionType` — the board writes none of its own; every transition it
  performs already writes `TASK_TRANSITIONED` through the existing service.

---

## 4. API surface

`@Controller('api/tasks')` gains **two** read routes. Every existing route is
unchanged.

### 4.1 P1

**`GET /api/tasks/board`** — the board read model.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `layout` | `status \| focus` | `status` | Which column table to group by |
| `columnLimit` | int 1–100 | 50 | Cards per column |
| `terminalWindowDays` | int 1–90 | 7 | Bounds `done` and `cancelled` (spec FR-10, S25) |
| `priority`, `label`, `search` | as the list route | — | Same parsing helpers |
| `missionId`, `ideaId`, `workId`, `teamId`, `agentId`, `goalId` | uuid | — | Same `ParseUUIDPipe({ optional: true })` |
| `includeSubtasks` | `'true'` | off | Off → `parentTaskId: 'none'` |
| `includeTemplates` | `'true'` | off | Off → `isRecurring: false` |
| `includeHidden` | `'true'` | off | Same meaning as the list route |
| `includeCancelled` | `'true'` | layout-dependent | `focus` only; `status` always includes it |

Response:

```jsonc
{
  "layout": "status",
  "columns": [
    { "key": "todo", "statuses": ["todo"], "total": 140,
      "cards": [ /* Task rows, run-embedded, plus the enrichment block below */ ] }
  ],
  "recurring": [
    { "id": "…", "title": "Weekly link sweep", "cadenceText": "Every Monday at 09:00",
      "nextOccurrenceAt": "…", "ended": false }
  ],
  "counters": { "waitingOnYou": 3, "doneToday": 7 },
  "terminalWindowDays": 7,
  "degraded": []            // names of enrichments that failed this read
}
```

Each card carries an additive `board` block — never a change to the existing `Task`
shape:

```jsonc
"board": {
  "stalled": true,
  "openDecisions": 1,
  "commentCount": 3,
  "subtasks": { "done": 2, "total": 5 },
  "provenance": [
    { "kind": "recurringTemplate", "id": "…", "name": "Weekly link sweep" },
    { "kind": "agent", "id": "…", "name": "Editor" }
  ]
}
```

`provenance` is returned **fully ordered by the FR-28 precedence and already
scope-filtered**, so the client renders the first two and menus the rest without
knowing the rules. Throttle: matches the existing list route.

**`GET /api/tasks/board/column`** — one column, for **Show 50 more**.
Same query parameters plus `status` (a single column key) and `offset`; returns
`{ key, statuses, total, cards }`. This is what makes FR-8's independent paging true.

### 4.2 P2

No new route. P2 is enrichment inside the P1 response (provenance, sub-task roll-up,
comment count, decision count) plus the client work in §5. The one server change is
the enrichment layer itself in `task-board.service.ts`.

### 4.3 P3

No new route. P3 adds:

- the stall flag to the P1 response's `board` block (the predicate is already in the
  ordering);
- a scheduled job, not an endpoint, for the notification (§6);
- the Focus layout, which is a `layout=focus` value on the existing route.

---

## 5. Web surface

### 5.1 Route and shell

`/tasks` — no new route, no new route constant, no sidebar change.
`page.tsx` changes shape: it reads `view` and the board's filters from search params
and, for `view=board`, calls `tasksAPI.board(...)` instead of `tasksAPI.list(...)`.
For `view=cards|table` it keeps calling `tasksAPI.list(...)` exactly as today.

View resolution order, implemented once in a small `resolveTasksView()`:
`?view=` → a `tasks.view` cookie → `'board'`.

### 5.2 New and changed components

Under `apps/web/src/components/tasks/`:

| File | Kind | What |
| --- | --- | --- |
| `board/TaskBoard.tsx` | new, client | The board shell: layout switcher, toggles, recurring strip, column strip, error panel. Owns the column state and the per-column paging |
| `board/TaskBoardColumn.tsx` | new, client | One column. **Extracted from the existing `TaskKanbanColumn`** and given a true total, an independent `Show more`, the empty copy, and the drop rules of §2.3 |
| `board/TaskBoardCard.tsx` | new, client | **Extracted from the existing `TaskKanbanCard`**, unchanged in behaviour, plus the flag row, the provenance row, the roll-up and the comment chip |
| `board/TaskProvenanceChips.tsx` | new, client | Renders the `board.provenance` array; each chip is a filter link |
| `board/TaskBoardFlags.tsx` | new, client | Stalled flag, Decision chip and its `Open decision` action, Hidden and Template chips |
| `board/TaskRecurringStrip.tsx` | new, client | The collapsed/expanded strip of §6.5 |
| `board/TaskBoardFilters.tsx` | new, client | The board's filter bar, writing to the URL; kept in sync with the page's existing server-rendered `<form>` |
| `TasksKanbanView.tsx` | **kept** | Becomes a thin adapter that renders `TaskBoard` from a plain `Task[]`, so every existing caller — `TasksList`, `TasksScopedSection` and the three scoped routes — keeps compiling and keeps working with no change |
| `TasksList.tsx` | changed | `VIEW_TABS` labels and `STATUS_FILTERS` labels move to the catalogue; the view state moves from `useState` to the URL + cookie; `kanban` renders the new board |

In `packages/agent/src/tasks-domain/`:

| File | What |
| --- | --- |
| `task-board-columns.ts` | Both layout tables, `resolveDrop()`, `columnForStatus()`. Pure, no imports from TypeORM or NestJS. **Imported by both the API and the web client**, so the two cannot disagree |
| `task-board-stall.ts` | `isStalled()`, `clampStallAfterDays()`, `stallCutoff()`. Pure |
| `task-board-provenance.ts` | `orderProvenance()` implementing FR-28's precedence. Pure |
| `task-board.service.ts` | The read model of §2.1. The only new service |

### 5.3 State and data fetching

- First paint is RSC: the column frames, headers and skeletons render before the
  board data lands (spec §6.7).
- The board is a client component from there on. Filters and view live in the URL;
  changing one is a shallow route push, not a full navigation.
- Per-column paging calls the column route through a new server action and appends to
  that column's array only.
- `useTaskRunPolling` is reused unchanged — its merge already touches only run and PR
  fields, which is exactly what a board refresh must not widen.

### 5.4 New server actions — `apps/web/src/app/actions/tasks.ts`

Appended beside the existing ones, none of which change:

- `getTaskBoardAction(filters)` → the P1 read.
- `getTaskBoardColumnAction(filters, status, offset)` → the column read.
- `setTasksViewAction(view)` → writes the `tasks.view` cookie.

---

## 6. Background work

One scheduled task, P3 only, following the shape of the existing
`task-recurrence-dispatcher` and `task-pr-status-sync` tasks in
`packages/tasks/src/tasks/trigger/`:

**`task-stall-sweep`** — `17 */6 * * *` (four times a day, offset off the hour so it
never collides with the minute-cadence dispatchers).

1. Select Tasks where `status = 'in_progress'` AND `updatedAt < cutoff` AND
   (`latestRunStatus IS NULL` OR terminal), capped per sweep in the same way
   `MISSION_TICK_MAX_PER_TICK` caps the mission tick.
2. For each, call the existing `TaskNotificationService` with kind `task_stalled` and
   `deduplicationKey = ${taskId}:stalled:${startedAt ?? updatedAt}`.

The dedupe key is what makes spec FR-60's "once per stalled streak" true without any
new state: the key changes only when the Task moves, because moving it changes
`updatedAt` and clears the condition; the next stall produces a new key. The
notification table's per-user unique index on `deduplicationKey` does the rest.

Constitution IV: dispatched through the configured job-runtime provider, in a
transient `TriggerInternalModule` context, exactly as its neighbours are.

---

## 7. Plugin boundaries

None. This epic introduces no external integration, reads no third-party API, and
adds no plugin package. Constitution I and II are satisfied vacuously, and the
canonical plugin count is untouched.

The only place a provider is even adjacent is the pull-request CI dot on a card,
which is fed by the existing `task-pr-status-sync` cron through the existing git
provider plugin. The board reads the cached verdict off the Task row and makes no
provider call of its own.

---

## 8. i18n

All keys go under the **existing** `dashboard.tasksPage` namespace, in a new `board`
child. Leaf names are camelCase and contain no literal dot; the parent `board` key is
added in the same change so no subtree can collapse.

**Reused, not re-declared** — these already exist and are already translated:

- `dashboard.tasksPage.status.{backlog,todo,inProgress,inReview,blocked,done,cancelled}`
  — the seven column names. *(The catalogue's existing leaves are keyed by the status
  value; the board must read them through the same accessor the list already uses,
  not copy the strings.)*
- `dashboard.tasksPage.priority.{p0,p1,p2,p3,p4}` — Urgent, High, Medium, Normal, Low.
- `dashboard.tasksPage.list.*` — the existing filter, pagination and new-Task strings.
- `dashboard.taskTriggers.tabs.*` — the Tasks/Triggers tab strip.

**New, under `dashboard.tasksPage.board`:**

```
board.viewCards            board.viewTable            board.viewBoard
board.layoutStatus         board.layoutFocus
board.focusBacklog         board.focusInFlight        board.focusNeedsYou
board.focusDone            board.focusCancelled
board.focusBacklogStatuses board.focusInFlightStatuses
board.focusNeedsYouStatuses board.focusDoneStatuses
board.counterWaitingOnYou  board.counterDoneToday
board.sortTooltip          board.terminalWindow
board.moveTo               board.runAll               board.runAllTitle
board.showMore             board.showingOf
board.diffTooltip
board.emptyBoardTitle      board.emptyBoardBody
board.emptyBacklog         board.emptyTodo            board.emptyInProgress
board.emptyInReview        board.emptyBlocked         board.emptyDone
board.emptyCancelled
board.errorTitle           board.errorBody            board.errorRetry
board.errorOpenTable
board.stalled              board.stalledTooltip
board.decisionOne          board.decisionMany         board.openDecision
board.subtaskRollup        board.subtaskOf
board.commentOne           board.commentMany
board.provenanceMission    board.provenanceIdea       board.provenanceWork
board.provenanceTeam       board.provenanceGoal       board.provenanceAgent
board.provenanceTrigger    board.provenanceScheduled  board.provenanceRaisedBy
board.provenanceDelegated  board.provenanceFiledByYou board.provenanceRecurring
board.recurringSummary     board.recurringShow        board.recurringHide
board.recurringLead        board.recurringEnded       board.recurringSchedules
board.templateChip         board.templateTooltip
board.hiddenChip           board.hiddenTooltip
board.toggleSubtasks       board.toggleTemplates
board.toggleCancelled      board.toggleHidden
board.dropRefusedCancelled board.dropPickerTitle
board.clearFilters
```

And one notification pair beside the existing Task notification strings:

```
notifications.taskStalled.title     notifications.taskStalled.body
```

Every one of these replaces or extends a string that is **hardcoded English in
`TasksKanbanView.tsx` and `TasksList.tsx` today** — `Backlog`, `Todo`,
`In Progress`, `In Review`, `Blocked`, `Done`, `Cancelled`, `Cards`, `Table`,
`Kanban`, `All`, `Move →`, `Run all`, `Run N Task(s) in X`, `empty`,
`Show N more`, `Preview the changes on this Task's branch`, `n/m started`,
`Transition failed`. Removing every one of them is a P1 acceptance criterion, not a
P3 nicety, because program rule #8 is not optional and because the seven status names
are already translated and simply unused.

After editing `en.json`, run the catalogue's existing locale-sync and translation scripts
so all sibling locales stay structurally identical.

---

## 9. Telemetry and failure modes

### 9.1 Activity log

The board writes **no new activity type**. Every transition it performs already
writes `TASK_TRANSITIONED` through the existing transition service; every run it
dispatches already writes through the existing run path. Adding a board-specific
type would double-count the same event.

### 9.2 Product analytics

| Event | Properties |
| --- | --- |
| `task_board_opened` | `layout`, `columnCount`, `totalTasks`, `filtersActive[]`, `degraded[]` |
| `task_board_column_paged` | `status`, `offset` |
| `task_board_filter_applied` | `filter`, `source` (`chip` / `bar` / `url`) |
| `task_board_provenance_clicked` | `kind` |
| `task_board_decision_opened` | — |
| `task_board_stall_flag_shown` | `days` |
| `task_board_layout_switched` | `from`, `to` |
| `task_board_drop_picker_shown` | `from`, `column`, `options[]` |

`filtersActive` carries filter **names**, never values — a label or a search term is
user content and does not belong in analytics.

### 9.3 Sentry

The board read is instrumented as one span with the six enrichments as child spans,
so a slow board is attributable to the query that caused it. A degraded enrichment is
a breadcrumb, not an exception — it is an expected state (FR-13), and paging it would
train the team to ignore it.

### 9.4 Failure modes and the chosen degradation

| Failure | Degradation |
| --- | --- |
| The whole board read fails | Column frames + the error panel of spec §6.11. Never an empty board presented as "no Tasks" |
| One column's read fails | That column shows the panel; the others render |
| Decision counts fail | Decision chips absent, `waiting on you` reads `—`. Board works |
| Comment counts fail | Comment chips absent. Board works |
| Sub-task roll-up fails | Roll-up absent; nothing is double-counted, because the top-level filter is a predicate on the card query, not on the roll-up |
| Provenance name lookup fails | Chips absent for that kind (FR-29's rule already omits an unresolvable name) |
| Trigger fire lookup fails | Trigger chips absent; the other provenance kinds still render |
| The recurring strip read fails | The strip is hidden. Templates remain out of the columns — the exclusion is a predicate on the card query, not a consequence of the strip |
| The stall sweep fails | Flags still render (they are computed at read time); only the notification is missed, and the next sweep sends it |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest, `packages/agent`)

- `task-board-columns.spec.ts` — the Status table covers all seven statuses exactly
  once; the Focus table covers all seven across its groups plus the toggle;
  `resolveDrop()` against the full 7 × 5 matrix, asserting `apply` / `ask` / `refuse`
  for every pair, and specifically that `in_progress → Needs you` is the only `ask`.
- `task-board-stall.spec.ts` — the predicate at 47 h / 49 h; with a running run;
  with a null `latestRunStatus`; in every non-`in_progress` status; the clamp at
  0 / 1 / 30 / 31 / null.
- `task-board-provenance.spec.ts` — precedence with all twelve sources present; with
  ties; with an unresolvable name (omitted, not rendered as an id); the two-shown /
  rest-menued split.
- `task.repository.spec.ts` — the three new filter options: `parentTaskId: 'none'`
  emits `IS NULL`; `isRecurring: false` emits the predicate; `isRecurring:
  undefined` emits none; each `orderBy` value emits the expected clause; **omitting
  all three reproduces the current SQL exactly** (the regression that matters most).
- `task-board.service.spec.ts` — totals come from the grouped count and not from
  `cards.length`; each enrichment failure degrades only itself and names itself in
  `degraded[]`; the enrichment reads are batched (assert one call per source with an
  `IN` list, not N calls).

### 10.2 Controller specs — API (Jest, colocated in `apps/api/src/tasks/`)

Following the existing `tasks.controller.*.spec.ts` files:

- `tasks.controller.board.spec.ts` — default parameters reproduce the documented
  defaults; `layout=focus` returns four columns plus the toggle behaviour;
  `columnLimit` clamps at 1 and 100; `terminalWindowDays` clamps at 1 and 90;
  `includeSubtasks` / `includeTemplates` / `includeHidden` each flip exactly one
  predicate; the `board` block is present on every card.
- `tasks.controller.board-scope.spec.ts` — another user's Task is absent from every
  column and every count; a provenance name the caller cannot see is omitted;
  cross-user column paging 404s in the same shape as the existing scope specs.
- `tasks.controller.board-visibility.spec.ts` — **extend the existing file**:
  `hiddenFromBoard` rows are absent from the board read's columns *and* its counts,
  and present with `includeHidden=true`.
- Regression: the existing `GET /api/tasks` controller specs must pass untouched.
  Any diff there means the additive promise was broken.

### 10.3 End-to-end — web (Playwright, `apps/web/e2e/`)

- Board is the landing view with no stored preference; `?view=table` overrides;
  switching persists across a reload.
- Column header totals match a seeded fixture of 120 Tasks across seven statuses,
  while only 50 cards render in the largest column.
- **Show 50 more** on one column leaves the other columns' rendered card counts and
  scroll positions unchanged.
- A `p0` Task seeded with an old `updatedAt` renders first in its column.
- A Mission-owned, a trigger-fired, a recurrence-cloned and a hand-filed Task each
  render their expected provenance chip; clicking the Mission chip filters the board
  and updates every count; **no Mission renders as a card**.
- A parent with five sub-tasks renders one card with `2/5`; **Show sub-tasks**
  restores six cards.
- A recurring template is in the strip and in no column; **Show templates** puts it
  back, chipped and not draggable.
- A Task with an open escalation shows the Decision chip while staying in
  `In progress`.
- Focus layout: dragging `in_progress` onto `Needs you` opens the picker; choosing
  `Blocked` moves the card; cancelling changes nothing.
- The board's existing behaviours still pass: drag to transition, the `r` shortcut,
  `Run all`, the diff sheet.

### 10.4 Web unit specs (Vitest, `apps/web`)

- `TaskBoardCard` renders an Agent-supplied title containing markup as literal text.
- `TaskProvenanceChips` renders two chips and menus the third.
- `TasksList` view resolution: URL beats cookie beats the board default.
- A hydration spec over the new keys — a missing parent key must fail the suite here
  rather than reddening every e2e shard.

### 10.5 What must be green before merge

`pnpm lint`, `pnpm type-check`, `pnpm --filter @ever-works/agent test`,
`pnpm --filter @ever-works/api test`, `pnpm --filter @ever-works/web test`, the
locale-sync check, and the Playwright specs above.

---

## 11. Phasing

Each phase is independently shippable, is additive, and **adds no migration**.

### P1 — Make the board true

The board stops lying and becomes a place you can link to.

- `task-board-columns.ts` and the three filter options.
- `task-board.service.ts` with Q1–Q3 only (no enrichment yet).
- `GET /api/tasks/board` and `GET /api/tasks/board/column`.
- `TaskBoard` / `TaskBoardColumn` / `TaskBoardCard` extracted from the shipped view,
  behaviour unchanged, plus true totals, per-column paging, the empty and error
  states.
- View and filters in the URL, remembered per browser, board as the default.
- **Every hardcoded string on the board moved to the catalogue**, reusing the seven
  status names and five priority labels that already exist.
- Priority ordering.

Ships without: provenance, roll-ups, decision chips, comment chips, stall flags, the
Focus layout, the recurring strip.

### P2 — Make the card legible

- The six enrichment reads and the `board` block on each card.
- Provenance chips with their precedence and their filter links.
- Sub-task roll-up and the top-level-only default with its toggle.
- The recurring strip, reading the existing cadence describers, plus the templates
  toggle.
- Decision chip, `Open decision` action, and the two header counters.
- Comment count and the reply affordance, opening the existing thread.

### P3 — Make it say when it is stuck

- The stall predicate in the ordering and on the card.
- `task-stall-sweep` and the `task_stalled` notification kind.
- The Focus layout and its drop picker.
- Saved views as named URLs on the user's existing preferences.

---

## 12. Constitution compliance

| Gate | How this plan satisfies it |
| --- | --- |
| **I — Plugin-first** | No external integration. No provider client. §7 |
| **II — Capability-driven** | No plugin id anywhere. Runs go through the existing gated dispatch path the board already uses |
| **III — Source-of-truth repos** | Reads platform metadata only. No Work content enters the database; no Task content leaves it |
| **IV — Job-runtime provider** | The one scheduled job (`task-stall-sweep`) is a `schedules.task` in `packages/tasks/src/tasks/trigger/`, dispatched through the configured provider, in a transient `TriggerInternalModule` context. §6 |
| **V — Forward-only migrations** | **No schema change ships.** If §3.3's threshold column is later adopted it ships as an additive forward-only migration in `apps/api/src/migrations/` in the same PR as the column. `packages/agent/src/migrations/` does not exist and is never cited |
| **VI — Tests first-class** | Pure logic has Jest unit specs; every endpoint has a colocated controller spec; every new user-visible flow has a Playwright spec; the existing list-route specs must pass untouched. §10 |
| **VII — Secrets** | No secret is introduced, read or logged. The Trigger provenance chip carries a trigger's **name**, never its secret |
| **VIII — Plugin counts** | No plugin added; the canonical plugin doc is untouched |
| **IX — Behaviour-first spec** | The spec names no class, file or library; every path in this document was opened before being cited |
| **X — Backwards compatibility** | Every new request parameter is optional and its absence reproduces today's SQL; every new response field is additive; `TasksKanbanView` is kept as an adapter so every existing caller compiles; every changed default has a one-action toggle back |

---

## 13. Follow-ups deliberately not taken here

- **Extract a shared board primitive.** Three Kanban views exist —
  `TasksKanbanView`, [`WorksKanbanView`](../../../../../apps/web/src/components/works/WorksKanbanView.tsx)
  and [`ActivityKanbanView`](../../../../../apps/web/src/components/activity-log/ActivityKanbanView.tsx)
  — sharing no primitive. Unifying them is a refactor with its own blast radius across
  three domains; it should be its own change with its own tests.
- **A stored last-progress timestamp.** §2.4 states what the derived signal costs. If
  under-reporting proves unacceptable, the right home is the run or the activity
  trail, **not** a twelfth denormalised column on `Task` — the domain's own
  convention (capability map §7.3) is a `task_*` side table for new Task metadata.
- **Bind the Task watcher entity to a UI.** `TaskWatcher` exists, is indexed, and has
  no endpoint and no screen. Surfacing it is [AW-13](../AW-13-attention-controls/)'s
  work; this plan records it so it is not rediscovered as missing.
- **Cursor pagination on the schedules aggregation.** The recurring strip reads a
  read model the schedules service already caps per source at 500 rows and documents
  as un-paginated for v1. [AW-10](../AW-10-schedules-calendar/) owns that.
- **Reconcile the two inbound-trigger management UIs.** `/tasks/triggers` and the
  Activity page's schedules tab both manage the same entity with two i18n namespaces.
  The board only reads trigger **names**, so it is unaffected, but the duplication is
  real and belongs to whoever owns that IA decision.
- **Update the stale doc comments.** `tasks/page.tsx` says Kanban "lands in Phase 14"
  and `tasks/new/page.tsx` says the scope picker "lands in a follow-up tick"; both
  shipped. A one-line comment fix, not this epic's job to bundle.
- **Correct README §1.1's priority scale** from four steps to five (spec §9). One
  line, and it should ride with this epic's PR.

---

## 14. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program overview and the `Task` vs `Mission` distinction: [`../README.md`](../README.md) §1, §1.1, §3
- Existing substrate: [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md)
- Task tracking as specified today: [`../../task-tracking/`](../../task-tracking/)
- Missions, Ideas and Works — the source side: [`../../missions-ideas-works/`](../../missions-ideas-works/)
- Schedules: [`../../schedules/spec.md`](../../schedules/spec.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
