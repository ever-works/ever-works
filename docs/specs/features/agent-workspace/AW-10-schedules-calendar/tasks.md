# AW-10 — Schedules, calendar and heartbeats · Task list

> Execute top to bottom. Every task names the files it creates or modifies and what "done" means.
> Behaviour is [spec.md](./spec.md); design decisions are [plan.md](./plan.md). Do not re-decide
> either here.

**Branch:** `feat/aw-10-schedules-calendar` (branch from `origin/develop`, never a stale local
`develop`).
**Commits:** conventional (`feat:`, `fix:`, `test:`, `chore:`), one logical change per commit.
**Phase gates:** P1, P2 and P3 each end at a green `pnpm lint && pnpm type-check && pnpm test`
plus the phase's end-to-end specs. Do not start the next phase on a red tree.

Legend: **P1** the workspace list · **P2** the standing definition and the calendar · **P3** bulk
safety.

---

## Phase P1 — The workspace list

### T1 · Entity columns for a reversible pause — **P1**

**Modify**

- `packages/agent/src/entities/task.entity.ts` — add `recurrencePausedAt` as a nullable
  `PortableDateColumn`, placed inside the existing recurrence block, with a doc comment stating
  that pausing preserves `recurrenceRule` / `recurrenceCron` / `nextOccurrenceAt` and every bound.
  Add `@Index('idx_tasks_recurrence_due_active', ['isRecurring', 'recurrencePausedAt',
  'nextOccurrenceAt'])` **beside** the existing `idx_tasks_recurrence_due` (do not replace it).
- `packages/agent/src/entities/agent.entity.ts` — add `heartbeatPausedAt` as a nullable
  `PortableDateColumn` in the `// ── Heartbeat ──` block, with a comment stating it is orthogonal
  to `AgentStatus`. Add `@Index('idx_agents_heartbeat_due', ['status', 'heartbeatPausedAt',
  'nextHeartbeatAt'])` beside the existing `idx_agents_next_heartbeat`.

**Done when** both entities compile, no existing column or index is altered, and
`pnpm --filter @ever-works/agent build` passes.

### T2 · Migration A — **P1**

**Create** `apps/api/src/migrations/<timestamp>-AddSchedulePauseColumns.ts`

Generate with `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts
src/migrations/AddSchedulePauseColumns`, then hand-edit to match the house style of
`apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts`:

- A header comment explaining that `NULL` on every existing row means "not paused", i.e. no
  behaviour changes on deploy.
- Existence guards (`hasColumn` / `hasIndex`) so a partially applied database converges.
- Portable `TableColumn` DDL — the e2e stack runs better-sqlite3, production runs Postgres.
- `down()` drops only the two columns and two indexes this migration added.

**Done when** the migration runs forward and backward against a scratch Postgres and a
better-sqlite3 database, and the API boots with `RUN_MIGRATIONS=true`.

### T3 · Dispatcher predicates honour the pause — **P1**

**Modify**

- `packages/agent/src/database/repositories/task.repository.ts` — `findDueRecurringTemplates`
  adds `recurrencePausedAt IS NULL` to its where clause.
- `packages/agent/src/agents/agent-schedule-dispatcher.service.ts` — `dispatchDue` adds
  `heartbeatPausedAt IS NULL` to its due-scan.

**Done when** a paused recurring template and a paused heartbeat are never returned by their
due-scan, and no other selection criterion changes.

### T4 · Health evaluation service — **P1**

**Create** `packages/agent/src/schedules/schedule-health.service.ts`

- `evaluate(row: ScheduleView, ctx): ScheduleHealth` returning `ok` or exactly one of the seven
  reasons in spec §4.6 FR-39.
- Satisfiability, not look-ahead: an unparseable expression, an impossible day/month pair
  (e.g. day 30 in a cadence restricted to February), a past end date, an exhausted occurrence cap,
  a past unclaimed one-shot, an unresolvable Agent, an archived owner. **A cadence that simply does
  not fire inside `computeNextCronFire`'s 31-day horizon is OK, never flagged** (FR-40).
- A paused row is never flagged (FR-41). Nor is a `mission_tick` whose Mission is
  `MissionStatus.COMPLETED` — that row is **Ended**, because finishing an initiative is a choice,
  not a defect in its cadence.
- `proposeRepair(row, health)` returns `{ class, before, after, beforeHash }` for the automatic
  repairs of FR-45; `choice` and `none` return no `after`.
- Reuse `parseCron` from `packages/agent/src/missions/cron-matcher.ts` and the RRULE helpers in
  `packages/agent/src/tasks-domain/recurrence.ts`. Add no new dependency.

**Done when** every reason is reachable from a fixture and the seven reasons are mutually exclusive.

### T5 · Control descriptor + agent attribution on the projection — **P1**

**Modify**

- `packages/agent/src/schedules/schedule-view.types.ts` — add `ScheduleHealthReason`,
  `ScheduleRepairClass`, `ScheduleHealth`, `ScheduleControls`, `ScheduleOccurrence`,
  `SchedulePage`, and the additive `ScheduleView` fields listed in plan §3.5. Add nothing that
  changes or removes an existing field.
