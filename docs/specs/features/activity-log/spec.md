# Feature Specification: Activity Log

**Feature ID**: `activity-log`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The activity log is the platform's per-user audit trail. Every notable
user action (work created/updated/deleted, generation started or
completed, deployment dispatched, plugin enabled, member invited,
schedule changed, taxonomy mutated, etc.) is recorded as a row in the
`activity_log` table. Users can list, filter, summarise, and export
their own log via authenticated REST endpoints, and a subset of events
fan out to optional external analytics (Jitsu) without blocking the
write path. The log is **owner-facing** — it documents what _the
account holder_ did across their own works — and is distinct from
[`notifications`](../notifications/spec.md), which surface
service-side anomalies to the same user.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I created a new work earlier today, **when** I open the
  Activity tab, **then** I see a `Created work: <name>` row with
  `status=completed` newest-first.
- **Given** a generation is currently running for one of my works,
  **when** I open the Activity tab, **then** I see the matching
  `generation` row with `status=in_progress` and the running-count
  badge in the sidebar reflects the number of in-progress entries.
- **Given** the AI generation finishes, **when** the
  `WorkGenerationCompletedEvent` fires, **then** the same in-progress
  row is updated in place to `completed`/`failed`/`cancelled` (no new
  row is created) with item counts attached to `details`.
