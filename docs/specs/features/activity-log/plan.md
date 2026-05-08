# Implementation Plan: Activity Log

**Feature ID**: `activity-log`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    DomainEvent[Domain @OnEvent\nWorkCreatedEvent / WorkGenerationCompletedEvent /\nUserCreatedEvent / UserConfirmedEvent /\nUserPasswordChangedEvent / MemberInvitedEvent /\nDeploymentDispatched/Completed/Failed /\nWorksConfigSyncFailedEvent] --> Listener[ActivityLogListener\n@OnEvent handler]
    DirectCall[Controller / Service\nactivityLogService.log(...)] --> Service[ActivityLogService.log]
    Listener --> Service
    Service --> Repo[(activity_log row)]
    Service --> Dispatch{ANALYTICS_DISPATCHER\nbound?}
    Dispatch -- yes --> Jitsu[JitsuService.track\n(env-gated, fire-and-forget)]
    Dispatch -- no --> Skip[silent no-op]

    User[Browser] -->|GET /api/activity-log/...| Controller[ActivityLogController]
    Controller --> Reconcile[reconcileActivities(userId)\nin-flight Map + 5s TTL]
    Reconcile -- in-flight --> Wait[await existing promise]
    Reconcile -- recently completed --> Skip2[skip pass]
    Reconcile -- run --> Walk[reconcileStaleGenerationActivities]
    Walk --> Repo
    Walk --> Service
    Reconcile --> Query[ActivityLogService.findAll/\ncountRunning/summarizeStatuses/\nfindByIdAndUserId/exportCsv]
    Query --> Repo
```

## 2. Tech Choices

| Concern               | Choice                                                                          | Rationale                                                                              |
| --------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Storage               | Postgres via TypeORM entity (`activity_log`)                                    | Same primary store as the rest of the platform; survives restarts and replicas         |
| Event ingestion       | NestJS `@OnEvent` listeners (`@nestjs/event-emitter`)                           | Decouples audit from domain code without an external broker                            |
| Analytics fan-out     | Optional `ActivityLogAnalyticsDispatcher` token (default impl: `JitsuService`)  | Capability-driven (Constitution Principle II); replaceable per deployment              |
| Reconciliation        | Lazy per-request debounced pass keyed on `userId`                               | Self-heals missed terminal events without an extra cron worker                         |
| Debounce window       | 5-second `ACTIVITY_RECONCILE_TTL_MS` + per-user in-flight `Map<string,Promise>` | Bursty refreshes (sidebar badge + list + summary) collapse to one reconcile per window |
| API                   | NestJS REST controller behind `AuthSessionGuard`                                | Matches the rest of the platform                                                       |
| CSV export            | Sync resolution of `findByUserIdForExport` (10 000-row cap), in-memory CSV      | Simple, audit-friendly; very large exports require date-range chunking                 |
| Listener error policy | Per-handler `try / catch` + `logger.error(...)`                                 | Audit gap MUST NOT bring down the originating domain operation                         |

## 3. Data Model

```ts
@Entity('activity_log')
@Index(['userId', 'createdAt'])
@Index(['userId', 'actionType'])
@Index(['userId', 'workId'])
@Index(['userId', 'status'])
class ActivityLog {
	id: string; // uuid
	userId: string; // FK -> users (cascade delete)
	workId?: string; // FK -> works (set null on delete)
	actionType: ActivityActionType; // enum (varchar(50))
	action: string; // dotted free-form (varchar(100)) e.g. 'work.created'
	status: ActivityStatus; // enum (varchar(50))
	summary: string; // human-readable (varchar(500))
	details?: Record<string, any>; // jsonb / simple-json
	metadata?: Record<string, any>; // jsonb / simple-json
	ipAddress?: string;
	userAgent?: string;
	createdAt: Date;
	updatedAt: Date;
}
```

Indexes (additive, non-breaking migrations):

- `(userId, createdAt)` — primary list query (newest-first).
- `(userId, actionType)` — filter by action type.
- `(userId, workId)` — filter by work.
- `(userId, status)` — running-count + summary endpoints.

The `userId` FK cascades on delete (a deleted user's audit trail is
removed), but the `workId` FK uses `ON DELETE SET NULL` so audit
history survives work deletions.

## 4. API Surface

| Method | Endpoint                          | Description                                                                                                                                  |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/activity-log`               | List w/ `actionType` / `workId` / `status` / `dateFrom` / `dateTo` / `search` / `limit` (max 100) / `offset`. Returns `{activities, total}`. |
| `GET`  | `/api/activity-log/running-count` | `{count}` — number of `in_progress` rows for the current user.                                                                               |
| `GET`  | `/api/activity-log/summary`       | `{counts}` — record keyed by `ActivityStatus`.                                                                                               |
| `GET`  | `/api/activity-log/export`        | CSV download with `Content-Disposition: attachment; filename=activity-log.csv`. Capped at 10 000 rows.                                       |
| `GET`  | `/api/activity-log/:id`           | Single row (cross-user reject → 404). Enriches `details.liveLogs` for in-progress generations.                                               |