- **Create** `packages/agent/src/schedules/schedule-controls.ts` — a pure function mapping a
  source type + row state to the six-control descriptor with a `disabledReasons` key per false
  control.
- `packages/agent/src/schedules/schedules.service.ts` — populate `agentId` / `agentName` for
  `recurring_task` (from assignees then `task.agentId`) and `agent_heartbeat`, attach `health` and
  `controls`, and expose `pausedAt`. Keep the seven per-source try/catch blocks and the existing
  bare-array return of `getSchedules`.
- `packages/agent/src/schedules/index.ts` — export the new symbols.

**Done when** `GET /api/schedules` returns the same JSON keys it did before plus the new ones, and
`apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.ts` `getSoonRuns()` still compiles
and still works.

### T6 · Paged read — **P1**

**Modify** `packages/agent/src/schedules/schedules.service.ts` — add
`getPage(scope, filters, cursor, limit)` returning `SchedulePage`, with an opaque base64
`{nextRunAt, id}` cursor, `total`, `countsBySourceType`, `healthCounts`, `degradedSources` and
`healthCheckedAt`. Sorting is next fire ascending, nulls last, then name ascending.

**Create** `apps/api/src/schedules/dto/schedules-page-query.dto.ts` — the DTO of plan §4.2, with
`forbidNonWhitelisted` mirroring `apps/api/src/schedules/dto/schedules-query.dto.ts`.

**Modify** `apps/api/src/schedules/schedules.controller.ts` — add `GET /api/schedules/page`,
declared **above** any `:id` route.

**Done when** paging returns every row exactly once across pages, an unknown query param is
rejected with `400`, and a foreign row is unreachable.

### T7 · Health read endpoint — **P1**

**Modify** `apps/api/src/schedules/schedules.controller.ts` — add `GET /api/schedules/health`
returning `{ checkedAt, counts, flagged }` as a dry run, capped at 200 flagged rows, with the exact
`before` / `after` / `beforeHash` a repair would use.

**Done when** the response is side-effect free and a workspace with no flagged rows returns
`counts.neverRuns === 0` with an empty `flagged`.

### T8 · Schedule id pipe — **P1**

**Create** `apps/api/src/schedules/pipes/parse-schedule-id.pipe.ts`

Validates `${sourceType}:${ownerId}` — source type against the closed union, owner id against a
UUID pattern — and throws `400` otherwise. Never use `ParseUUIDPipe` on a schedule id.

**Create** `apps/api/src/schedules/pipes/parse-schedule-id.pipe.spec.ts` covering a valid id, an
unknown source type, a non-UUID owner, a missing colon, and an id with two colons.

**Done when** every malformed shape is rejected before any repository call.

### T9 · Control service — **P1**

**Create** `packages/agent/src/schedules/schedule-control.service.ts`

- `runNow(scope, id)`, `pause(scope, id, opts)`, `resume(scope, id)`.
- Resolves the synthetic id, then calls the **owning domain service** — `TasksService`,
  `AgentsService`, `MissionsService`, the Work schedule service, the inbound-trigger service — so
  every existing ownership check, throttle and activity emission is inherited. It must not write an
  owning table directly.
- `pause` on `mission_tick` throws `MISSION_PAUSE_NOT_ACKNOWLEDGED` unless
  `acknowledgeMissionPause` is set; with it, it calls `MissionsService.pause`, which writes
  `MissionStatus.PAUSED` and stops the tick raising new Ideas. Ideas and Works already raised are
  left alone — do not cancel or withdraw anything.
- `runNow` on `mission_tick` delegates to `MissionsService.runNow` (behind
  `POST /api/me/missions/:id/run-now`), which runs one tick and raises Ideas. It produces no
  `AgentRun`, so the result carries a Mission link and the tick outcome instead of a `runId`
  (spec FR-14) — do not fabricate a Run id for it.
- `runNow` never mutates `nextOccurrenceAt` or `nextHeartbeatAt`.
- Refusal codes: `SCHEDULE_ALREADY_RUNNING`, `SCHEDULE_NO_AGENT`, `SCHEDULE_OWNER_ARCHIVED`,
  `SCHEDULE_CREDITS_EXHAUSTED`.

**Done when** each of the seven source types either performs the control or reports the reason its
descriptor already declared.

### T10 · Recurring-template run-now endpoint — **P1**

**Modify**

- `packages/agent/src/tasks-domain/tasks.service.ts` — add `runRecurringNow(userId, taskId, scope)`
  which clones an instance via `cloneRecurringTaskAsInstance`
  (`packages/agent/src/tasks-domain/recurrence.ts`) and dispatches through the same gated path
  `TaskRecurrenceDispatcherService.dispatchInstance` uses, i.e. via
  `AGENT_TASK_EXECUTE_DISPATCHER` from `packages/agent/src/tasks-domain/task-dispatcher.ts`.
  It must not advance `nextOccurrenceAt`.