- **Given** I want a single row's full payload, **when** I `GET
  /api/activity-log/:id` and the row is `in_progress` for an active
  generation, **then** the response is enriched with `recentLogs` from
  the live `work.generateStatus` so I can read the latest pipeline
  output without polling another endpoint.
- **Given** I want a CSV of last week's activity, **when** I `GET
  /api/activity-log/export?dateFrom=…&dateTo=…`, **then** I receive
  `text/csv` with `attachment; filename=activity-log.csv` and one row
  per matching entry.
- **Given** Jitsu is configured (`JITSU_HOST` + `JITSU_WRITE_KEY`
  present), **when** any activity row is logged or its status updated,
  **then** the row is forwarded to Jitsu via `track(action, {…})`
  out-of-band and any dispatch failure is logged-and-swallowed.

### 2.2 Edge cases & failures

- **Given** I request `limit=500`, **when** the list endpoint runs,
  **then** the limit is clamped via `Math.min(limit, 100)` and at most
  100 rows are returned.
- **Given** a previous generation's `in_progress` row was orphaned
  (the work moved to `ERROR` / `CANCELLED` / `IDLE` without a
  `WorkGenerationCompletedEvent` firing), **when** I open _any_
  activity-log endpoint, **then** the controller's
  `reconcileActivities(userId)` first walks every in-progress
  generation row, looks up the matching work, and rewrites the row to
  the actual terminal status before serving the request — so I never
  see a permanently-stuck `in_progress` row in the UI.
- **Given** two parallel requests arrive for the same user within the
  reconcile TTL window (5 seconds), **when** the second one runs,
  **then** it awaits the first request's reconcile promise (or skips
  via the recently-completed cache) instead of starting a duplicate
  reconcile pass.
- **Given** an activity row references a workId that has since been
  deleted, **when** the work is deleted, **then** TypeORM's `ON DELETE
  SET NULL` on `workId` keeps the activity row in place with a null
  workId rather than cascade-deleting audit history.
- **Given** the analytics dispatcher is not bound (no Jitsu env vars),
  **when** an activity is logged, **then** the row is still persisted
  and the dispatcher branch is a silent no-op.
- **Given** the analytics dispatcher rejects (network failure,
  malformed payload), **when** the dispatcher's `track(...)` promise
  rejects, **then** the failure is `logger.warn`-ed and the request
  proceeds — analytics MUST NOT block the audit write.
- **Given** I supply a CSV-export filter that captures more than
  10 000 rows, **when** the export runs, **then** the result is
  truncated to 10 000 rows (the first page of the underlying
  `findByUserIdForExport` query) — there is no streaming export today.
- **Given** an event listener throws while writing the activity row
  (e.g. transient DB error), **when** the listener catches the error,
  **then** it is logged via `logger.error` and the originating event
  is **not** re-thrown — losing one audit row must not break the
  upstream domain operation.

## 3. Functional Requirements

- **FR-1** Each `activity_log` row MUST belong to a single `userId`
  and carry a non-null `actionType` (one of the
  [`ActivityActionType`](#5-key-entities--domain-concepts) values),
  `action` (free-form dotted string, e.g. `work.created`,
  `generation.completed`, `work.plugin_enabled`), `status` (one of
  `pending` / `in_progress` / `completed` / `failed` / `cancelled`),
  and a human-readable `summary`.
- **FR-2** A row MAY carry an optional `workId` foreign key. When the
  referenced work is deleted, the row MUST remain (`ON DELETE SET
  NULL`) so the audit trail is not lost.
- **FR-3** Optional `details` (jsonb) MUST be available for
  per-action structured payloads (item counts, repository name,
  switch mode, error details). `metadata` (jsonb) MUST be available
  for free-form caller annotations and MUST NOT contain secrets.
- **FR-4** `GET /api/activity-log` MUST accept `actionType`, `workId`,
  `status`, `dateFrom`, `dateTo`, `search`, `limit` (default 25,
  capped at 100), and `offset` (default 0) and MUST return
  `{activities, total}`.
- **FR-5** `GET /api/activity-log/running-count` MUST return
  `{count}` (rows with `status=in_progress` for the authenticated
  user).
- **FR-6** `GET /api/activity-log/summary` MUST return `{counts}`
  grouped by `ActivityStatus` for the authenticated user.
- **FR-7** `GET /api/activity-log/export` MUST stream a CSV with the
  six-column header
  `Date, Action Type, Action, Status, Work, Summary` and the
  `Content-Disposition: attachment; filename=activity-log.csv`
  response header, applying the same filter set as the list endpoint.
- **FR-8** `GET /api/activity-log/:id` MUST return the row only if it
  belongs to the authenticated user (cross-user reject via
  `findByIdAndUserId`); on miss it MUST return `404 Activity not
  found`. When the row is `in_progress` and references a live work,
  the response MUST attach the work's `generateStatus.recentLogs`
  array as `details.liveLogs` so callers do not need a second
  request.
- **FR-9** Every list/summary/detail endpoint MUST first run
  `reconcileActivities(userId)` so any orphaned in-progress rows are
  rewritten to their actual terminal status before serving the
  request.
- **FR-10** Reconciliation MUST be debounced per user via an
  in-flight promise map and a 5-second `recently-completed` cache
  (`ACTIVITY_RECONCILE_TTL_MS`) so concurrent requests do not run
  duplicate reconcile passes.
- **FR-11** `ActivityLogService.log(...)` MUST persist the row first
  and only then dispatch analytics. Analytics dispatch MUST be
  fire-and-forget (the await chain returns immediately) and MUST
  swallow rejections via `logger.warn` so the audit write succeeds
  even when the dispatcher fails.
- **FR-12** `ActivityLogService.updateStatus(id, status, details?,
  updates?)` MUST also re-dispatch the updated row through the
  analytics dispatcher so downstream consumers see status
  transitions. Updating a non-existent row MUST resolve to `null`
  without throwing.
- **FR-13** A `WorkGenerationCompletedEvent` listener MUST attempt to
  update the existing in-progress generation row (via
  `findLatestByUserWorkActionStatus`) before falling back to creating
  a fresh row, so there is **never** more than one row per
  user×work×generation run.
- **FR-14** All API endpoints MUST sit behind `AuthSessionGuard`
  (the global guard in `apps/api`); per-row visibility MUST be
  enforced by `userId` filtering on every query.
- **FR-15** The Jitsu dispatcher (`JitsuService`) MUST be a no-op
  when either `JITSU_HOST` or `JITSU_WRITE_KEY` is missing, MUST log
  a single `Jitsu analytics disabled: missing JITSU_HOST or
  JITSU_WRITE_KEY` line at construction, and MUST NOT throw on
  missing env vars.
- **FR-16** When dispatching, `JitsuService.track(activity)` MUST
  pass the row's `action` as the event name and merge the row's
  optional plain-object `metadata` into the event properties along
  with `activityId`, `userId`, `workId`, `actionType`, `action`,
  `status`, `summary`, `details`, and `createdAt` (ISO 8601). Array
  / non-object metadata MUST be ignored (treated as `{}`).
- **FR-17** Listener-side activity production MUST be fire-and-forget
  with respect to the originating event: a failed audit write MUST
  be `logger.error`-ed and MUST NOT propagate back to the event
  emitter (so a transient DB blip cannot break work creation, sign-up,
  deployment, etc.).
- **FR-18** The seven-column CSV export MUST escape embedded
  double-quotes via `"` doubling and MUST quote both the
  `Work` and `Summary` columns so commas inside human-readable
  strings do not break the format.

