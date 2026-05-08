# Task Breakdown: Activity Log

**Feature ID**: `activity-log`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## Phase 1 — Schema

- [x] T1. `activity_log` entity + repository
      (`packages/agent/src/entities/activity-log.entity.ts`,
      `packages/agent/src/database/repositories/activity-log.repository.ts`).
- [x] T2. `ActivityActionType` + `ActivityStatus` enums
      (`packages/agent/src/entities/activity-log.types.ts`).
- [x] T3. Indexes:
      `(userId, createdAt)`, `(userId, actionType)`,
      `(userId, workId)`, `(userId, status)` — and `userId` FK
      cascade, `workId` FK `ON DELETE SET NULL`.

## Phase 2 — Service

- [x] T4. `ActivityLogService.log(entry)` — persists row, fire-and-forget
      analytics dispatch, debug log.
- [x] T5. `ActivityLogService.updateStatus(id, status, details?, updates?)`
      — partial update, re-dispatches the updated row,
      null-when-missing semantics.
- [x] T6. `findAll` / `findById` / `findByIdAndUserId` /
      `countRunning` / `summarizeStatuses` /
      `findLatestByUserWorkActionStatus` query helpers.
- [x] T7. `exportCsv(query)` — 10 000-row cap, six-column header,
      `"`-escape, work-name + summary quoting.
- [x] T8. `reconcileStaleGenerationActivities(userId)` — bulk-fetch
      works, skip live `GENERATING` rows, terminal-status mapping,
      per-row try/catch, outer try/catch, debug log on success.
- [x] T9. `formatGenerationCompletionSummary` /
      `resolveGenerationActivityStatus` — keep summary text consistent
      across listener and reconcile pass.
- [x] T10. Optional `ACTIVITY_LOG_ANALYTICS_DISPATCHER` token wired
      via `@Optional() @Inject(...)`.

## Phase 3 — API

- [x] T11. `ActivityLogController` — six endpoints behind
      `AuthSessionGuard`:
    - `GET /api/activity-log` (list, `Math.min(limit, 100)` cap).
    - `GET /api/activity-log/running-count`.
    - `GET /api/activity-log/summary`.
    - `GET /api/activity-log/export` (CSV, attachment header).
    - `GET /api/activity-log/:id` (cross-user 404, `liveLogs`
      enrichment).
- [x] T12. Reconcile front-step on every endpoint via
      `reconcileActivities(userId)` — `reconcileInFlight` Map +
      `reconcileCompletedAt` Map + `ACTIVITY_RECONCILE_TTL_MS = 5_000`.
- [x] T13. ParseInt / DefaultValue pipes on `limit` (default 25) and
      `offset` (default 0); date-string → `Date` parsing for
      `dateFrom` / `dateTo`.
- [x] T14. CSV response shape: `Content-Type: text/csv` +
      `Content-Disposition: attachment; filename=activity-log.csv` +
      `res.send(body)`.

## Phase 4 — Event Listeners

- [x] T15. `ActivityLogListener` with nine `@OnEvent` handlers:
    - `WorkCreatedEvent` → `WORK_CREATED` / `work.created`.
    - `WorkGenerationCompletedEvent` → update existing in-progress row
      via `findLatestByUserWorkActionStatus` else create fresh
      `GENERATION` / `generation.completed` row; details from latest
      `WorkGenerationHistory`.
    - `WorksConfigSyncFailedEvent` →
      `WORKS_CONFIG_SYNC` / `works_config.sync_failed`.
    - `UserCreatedEvent` → `USER_SIGNUP` / `user.signup`.
    - `UserConfirmedEvent` →
      `USER_LOGIN` / `user.confirmed` w/ `via <provider | email>`
      summary.
    - `UserPasswordChangedEvent` →
      `PASSWORD_CHANGED` / `user.password_changed` (forwards
      `ipAddress` from event payload).
    - `MemberInvitedEvent` →
      `MEMBER_INVITED` / `member.invited` w/ `inviteeEmail` + `role`
      details.
    - `DeploymentDispatchedEvent` →
      `DEPLOYMENT` / `deployment.dispatched` w/ status `IN_PROGRESS`.
    - `DeploymentCompletedEvent` →
      `DEPLOYMENT` / `deployment.succeeded` w/ optional
      `Deployed … to <url>` summary.
    - `DeploymentFailedEvent` →
      `DEPLOYMENT` / `deployment.cancelled|failed` w/
      `terminalState=CANCELED` → `CANCELLED` status mapping.
- [x] T16. Per-handler `try/catch` + `logger.error` so audit gaps do
      NOT propagate back to the event emitter.

## Phase 5 — Analytics Dispatcher

- [x] T17. `ActivityLogAnalyticsDispatcher` injection token
      (`packages/agent/src/activity-log/activity-log-analytics-dispatcher.ts`).
- [x] T18. `JitsuService` env-driven adapter
      (`apps/api/src/activity-log/jitsu.service.ts`): - Disabled at construction when `JITSU_HOST` or
      `JITSU_WRITE_KEY` is missing (single info-level log line). - `track(activity)` merges plain-object metadata only,
      otherwise treats metadata as `{}`. - Forwards `activityId / userId / workId / actionType / action /
status / summary / details / createdAt` plus the metadata
      properties to the Jitsu client with `action` as the event name.