- `apps/api/src/tasks/tasks.controller.ts` — add `POST /api/tasks/:id/recurring/run-now`,
  `@Throttle({ long: { limit: 10, ttl: 60_000 } })`, declared beside the existing
  `POST :id/recurring`.

**Done when** a manual fire produces one Run and the template's next scheduled fire is byte-identical
before and after.

### T11 · Heartbeat pause endpoints — **P1**

**Modify**

- `packages/agent/src/agents/…` service that owns Agent writes — add `pauseHeartbeat` /
  `resumeHeartbeat` writing only `heartbeatPausedAt`.
- `apps/api/src/agents/agents.controller.ts` — add `POST /api/agents/:id/heartbeat/pause` and
  `POST /api/agents/:id/heartbeat/resume`, `@Throttle({ long: { limit: 30, ttl: 60_000 } })`.

**Done when** pausing a heartbeat leaves `AgentStatus` and `heartbeatCadence` untouched and does not
affect that Agent's assigned Task dispatch.

### T12 · Per-schedule control endpoints — **P1**

**Modify** `apps/api/src/schedules/schedules.controller.ts` — add
`POST /api/schedules/:id/run-now`, `/pause`, `/resume`, all using `ParseScheduleIdPipe`, all
returning `404` (never `403`) for a foreign or missing id. `run-now` is throttled `10/min`.

**Modify** `apps/api/src/schedules/schedules.module.ts` — provide the new services and import the
modules whose services are delegated to.

**Done when** the three controls work for every source type that declares them and every other
combination returns its documented `409`.

### T13 · Web route, sidebar entry and shell — **P1**

**Create**

- `apps/web/src/app/[locale]/(dashboard)/schedules/page.tsx` — RSC entry, server-fetches the first
  page and the health summary, degrading each independently.
- `apps/web/src/app/[locale]/(dashboard)/schedules/schedules-client.tsx` — the client shell.
- `apps/web/src/components/schedules/SchedulesShell.tsx`.

**Modify**

- `apps/web/src/lib/constants.ts` — add `DASHBOARD_SCHEDULES: '/schedules'` beside
  `DASHBOARD_ACTIVITY`.
- `apps/web/src/components/dashboard/DashboardSidebar.tsx` — add the entry after
  `navigation.tasks`, using `t('navigation.schedules')` and the `CalendarClock` icon.
- `apps/web/src/app/[locale]/(dashboard)/activity/activity-client.tsx` — add a single "Open
  Schedules" link above the existing `<SchedulesList />` mount. **Do not** remove the tab, the
  component, or the `?view=schedules` behaviour.

**Done when** `/schedules` renders, the sidebar highlights it, and `/activity?view=schedules` is
unchanged apart from the new link.

### T14 · List view components — **P1**

**Create** under `apps/web/src/components/schedules/`:
`SchedulesListView.tsx`, `ScheduleRow.tsx`, `ScheduleCountdown.tsx`, `ScheduleHealthBadge.tsx`,
`ScheduleHealthBanner.tsx`, `ScheduleRowMenu.tsx`, `SchedulesFilters.tsx`,
`SchedulesEmptyState.tsx`, `SchedulesDegradedNotice.tsx`.

Requirements: the wireframes and copy of spec §6.1–§6.5; countdown ticks each second but announces
politely at most once a minute; disabled row-menu entries keep their position and carry their
reason; filters are URL-synced; the banner dismisses for the session via `sessionStorage`. The row
menu's owner entry names what it opens per source (`openTask` / `openAgent` / `openMission` /
`openWork`); a `mission_tick` row offers the Ideas it raised rather than past runs, because a tick
produces no Run.

**Done when** every state in spec §6.1–§6.5 is reachable and no literal English string remains in
the components.

### T15 · Web data plumbing — **P1**

**Modify**

- `apps/web/src/lib/api/schedules.ts` — mirror the new row fields locally (the convention that file
  documents), and add `getPage`, `getHealth`, `runNow`, `pause`, `resume`.
- `apps/web/src/app/actions/dashboard/schedules.ts` — add `getSchedulePage`, `getScheduleHealth`,
  `runScheduleNow`, `pauseSchedule`, `resumeSchedule`, each `revalidatePath(ROUTES.DASHBOARD_SCHEDULES)`
  on success.

**Done when** the shell renders entirely through server actions, with no new BFF route handler, and
`import 'server-only'` is preserved in the API client.

### T16 · i18n for P1 — **P1**

**Modify** `apps/web/messages/en.json` — extend the existing `dashboard.schedules` block (begins
~line 2632) with the P1 subset of plan §8: `pageSubtitle`, `views`, `summaryLine`, `timezoneNote`,
`neverRunYet`, `loadMore`, `showingRange`, the extended `columns` and `filters`, `actions`,
`health.*`, `runNow.*`, `missionPause.*` (including `alreadyRaisedNote`), `degraded.*`, `errors.*`,
`keyboard.*`. `actions` carries all four owner-entry labels — `openTask`, `openAgent`,
`openMission`, `openWork` — plus `seePastRuns` and `seeIdeasRaised`. Also add
`dashboard.sidebar.navigation.schedules` and `metadata.pages.schedules`.