## 4. Non-Functional Requirements

- **Performance**:
    - Audit write is a single insert into a four-index table
      (`(userId, createdAt)`, `(userId, actionType)`, `(userId, workId)`,
      `(userId, status)`) — typical < 5 ms.
    - List queries are user-scoped and indexed; the 100-row cap keeps
      payloads bounded.
    - CSV export caps at 10 000 rows — large accounts must use
      `dateFrom` / `dateTo` to chunk.
- **Reliability**:
    - Audit writes MUST NOT depend on analytics dispatch — fail-open
      on Jitsu means activity rows are never lost on a dispatcher
      outage.
    - Listener-side errors are swallowed so an audit gap never wedges
      a domain event.
    - Stale-state reconciliation runs lazily on every read so a
      missed `WorkGenerationCompletedEvent` self-heals without an
      explicit cron.
- **Security & privacy**:
    - All endpoints sit behind `AuthSessionGuard`; row-level filtering
      is enforced via `userId`.
    - `details` and `metadata` columns MUST NOT contain secrets
      (passwords, API keys, OAuth tokens) — producers strip secrets
      before logging.
    - CSV export only ever returns the authenticated user's rows.
- **Observability**:
    - `ActivityLogService` debug-logs every row written
      (`Activity logged: [<actionType>] <summary> (user: <userId>)`)
      and every dispatcher rejection (`Activity analytics dispatch
      failed: <message>`).
    - `JitsuService` logs `Jitsu analytics disabled: missing
      JITSU_HOST or JITSU_WRITE_KEY` once at boot when not
      configured.
    - Each listener `try/catch` logs at `error` level so audit gaps
      are visible in the API logs.
- **Compatibility**:
    - `ActivityActionType` is an additive enum — new values are
      backwards-compatible (older clients ignore unknown values via
      the `actionType` query param).
    - The four-status `ActivityStatus` set is stable — additions
      would be a breaking-change to the summary endpoint, which keys
      the response by the enum value.

## 5. Key Entities & Domain Concepts