- [x] T19. Dispatcher binding wired in `apps/api/src/activity-log/jitsu.module.ts`.

## Phase 6 — Web

- [x] T20. History tab consumes `GET /api/activity-log` with the
      filter UI mapped to the `actionType` taxonomy.
- [x] T21. Sidebar badge polls `GET /api/activity-log/running-count`.
- [x] T22. Activity drawer reads `GET /api/activity-log/:id` and
      renders `details.liveLogs` for in-progress generations.
- [x] T23. CSV export button triggers
      `GET /api/activity-log/export?...` with the active filters.

## Phase 7 — Tests

- [x] T24. `activity-log.service.spec.ts` (`packages/agent`) — covers
      `log` / `updateStatus` / `findAll` / `countRunning` /
      `summarizeStatuses` / `findById` / `findByIdAndUserId` /
      `findLatestByUserWorkActionStatus` / `exportCsv` /
      `reconcileStaleGenerationActivities` /
      `formatGenerationCompletionSummary` /
      `resolveGenerationActivityStatus`.
- [x] T25. `activity-log-summary.spec.ts` (`packages/agent`) —
      covers `formatGenerationCountsSummary` and
      `formatStoredActivitySummary`.
- [x] T26. `activity-log.listener.spec.ts` (`apps/api`, 25 tests) —
      every `@OnEvent` handler, both happy and error paths
      ([#482](https://github.com/ever-works/ever-works/pull/482)).
- [x] T27. `jitsu.service.spec.ts` (`apps/api`, 9 tests) — env-driven
      enable/disable, plain-object metadata gate, optional
      `workId` / `details`, ISO timestamp forwarding
      ([#482](https://github.com/ever-works/ever-works/pull/482)).
- [ ] T28. **Follow-up**: `activity-log.controller.spec.ts`
      (`apps/api`) — currently only the agent-package service spec
      and the listener / Jitsu adapter unit suites cover this area.
      The controller's reconcile-debounce (in-flight Map + 5-second
      TTL), CSV-export response shape, `liveLogs` enrichment branch,
      and `Math.min(limit, 100)` cap have no dedicated controller-level
      test. Pattern lives in
      `apps/api/src/notifications/notifications.controller.spec.ts`
      — replicate it.
- [ ] T29. **Follow-up**: integration tests in `packages/agent` (Jest)
      hitting a real Postgres test container to pin (a) the four
      composite indexes, (b) the `(userId, workId)` `ON DELETE SET
  NULL` behaviour, and (c) the reconcile pass against a seeded
      orphan-in-progress row. Currently only unit tests cover the
      reconciliation path.

## Phase 8 — Docs

- [x] T30. Architecture spec (`docs/specs/architecture/activity-log.md`).
- [x] T31. This Spec Kit folder (spec / plan / tasks).
- [ ] T32. **Follow-up**: user-facing doc at
      `docs/features/activity-log.md` describing the History tab,
      filter taxonomy, CSV export workflow, and how to interpret the
      different `ActivityActionType` rows.
- [ ] T33. **Follow-up**: API reference cross-link from
      `docs/api/activity-log.md` once the per-endpoint REST docs land
      (currently the `@nestjs/swagger` decorators are the canonical
      source of truth).

## Definition of Done

- [x] Service is implemented and unit-tested at the agent layer
      (`activity-log.service.spec.ts` + `activity-log-summary.spec.ts`).
- [x] All controller endpoints sit behind `AuthSessionGuard` and
      filter every query by `userId`.
- [x] Lazy reconciliation rewrites orphaned `GENERATION` `in_progress`
      rows on every read.
- [x] Analytics dispatch is optional, env-gated, and fire-and-forget;
      dispatcher failure does NOT throw out of `log()` /
      `updateStatus()`.
- [x] Listener side handles errors with `try/catch + logger.error` so
      audit gaps do NOT propagate to the event emitter.
- [x] Architecture spec + Spec Kit folder authored.

## Follow-ups discovered

- **T28** — controller-level unit suite is the only API-side gap.
  Add an `apps/api/src/activity-log/activity-log.controller.spec.ts`
  modelled after the notifications controller spec; cover
  reconcile-debounce, CSV envelope, `liveLogs` enrichment, the
  100-row clamp, and 404-on-cross-user branches.
- **T29** — DB integration tests against a Postgres test container
  to pin schema (composite indexes, FK `ON DELETE SET NULL`) and the
  reconcile pass.
- **T32 / T33** — user-facing docs and API-reference docs.
- **Reconciliation cron** — if the lazy per-request approach ever
  pressures the read path, consider promoting the reconcile pass to
  a `DistributedTaskLockService.runExclusive('activity-log:reconcile',
…)` cron job, similar to the notifications cleanup worker.
- **Storage partitioning** — the architecture spec calls out
  per-work partitioning as a future change at the 1M-row scale; this
  is the spec to amend if that work lands.