**Modify** the 20 sibling locale files in `apps/web/messages/` with the same key tree.

**Rules:** leaf key names are camelCase and must never contain a literal `.` — a dot in a leaf name
breaks next-intl at runtime and reds the hydration e2e shards. Nothing existing is renamed.

**Done when** `pnpm --filter web lint` passes and no component calls a missing key.

### T17 · P1 unit tests — **P1**

**Create**

- `packages/agent/src/schedules/__tests__/schedule-health.spec.ts`
- `packages/agent/src/schedules/__tests__/schedule-controls.spec.ts`
- `packages/agent/src/tasks-domain/__tests__/task-recurrence-pause.spec.ts`
- `packages/agent/src/agents/__tests__/heartbeat-pause.spec.ts`

**Modify**

- `packages/agent/src/schedules/__tests__/schedules.service.spec.ts` — cursor paging, the new
  filters, `degradedSources`, and an explicit assertion that `getSchedules` still returns a bare
  array with its original keys.

**Must cover:** all seven health reasons; a yearly cron and a 29-February cron are **not** flagged;
a paused row is not flagged; a `mission_tick` whose Mission is `COMPLETED` renders **Ended** rather
than NEVER RUNS; paused templates and paused heartbeats are excluded from their
due-scans while every other selection criterion is unchanged.

**Done when** `cd packages/agent && pnpm test` is green.

### T18 · P1 controller specs — **P1**

**Create**

- `apps/api/src/schedules/schedules.controller.page.spec.ts`
- `apps/api/src/schedules/schedules.controller.controls.spec.ts`
- `apps/api/src/schedules/schedules.controller.health.spec.ts`
- `apps/api/src/tasks/tasks.controller.recurring-controls.spec.ts`
- `apps/api/src/agents/agents.controller.heartbeat-pause.spec.ts`

**Modify**

- `apps/api/src/schedules/schedules.controller.spec.ts` — assert the unchanged shape of
  `GET /api/schedules`.
- `apps/api/src/schedules/dto/schedules-query.dto.spec.ts` — cover the new page DTO.

**Must cover:** scope isolation, 404-never-403, unknown-param rejection, every `409` code, run-now
throttling, the Mission-pause acknowledgement gate, and that run-now on a `mission_tick` returns the
Mission link and tick outcome with **no** `runId`.

**Done when** `cd apps/api && pnpm test` is green.

### T19 · P1 web unit tests — **P1**

**Create**

- `apps/web/src/components/schedules/ScheduleHealthBadge.unit.spec.tsx`
- `apps/web/src/components/schedules/ScheduleRowMenu.unit.spec.tsx`

**Done when** the badge conveys health in text as well as colour and disabled menu entries keep
their position with their reason.

### T20 · P1 end-to-end — **P1**

**Create**

- `apps/web/e2e/flow-schedules-workspace-list.spec.ts`
- `apps/web/e2e/flow-schedules-pause-preserves-cadence.spec.ts`

**Verify unchanged:** `apps/web/e2e/flow-schedules-list-projection-2.spec.ts`,
`flow-schedules-ui-journey.spec.ts`, `flow-schedules-validation-matrix.spec.ts`,
`flow-schedules-view-deep.spec.ts`, `cron-schedules.spec.ts`,
`flow-agent-heartbeat-dispatch-lifecycle.spec.ts`.

**Done when** the new specs pass and none of the existing ones needed editing.

### T21 · P1 gate — **P1**

Run from the repo root: `pnpm lint`, `pnpm type-check`, `pnpm test`, then the Playwright specs of
T20. Open the PR against `develop`, poll the automated reviewers, fix every P2-or-higher finding on
the same branch, and repeat until clean. Include the full PR URL in the hand-off.

**Done when** CI is green and the PR is merged; delete the branch on merge unless P2 continues on it.

---

## Phase P2 — The standing definition and the calendar

### T22 · Option, telemetry and health columns — **P2**

**Modify** `packages/agent/src/entities/task.entity.ts` — add `recurrenceProviderId`,
`recurrenceModelId`, `recurrenceTimeoutSeconds`, `recurrenceAnnounce` (default `true`),
`recurrenceHideInstances` (default `false`), `recurrenceFailureStreak` (default `0`),
`recurrenceHealth`, `recurrenceHealthCheckedAt`, `recurrenceLastFiredAt`, exactly as plan §3.1.
Add `@Index('idx_tasks_recurrence_health', ['userId', 'recurrenceHealth'])`.

**Done when** the entity compiles and every new column is nullable or defaulted to today's
behaviour.

### T23 · Migration B — **P2**

**Create** `apps/api/src/migrations/<timestamp>-AddScheduleDefinitionOptions.ts` — the nine columns
and the health index, same style rules as T2, header comment stating that the defaults reproduce
current behaviour for every existing row.