| Entity / concept              | Description                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActivityLog`                 | TypeORM entity at `packages/agent/src/entities/activity-log.entity.ts`. Per-row fields: `id, userId, workId?, actionType, action, status, summary, details?, metadata?, ipAddress?, userAgent?, createdAt, updatedAt`.                                                                                                                                  |
| `ActivityActionType`          | Enum at `packages/agent/src/entities/activity-log.types.ts`. Spans generation, deployment, work / item / plugin / template / member / schedule lifecycles, import/export, settings, auth/account, AI chat, and community PR. New types are added as the platform evolves; the enum is the canonical taxonomy for the History tab and analytics events. |
| `ActivityStatus`              | Enum: `pending` / `in_progress` / `completed` / `failed` / `cancelled`. `in_progress` rows are the only ones eligible for status reconciliation.                                                                                                                                                                                                       |
| `ActivityLogService`          | `packages/agent/src/activity-log/activity-log.service.ts`. Owns: `log`, `updateStatus`, `findAll`, `countRunning`, `summarizeStatuses`, `findById`, `findByIdAndUserId`, `findLatestByUserWorkActionStatus`, `exportCsv`, `reconcileStaleGenerationActivities`, `formatGenerationCompletionSummary`, `resolveGenerationActivityStatus`.                  |
| `ActivityLogListener`         | `apps/api/src/activity-log/activity-log.listener.ts`. Subscribes to nine `@OnEvent` handlers (work-created, generation-completed, works-config-sync-failed, user-created, user-confirmed, password-changed, member-invited, deployment-dispatched/-completed/-failed) and translates each event into the right `actionType` + `summary` + `details`.   |
| `ActivityLogAnalyticsDispatcher` | Optional injection token (`ACTIVITY_LOG_ANALYTICS_DISPATCHER`). One implementation today: `JitsuService` (`apps/api/src/activity-log/jitsu.service.ts`).                                                                                                                                                                                              |
| `JitsuService`                | Env-driven Jitsu client (`@jitsu/js`). Disabled at construction when `JITSU_HOST` or `JITSU_WRITE_KEY` is missing; otherwise calls `track(action, properties)` for every successful audit row.                                                                                                                                                          |
| `ActivityLogController`       | `apps/api/src/activity-log/activity-log.controller.ts`. Six endpoints (list, running-count, summary, export, get-by-id, plus the implicit reconcile front-step on every read) behind `@ApiTags('Activity Log')` + `AuthSessionGuard`.                                                                                                                  |
| Reconcile debounce            | Per-user `Map<string, Promise<void>>` for in-flight passes plus a `Map<string, number>` of completion timestamps. TTL constant: `ACTIVITY_RECONCILE_TTL_MS = 5_000` (5 s).                                                                                                                                                                              |
| Filter taxonomy               | The History tab maps `ActivityActionType` values into UI-level filter groups (generation, items, comparisons, taxonomy, community-pr, chat, auth, account) — see [`docs/specs/architecture/activity-log.md`](../../architecture/activity-log.md) §4.                                                                                                   |

## 6. Out of Scope

- **Multi-user / team-wide audit trails.** The activity log is
  strictly per-user; team views (e.g. "what did my colleague do on
  this work?") are not modelled here. Members appear only as the
  `userId` who performed an action.
- **Real-time push of new rows.** The UI polls the list endpoint;
  there is no WebSocket / SSE feed of activity events.
- **Long-form free-text search across `details` jsonb.** The
  `search` filter today matches `summary` and `work.name`; deep jsonb
  search is a future enhancement.
- **Streaming CSV export.** The export endpoint resolves a single
  10 000-row page into memory and returns it as one response. Larger
  exports require date-range chunking by the caller.
- **Row-level retention / TTL cleanup.** There is no scheduled
  delete job — rows are kept indefinitely. Storage growth is
  monitored; partitioning is a known future change (see architecture
  spec §10).
- **Idempotency at the row level.** Two identical inserts produce
  two rows. Producers handle dedup themselves where it matters
  (see architecture spec §12).
- **Analytics back-pressure / batching.** `JitsuService.track` is a
  one-row-at-a-time call; bursts are bounded only by the dispatcher's
  own internal queueing.
- **Reconciliation of non-generation in-progress rows.** Only
  `actionType=GENERATION` rows are eligible for the lazy reconcile
  pass. Other `in_progress` action types (e.g.
  `deployment.dispatched`) rely on their own terminal events
  (`DeploymentCompletedEvent` / `DeploymentFailedEvent`) to flip the
  status.

## 7. Acceptance Criteria

- [x] All six controller endpoints sit behind `AuthSessionGuard` and
      filter by `userId`.
- [x] List endpoint clamps `limit` at 100 regardless of input.
- [x] CSV export sets `Content-Type: text/csv` and
      `Content-Disposition: attachment; filename=activity-log.csv`,
      escapes embedded quotes via `"` doubling, and truncates at
      10 000 rows.
- [x] `GET /:id` returns 404 for cross-user / missing rows and
      enriches `details.liveLogs` from the live work when the row is
      `in_progress`.
- [x] Reconcile front-step rewrites orphaned `GENERATION` `in_progress`
      rows to their actual terminal status before serving any
      activity-log read.
- [x] Reconcile is debounced via the in-flight promise map plus the
      5-second completion cache.
- [x] `WorkGenerationCompletedEvent` updates the existing in-progress
      row in place (no duplicate row).
- [x] Analytics dispatch is fire-and-forget; a rejected dispatcher
      MUST NOT throw out of `log()` / `updateStatus()`.
- [x] Jitsu disabled-mode logs the construction notice and the
      `track()` method becomes a no-op.