Every read endpoint runs `reconcileActivities(userId)` first; the
debounce ensures concurrent requests collapse to one pass.

## 5. Plugin / Web / CLI

- **Plugin**: no plugin surface. Plugins emit domain events
  (e.g. `WorkGenerationCompletedEvent`); the `ActivityLogListener` in
  `apps/api` translates each event into the right
  `actionType` / `summary` / `details` shape.
- **Web**: the History tab consumes `GET /api/activity-log` with the
  filter UI mapped to the `actionType` taxonomy. The sidebar badge
  uses `/running-count` (cheap status-keyed index lookup). The
  detail drawer uses `/:id` and reads `details.liveLogs` to surface
  the live pipeline log without a second request.
- **CLI**: not exposed today. The activity feed is a UI surface; CLI
  callers that need audit data should query the `findAll` repository
  method directly via `@ever-works/agent`.

## 6. Background Jobs

There is **no** dedicated activity-log cron. Instead:

1. **Reconciliation** is lazy: every controller endpoint runs
   `reconcileActivities(userId)` first, debounced via:
    - `reconcileInFlight: Map<string, Promise<void>>` — second
      caller awaits the first promise instead of starting a new one.
    - `reconcileCompletedAt: Map<string, number>` — runs within the
      last 5 seconds short-circuit.
2. **Reconcile pass logic** (`reconcileStaleGenerationActivities`): - Find every `in_progress` row with `actionType=GENERATION`. - Bulk-load referenced works. - For each row, look up the work; if `generateStatus.status` is
   still `GENERATING`, leave it alone — the run is genuinely live. - Otherwise resolve the terminal status
   (`CANCELLED` → `CANCELLED`, `ERROR` → `FAILED`,
   everything else → `COMPLETED`), build the new `details` payload
   (item counts from the latest history row + frozen
   `generateStatus`), and call `updateStatus(id, status, details,
{action: 'generation.completed', summary})`.
3. **Failure policy**: any per-row exception is logged at `warn` and
   skipped; the outer `try/catch` returns 0 from `reconcileStale...`
   if the bulk fetch itself throws so the user-facing endpoint never
   500s on a transient DB blip.

(Other in-progress action types — `DEPLOYMENT`, etc. — rely on their
own terminal events, e.g. `DeploymentCompletedEvent` and
`DeploymentFailedEvent` flipping the row to its final status.)

## 7. Security & Permissions

- All endpoints sit behind `AuthSessionGuard`; `userId` is taken from
  the authenticated session and injected via `@CurrentUser()`.
- Every query is scoped on `userId`. The `findByIdAndUserId` lookup
  ensures cross-user `:id` access cannot leak rows.
- The CSV export inherits the same `userId` filter — no other user's
  rows can ever be exported.