**Done when** forward and backward runs are clean on both dialects.

### T24 · Option resolution and validation — **P2**

**Create** `packages/agent/src/schedules/schedule-options.ts`

- `resolveTimeout(task, agent, config)` → `{ seconds, source: 'schedule' | 'agent' | 'deployment' }`,
  reading the deployment default from `packages/agent/src/config/index.ts`
  (`agents.getMaxRunDurationSeconds()`, default 1800) and the Agent override added by AW-09.
- `resolveModel(task, agent)` → `{ providerId, modelId, source }`, resolved through the AI facade
  cascade. No plugin id is named in this file.
- `defaultAnnounceFor(cadence)` → `true` when the cadence fires **7 or fewer times per week**, else
  `false` (spec FR-29).
- `validateCadenceFloor(cadence)` → refuses under 5 minutes, warns between 5 and 15 minutes with
  the computed fires-per-day.

**Done when** each helper is pure and unit-testable with no repository access.

### T25 · Schedule caps — **P2**

**Modify** `packages/agent/src/tasks-domain/tasks.service.ts` — before creating or converting a
Task into a recurring template, refuse above **50** per Agent or **500** per workspace with
`SCHEDULE_AGENT_CAP` / `SCHEDULE_WORKSPACE_CAP` and the current count in the message.

**Done when** the refusal happens before any write and the counts are accurate under an active
Organization scope.

### T26 · Edit, duplicate and reassign — **P2**

**Modify**

- `packages/agent/src/schedules/schedule-control.service.ts` — add `update`, `duplicate`,
  `reassign`. Duplicate copies instructions, cadence and options, names the copy `<name> (copy)`,
  copies **no** run history, and sets `recurrencePausedAt = now()` so it starts paused (spec FR-20).
  Reassign rewrites the Agent binding and assignee rows, leaves `nextOccurrenceAt` alone, and
  refuses an archived Agent with `AGENT_ARCHIVED`.
- `apps/api/src/schedules/schedules.controller.ts` — add `PATCH /api/schedules/:id`,
  `POST /api/schedules/:id/duplicate`, `POST /api/schedules/:id/reassign`. All three are
  `recurring_task` only; every other source returns `409 SCHEDULE_NOT_EDITABLE` /
  `SCHEDULE_NOT_DUPLICABLE` / `SCHEDULE_NOT_REASSIGNABLE`.
- `apps/api/src/tasks/tasks.dto.ts` — add the five optional option fields to `UpdateTaskDto` with
  `@Min(60) @Max(14400)` on the timeout and `@IsBoolean()` on the two flags.

**Done when** each control writes exactly one activity row with actor, control and before/after.

### T27 · Announcements, failure streak and auto-pause — **P2**

**Modify** `packages/agent/src/agents/agent-run-post-processor.ts` — for a Run whose Task is a
recurring instance:

- stamp `recurrenceLastFiredAt` on the template;
- on success, reset `recurrenceFailureStreak` to 0; on failure, increment it;
- announce on completion when `recurrenceAnnounce` is true, and announce on failure regardless once
  the streak reaches **2** (spec FR-69);
- roll announcements up hourly above **20 per Schedule per day** (FR-70);
- auto-pause at a streak of **5**, writing `recurrencePausedAt` and `schedule_auto_paused`, and
  notify regardless of the announce setting (FR-71).

Announcements go through `packages/agent/src/activity-log/activity-log.service.ts` and
`packages/agent/src/notifications/notification.service.ts` with the deterministic idempotency key
`sched-announce:{taskId}:{runId}`.

**Modify** `packages/agent/src/entities/activity-log.types.ts` — append the nine action types of
plan §3.4. Append only; reorder nothing. No migration is required (`actionType` is a free varchar).

**Done when** a retried terminal transition cannot double-post and resuming resets the streak.

### T28 · Occurrence expansion and Run matching — **P2**

**Create** `packages/agent/src/schedules/schedule-occurrence.service.ts`

- `expand(rows, from, to)` — cron via `parseCron`, RRULE via the `rrule` helpers, interval sources
  arithmetically. Caps: **500** occurrences per Schedule, **2 000** per request, reporting
  truncation per Schedule.
- `matchRuns(occurrences, runs, sourceRecords)` — for a source that dispatches a Run
  (`recurring_task`, `agent_heartbeat`), a Run matches when it started within **±10 minutes** of the
  expected instant, and the occurrence resolves with `evidence: 'run'`. Unmatched past occurrences
  are `did-not-run` with a reason where known (`pausedAtTheTime`, `noAgent`); occurrences older than
  the Run retention floor are `unknown`, never `did-not-run` (spec FR-63).