- [x] Tests cover the controller (note: not yet — see §8 Open
      Questions / follow-ups), the service (`activity-log.service.spec.ts`
      in `packages/agent`), the Jitsu adapter (9 unit tests in #482),
      and the listener (25 unit tests in #482).

## 8. Open Questions

- **OQ-1 (controller-level unit tests).** As of 2026-05-08 the only
  controller-level coverage is the agent-package `ActivityLogService`
  spec; the API controller's reconcile-debounce, CSV-export response
  shape, `liveLogs` enrichment, and `Math.min(limit, 100)` cap have no
  dedicated `apps/api/src/activity-log/activity-log.controller.spec.ts`.
  Tracked as a follow-up in `tasks.md`; not blocking this spec.
- **OQ-2 (filter-group server mapping).** Today the History tab maps
  `actionType` to filter groups client-side. Consolidating this on
  the server would centralise the taxonomy but is not on the
  near-term roadmap.

## 9. Constitution Gates

- [x] **I — Plugin-first**: N/A — activity log is a platform-side
      audit concern; plugins emit domain events that producer code
      translates into rows.
- [x] **II — Capability-driven**: the `ActivityLogAnalyticsDispatcher`
      injection token is implementation-agnostic; today's binding is
      `JitsuService` but any provider that exports the
      `track(activity)` method satisfies the contract.
- [x] **III — Source-of-truth repos**: rows are platform-side audit
      data; they mirror but do not replace the canonical state
      tracked in user repos.
- [x] **IV — Trigger.dev**: N/A — activity log writes are
      synchronous and lightweight; no Trigger.dev fan-out is
      required.
- [x] **V — Forward-only migrations**: schema is additive — new
      action types add enum values; new columns default to null.
      Existing rows are never rewritten.
- [x] **VI — Tests**: covered by `activity-log.service.spec.ts` in
      `packages/agent`, plus `jitsu.service.spec.ts` (9) and
      `activity-log.listener.spec.ts` (25) in `apps/api` (PR
      [#482](https://github.com/ever-works/ever-works/pull/482)).
      A controller-level spec is the documented follow-up (OQ-1).
- [x] **VII — Secret hygiene**: producers strip secrets before
      writing; `details` and `metadata` columns are documented as
      secret-free.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      audit behaviour (what shows up in History, when an
      in-progress row gets reconciled, what the CSV looks like).
- [x] **X — Backwards-compat**: enum additions are non-breaking
      (clients filter by exact match and ignore unknown values);
      new optional columns default to null.

## 10. References

- Implementation:
    - Service: `packages/agent/src/activity-log/activity-log.service.ts`
    - Listener: `apps/api/src/activity-log/activity-log.listener.ts`
    - Controller: `apps/api/src/activity-log/activity-log.controller.ts`
    - Jitsu adapter: `apps/api/src/activity-log/jitsu.service.ts`
    - Analytics dispatcher token:
      `packages/agent/src/activity-log/activity-log-analytics-dispatcher.ts`
    - Summary helpers:
      `packages/agent/src/activity-log/activity-log-summary.ts`
    - Entity / enums:
      `packages/agent/src/entities/activity-log.entity.ts`,
      `packages/agent/src/entities/activity-log.types.ts`
- Tests:
    - `packages/agent/src/activity-log/activity-log.service.spec.ts`
    - `packages/agent/src/activity-log/activity-log-summary.spec.ts`
    - `apps/api/src/activity-log/activity-log.listener.spec.ts` (25)
    - `apps/api/src/activity-log/jitsu.service.spec.ts` (9)
- Architecture spec:
  [`docs/specs/architecture/activity-log.md`](../../architecture/activity-log.md)
- Related feature specs:
    - [`../notifications/spec.md`](../notifications/spec.md) — sibling
      surface (notifications are user-facing; activity log is
      owner-facing audit history).
    - [`../work-changelog/spec.md`](../work-changelog/spec.md) —
      structured per-mutation changelog attached to
      `work_generation_history` and referenced from activity rows.
    - [`../scheduled-updates/spec.md`](../scheduled-updates/spec.md) —
      schedule lifecycle events that produce
      `SCHEDULE_*` activity rows.
- PRs:
    - [#482](https://github.com/ever-works/ever-works/pull/482) — added
      the `JitsuService` (9 tests) and `ActivityLogListener` (25
      tests) unit suites.