- Producer code (listener handlers, controllers calling
  `activityLogService.log`) is responsible for stripping secrets
  before populating `details` / `metadata`. The schema does not
  enforce this; reviewers MUST flag any logged column that includes
  API keys, OAuth tokens, or password material.
- The `ipAddress` and `userAgent` columns are populated only when the
  caller passes them explicitly (e.g. `UserPasswordChangedEvent`).
  They MUST NOT be backfilled from arbitrary HTTP headers without
  considering privacy implications.

## 8. Observability

- **Service-level logs**: - `Activity logged: [<actionType>] <summary> (user: <userId>)`
  (debug, every successful `log()`). - `Activity analytics dispatch failed: <message>` (warn, every
  Jitsu rejection). - `Failed to reconcile stale generation activity <id>: <message>`
  (warn, per-row reconcile failures). - `Reconciled <n> stale in-progress generation activit<y|ies> for
user <userId>` (debug, when a pass actually rewrites rows).
- **Listener logs**: each handler's `catch` writes a one-line
  `Failed to log <area> activity:` at `error` level so audit gaps are
  visible per-event-type.
- **Jitsu boot log**: `Jitsu analytics disabled: missing JITSU_HOST
or JITSU_WRITE_KEY` (log-level, single line at construction when
  not configured).
- **Metrics** (out of scope for this spec): no custom metrics today.
  The History UI's sidebar badge is the closest thing to a "rate of
  in-progress activities" indicator.

## 9. Risks & Mitigations

| Risk                                                                      | Mitigation                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Missed `WorkGenerationCompletedEvent` leaves a row stuck in `in_progress` | Lazy reconcile front-step on every read endpoint walks orphaned rows and rewrites them to the work's actual terminal status     |
| Concurrent requests run duplicate reconcile passes                        | `reconcileInFlight` map awaits the first promise; `reconcileCompletedAt` cache short-circuits within 5 s                        |
| Analytics dispatcher slow / unavailable                                   | Dispatch is fire-and-forget after the row is persisted; rejection is `warn`-logged but does not throw                           |
| Listener throws while writing the audit row                               | Each handler wraps its body in `try/catch` + `logger.error`; the originating event is not re-thrown                             |
| Storage growth                                                            | Indexed user-scoped reads stay fast; per-work partitioning is documented as a future change in `architecture/activity-log.md`   |
| `details` / `metadata` accidentally containing secrets                    | Producer code strips secrets before logging; reviewers flag any logged payload with auth material                               |
| Two listeners producing duplicate rows for the same event                 | `WorkGenerationCompletedEvent` listener uses `findLatestByUserWorkActionStatus` to update the existing in-progress row in place |
| Long-running CSV export exhausts memory                                   | 10 000-row hard cap on `findByUserIdForExport`; large date ranges must be chunked by the caller                                 |

## 10. Constitution Reconciliation

See `spec.md` §9 and the architecture spec
`docs/specs/architecture/activity-log.md` §13.

## 11. References

- Spec: `./spec.md`
- Architecture: `docs/specs/architecture/activity-log.md`
- Service: `packages/agent/src/activity-log/activity-log.service.ts`
- Listener: `apps/api/src/activity-log/activity-log.listener.ts`
- Controller: `apps/api/src/activity-log/activity-log.controller.ts`
- Jitsu adapter: `apps/api/src/activity-log/jitsu.service.ts`
- Tests:
    - `packages/agent/src/activity-log/activity-log.service.spec.ts`
    - `packages/agent/src/activity-log/activity-log-summary.spec.ts`
    - `apps/api/src/activity-log/activity-log.listener.spec.ts` (25)
    - `apps/api/src/activity-log/jitsu.service.spec.ts` (9)
- Related agent service: `packages/agent/src/cache/distributed-task-lock.service.ts`
  (not used by activity-log today, but listed as the canonical
  exclusive-task primitive should reconciliation move to a cron).