- **A source that produces no Run is resolved from its own record, not from a missing Run.** A
  `mission_tick` raises Ideas and writes an `ActivityActionType.MISSION_TICK` row; match that row in
  the same ±10 minute window and emit `evidence: 'sourceRecord'` with the Mission's `ownerLink` and
  no `runId` / `durationMs` / `costCents`. With no such row the outcome is `unknown`. Emitting
  `did-not-run` for a Mission tick because no `AgentRun` exists is a bug, not a default (spec
  FR-62). The same applies to `work_schedule`, `source_validation` and `data_sync`, which carry
  their own `lastRun*` columns.
- Occurrences of a paused Schedule are emitted with outcome `paused`, not dropped (FR-60).

**Done when** the service is pure over injected rows and Runs, with no repository access of its own.

### T29 · Calendar endpoint — **P2**

**Create** `apps/api/src/schedules/dto/schedules-calendar-query.dto.ts` — `from` / `to` required,
range ≤ **92 days** else `400 CALENDAR_RANGE_TOO_WIDE`, plus the same narrowing params as `/page`.

**Modify** `apps/api/src/schedules/schedules.controller.ts` — add `GET /api/schedules/calendar`
returning `{ from, to, generatedAt, occurrences, truncated }`, declared above the `:id` routes.

**Done when** an over-wide range is refused before any expansion work and `generatedAt` is present
on every response.

### T30 · Heartbeat overlap detection — **P2**

**Create** `packages/agent/src/schedules/heartbeat-overlap.service.ts`

- **Coincidence:** expand the Agent's heartbeat and each of its Schedules over 7 days and count
  same-minute fires; warn at **2 or more**.
- **Duty overlap:** normalised significant-term comparison between the Schedule's instructions and
  the Agent's heartbeat instructions — lowercase, tokens of 4+ characters, stop-words removed,
  capped at 200 terms per side, Jaccard ≥ **0.35**. This follows the deterministic term-overlap
  approach already used by the Task decision-conflict check; no model is consulted.
- **Tight heartbeat:** flag a heartbeat under **15 minutes** on an Agent owning ≥ 1 enabled
  Schedule.

**Modify** `apps/api/src/agents/agents.controller.ts` — add
`GET /api/agents/:id/schedule-overlaps`, read-only.

**Done when** the thresholds are exactly at the boundaries in spec FR-35–FR-38 and nothing blocks a
save.

### T31 · Health sweep background task — **P2**

**Create** `packages/tasks/src/tasks/trigger/schedule-health-sweep.task.ts` — a `schedules.task`
with cron `17 6 * * *`, booting a transient `NestApplicationContext(TriggerInternalModule)` and
closing it, matching the shape of every sibling task in that folder.

**Modify**

- `packages/tasks/src/tasks/trigger/index.ts` — export it.
- `packages/agent/src/schedules/schedule-health.service.ts` — add `sweep()`: recompute
  `recurrenceHealth` / `recurrenceHealthCheckedAt` for every recurring template, raise at most **one**
  notification per user per day naming newly flagged Schedules, and delete `schedule_bulk_actions`
  rows older than **30 days** (a no-op until P3 creates the table).

**Rules:** registration is through the configured job-runtime provider only. Do not import a
third-party job-runtime SDK inside `packages/agent`.

**Done when** the sweep is idempotent, and the surface reports staleness rather than presenting an
old verdict as current when the sweep has not run for 48 hours.

### T32 · Editor components — **P2**

**Create** under `apps/web/src/components/schedules/`:
`ScheduleEditorDialog.tsx`, `GuidedInstructionForm.tsx`, `CadencePicker.tsx`,
`ScheduleOptionsPanel.tsx`, `ReassignDialog.tsx`, `OverlapWarning.tsx`.

Requirements: spec §6.10, §6.11, §6.16, §6.17. The guided form is on by default for a user's first
three Schedules (counter in `localStorage`), always dismissible, and `Edit as text` must never lose
what was typed. The cadence picker shows the next three fires and both UTC and local time. The
options panel labels which level supplied each inherited value. The overlap warning snoozes per
pair for 30 days in `localStorage` and returns if either side is edited.

**Done when** every refusal string in spec §6.10 is reachable and no save is ever blocked by an
overlap warning.

### T33 · Calendar components — **P2**

**Create** `apps/web/src/components/schedules/SchedulesCalendarView.tsx` and
`OccurrenceChip.tsx`.

Requirements: spec §6.6–§6.9. The grid is a semantic table with row and column headers; each chip's
accessible name reads "{schedule}, {expected time}, {outcome}"; a past chip links to the Run receipt
when `evidence === 'run'` and to the occurrence's `ownerLink` otherwise — a `mission_tick` chip opens
the Mission and never offers a receipt; over-limit copy is rendered per Schedule; filters are shared
with the List view; an over-wide range snaps back without losing filters.

**Done when** all six occurrence outcomes render with a text marker as well as a colour.

### T34 · P2 web plumbing — **P2**

**Modify** `apps/web/src/lib/api/schedules.ts` and
`apps/web/src/app/actions/dashboard/schedules.ts` — add `getScheduleCalendar`, `updateSchedule`,
`duplicateSchedule`, `reassignSchedule`, and the overlap read.

**Done when** mutations revalidate `/schedules` and only `pause` / `resume` are optimistic.

### T35 · i18n for P2 — **P2**

**Modify** `apps/web/messages/en.json` plus the 20 sibling locales — add the `editor.*`,
`overlap.*`, `calendar.*`, `duplicate.*`, `reassign.*`, `announce.*`, `autoPause.*` sub-trees from
plan §8. Same rules as T16: camelCase leaves, no literal dot, nothing renamed.

**Done when** the editor and calendar contain no literal English string.

### T36 · P2 unit tests — **P2**

**Create**

- `packages/agent/src/schedules/__tests__/schedule-occurrence.spec.ts`
- `packages/agent/src/schedules/__tests__/heartbeat-overlap.spec.ts`
- `packages/agent/src/schedules/__tests__/schedule-options.spec.ts`
- `packages/agent/src/agents/__tests__/schedule-announce.spec.ts`

**Modify** `packages/agent/src/schedules/__tests__/cadence.spec.ts` — the next-three-fires helper.

**Must cover:** the 500/2 000 caps; ±10 minute matching and the `unknown` retention rule; a
`mission_tick` occurrence resolved from its `MISSION_TICK` activity row, and reading `unknown` —
never `did-not-run` — when no such row exists; paused
occurrences emitted, not dropped; coincidence at exactly 1 vs 2 fires; duty score at 0.34 vs 0.35;
announce defaults at exactly 7 vs 8 fires per week; forced failure announcement on the second
consecutive failure; auto-pause at exactly 5; streak reset on resume; idempotency key preventing a
double post.

### T37 · P2 controller specs — **P2**

**Create**

- `apps/api/src/schedules/schedules.controller.calendar.spec.ts` — including that a `mission_tick`
  occurrence returns `evidence: 'sourceRecord'` with an `ownerLink` and no `runId`, and `unknown`
  rather than `did-not-run` when the tick record is absent.
- extend `apps/api/src/schedules/schedules.controller.controls.spec.ts` for edit / duplicate /
  reassign, including every `409`.
- extend `apps/api/src/agents/agents.controller.heartbeat-pause.spec.ts` for
  `GET /api/agents/:id/schedule-overlaps`.
- extend `apps/api/src/tasks/tasks.controller.recurring-controls.spec.ts` for the new option fields
  and their bounds.

### T38 · P2 web unit tests — **P2**

**Create**

- `apps/web/src/components/schedules/CadencePicker.unit.spec.tsx`
- `apps/web/src/components/schedules/GuidedInstructionForm.unit.spec.tsx`
- `apps/web/src/components/schedules/OccurrenceChip.unit.spec.tsx`

### T39 · P2 end-to-end — **P2**

**Create**

- `apps/web/e2e/flow-schedules-standing-definition.spec.ts`
- `apps/web/e2e/flow-schedules-calendar.spec.ts`
- `apps/web/e2e/flow-schedules-duplicate-reassign.spec.ts`
- `apps/web/e2e/flow-agent-heartbeat-overlap.spec.ts`

### T40 · P2 gate — **P2**

Same gate as T21. Ship P2 only on a green tree, and include the PR URL in the hand-off.

---

## Phase P3 — Bulk safety

### T41 · Bulk-action entity — **P3**

**Create** `packages/agent/src/entities/schedule-bulk-action.entity.ts` — table
`schedule_bulk_actions`, columns exactly as plan §3.3, with
`@Index('idx_schedule_bulk_actions_user_created', ['userId', 'createdAt'])`. `entries` is
`simple-json` and must never contain instruction text or anything marked secret.

**Modify**

- `packages/agent/src/entities/index.ts` — export it.
- `packages/agent/src/database/_entities-inventory.ts` — import and register it.
- `packages/agent/src/database/_entity-names.ts` — add `'ScheduleBulkAction'`.

**Done when** the entity is discovered by the datasource in both dialects.

### T42 · Migration C — **P3**

**Create** `apps/api/src/migrations/<timestamp>-CreateScheduleBulkActions.ts` — the table and its
index, same style rules as T2. `down()` drops only this table.

### T43 · Bulk-action service — **P3**

**Create** `packages/agent/src/schedules/schedule-bulk-action.service.ts`

- `record(kind, scopeKind, entries)` — caps `entries` at **500**, denormalises `entryCount`, stamps
  `userId` / `tenantId` / `organizationId` from the acting scope.
- `undo(bulkActionId, scope)` — refuses beyond **15 minutes** of `createdAt`
  (`UNDO_WINDOW_CLOSED`) and when `undoneAt` is already set (`ALREADY_UNDONE`); restores each entry
  only if its current state still matches the recorded `after`, otherwise skips it and increments
  `undoSkipped`; returns `{ restored, skipped, skippedReasons }`.
- `prune(olderThanDays = 30)` — called by the health sweep.

**Done when** a batch is undoable exactly once and a teammate's later edit is never overwritten.

### T44 · Fix-all endpoint — **P3**

**Modify**

- `packages/agent/src/schedules/schedule-health.service.ts` — add
  `applyRepairs(scope, ids, expectedHashes)`: automatic repairs only, capped at **200**, skipping
  any Schedule whose current before-state no longer hashes to what was previewed, and recording one
  `fix` bulk action.
- `apps/api/src/schedules/schedules.controller.ts` — add `POST /api/schedules/health/fix`
  (`@Throttle` 10/min) and `POST /api/schedules/bulk/:bulkActionId/undo` (`ParseUUIDPipe` — this id
  **is** a UUID, unlike a schedule id).

**Done when** nothing is written for a `choice` or `none` repair class and every skip is reported
with its reason.

### T45 · Circuit-breaker endpoint — **P3**

**Modify**

- `packages/agent/src/schedules/schedule-control.service.ts` — add
  `disableAll(scope, { scopeKind, agentId })`: counts first, refuses above **500** with
  `SCHEDULE_SCOPE_TOO_LARGE` before any write, pauses each Schedule through its owning domain
  service, includes the Agent's heartbeat for `agent` scope and inbound Triggers for `workspace`
  scope, records one `pause` bulk action, and reports the in-flight Run count without cancelling
  anything.
- `apps/api/src/schedules/schedules.controller.ts` — add `POST /api/schedules/disable-all`
  (`@Throttle` 5/min), requiring `confirm: 'PAUSE'` for `workspace` scope.

**Done when** nothing is deleted, every cadence survives, and one activity row is written for the
batch rather than one per Schedule.

### T46 · Bulk UI — **P3**

**Create** under `apps/web/src/components/schedules/`:
`FixAllDialog.tsx`, `DisableAllDialog.tsx`, `BreakerUndoBanner.tsx`, `SchedulesBulkBar.tsx`.

Requirements: spec §6.12–§6.15. The fix dialog holds the `beforeHash` values it was given and sends
them back on apply — it never recomputes them client-side. The workspace breaker's confirm stays
disabled until the typed word matches exactly. The undo banner shows the minutes remaining and is
visible on both views. The bulk bar caps selection at **100** rows.

**Done when** every over-limit, race and closed-window string in spec §6.12–§6.15 is reachable.

### T47 · P3 web plumbing and i18n — **P3**

**Modify** `apps/web/src/lib/api/schedules.ts` and
`apps/web/src/app/actions/dashboard/schedules.ts` — add `fixSchedules`, `disableAllSchedules`,
`undoScheduleBulkAction`, plus bulk pause/resume.

**Modify** `apps/web/messages/en.json` and the 20 sibling locales — add the `fix.*` and `breaker.*`
sub-trees from plan §8. Same rules as T16.

### T48 · P3 unit and controller tests — **P3**

**Create**

- `packages/agent/src/schedules/__tests__/schedule-bulk-action.service.spec.ts`
- `packages/agent/src/schedules/__tests__/schedule-repair.spec.ts`
- `apps/api/src/schedules/schedules.controller.breaker.spec.ts`
- extend `apps/api/src/schedules/schedules.controller.health.spec.ts` for the apply and undo paths.

**Must cover:** the 15-minute window on both sides of the boundary; single-undo enforcement;
per-entry skip on changed state; the 200-repair and 500-pause caps refusing before any write; the
typed-confirm requirement; February clamping to 28; a past one-shot moving at least 5 minutes into
the future.

### T49 · P3 web unit tests — **P3**

**Create**

- `apps/web/src/components/schedules/DisableAllDialog.unit.spec.tsx`
- `apps/web/src/components/schedules/FixAllDialog.unit.spec.tsx`

### T50 · P3 end-to-end — **P3**

**Create**

- `apps/web/e2e/flow-schedules-never-runs-fix.spec.ts`
- `apps/web/e2e/flow-schedules-circuit-breaker.spec.ts`
- `apps/web/e2e/flow-schedules-a11y.spec.ts` — axe on both views plus keyboard traversal of
  spec §6.21.

### T51 · P3 gate — **P3**

Same gate as T21.

---

## Cross-cutting closing tasks

### T52 · Documentation — **P3**

**Modify**

- `docs/specs/features/agent-workspace/TRACKER.md` — set AW-10's Spec column to `Draft` when this
  folder merges, then update the Impl column per phase with the branch and PR.
- `docs/specs/features/schedules/spec.md` §11 — mark open questions 3 (run-now for recurring
  templates) and 4 (pagination) as answered by this epic, linking here. Do not rewrite that spec.

**Done when** neither document contradicts this epic and no third place claims to own the schedule
read model.

### T53 · Verification pass against the acceptance criteria — **P3**

Walk spec §8 top to bottom against a seeded workspace containing: one recurring Schedule per
cadence style, one paused Schedule, one auto-paused Schedule, one Schedule per NEVER RUNS reason, an
Agent with a tight overlapping heartbeat, one Work schedule, one Mission tick, one source-validation
check, one data-sync poll and one inbound Trigger.

**Done when** every checkbox in spec §8 is ticked or has an open issue linked beside it.
