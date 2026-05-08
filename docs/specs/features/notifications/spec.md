# Feature Specification: Notifications

**Feature ID**: `notifications`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The notifications system delivers in-app, per-user messages that surface
asynchronous events (AI credit depletion, generation failures, schedule
pauses, expired Git auth, security alerts, etc.) to users without
relying on email. Notifications are persisted in Postgres, retrieved via
authenticated REST endpoints, deduplicated by an optional
`deduplicationKey`, and cleaned up on a schedule. A subset of
notifications are marked **persistent** — these surface as a global
banner in the UI and cannot be dismissed by the user until the
underlying issue is resolved.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my AI provider's credits are exhausted, **when** the
  generator hits a 402, **then** a persistent `ai_credits_depleted_<provider>`
  notification surfaces in my account header until I top up.
- **Given** I have several unread notifications, **when** I open the
  notification panel, **then** I see them sorted newest-first, paginated
  at 50 per request (max 100).
- **Given** I dismiss a non-persistent notification, **when** I refresh,
  **then** it no longer appears and is purged 7 days later by the cleanup
  job.
- **Given** the same error condition fires repeatedly, **when** the
  service emits the notification with the same `deduplicationKey`,
  **then** only one row is materialised — subsequent calls return the
  existing row.

### 2.2 Edge cases & failures

- **Given** two concurrent requests race to create a notification with
  the same dedup key, **when** the second hits the unique constraint,
  **then** the service catches `23505` / `ER_DUP_ENTRY` /
  `SQLITE_CONSTRAINT` and returns the row created by the first request.
- **Given** a notification is marked `isPersistent=true`, **when** I
  call `POST /api/notifications/:id/dismiss`, **then** the request
  returns 400 with the message _"Persistent notifications cannot be
  dismissed. Please resolve the underlying issue first."_
- **Given** the cleanup job is already running when the cron fires
  again, **when** the second invocation tries to acquire its lock,
  **then** it logs an `onLocked` debug message and exits cleanly.
- **Given** a cleanup pass throws mid-run, **when** the error reaches
  the listener, **then** the error is swallowed and logged so the next
  cleanup window is unaffected.
- **Given** the user requests `limit=500`, **when** the controller
  caps the request via `Math.min(limit, 100)`, **then** at most 100 rows
  are returned regardless of input.

## 3. Functional Requirements

- **FR-1** Each notification MUST belong to a single `userId` (no
  broadcast notifications) and MUST carry a `type`
  (`info` / `warning` / `error` / `success`) and a `category`
  (`ai_credits` / `subscription` / `generation` / `system` /
  `security`).
- **FR-2** When `deduplicationKey` is supplied, the service MUST return
  the existing non-dismissed notification rather than creating a
  duplicate.
- **FR-3** The service MUST treat unique-constraint violations
  (Postgres `23505`, MySQL `ER_DUP_ENTRY`, SQLite `SQLITE_CONSTRAINT`)
  as a deduplication race and return the existing row.
- **FR-4** `GET /api/notifications` MUST accept `unreadOnly`, `limit`
  (capped at 100), `offset`, and `category` query params and MUST
  default to `unreadOnly=false`, `limit=50`, `offset=0`.
- **FR-5** `GET /api/notifications/unread-count` MUST return
  `{count: number}`.
- **FR-6** `GET /api/notifications/persistent` MUST return only
  notifications where `isPersistent=true`.
- **FR-7** `POST /api/notifications/:id/read` and
  `POST /api/notifications/read-all` MUST mark the targeted rows as
  read for the authenticated user only.
- **FR-8** `POST /api/notifications/:id/dismiss` MUST refuse persistent
  notifications with `BadRequestException` and MUST refuse missing /
  cross-user notifications with `BadRequestException("Notification not
found")`.
- **FR-9** A `clearByDeduplicationKey(userId, key)` operation MUST be
  available so producers can clear a notification when the underlying
  issue resolves.
- **FR-10** A periodic cleanup MUST delete:
    - all notifications past their `expiresAt`, **and**
    - dismissed notifications older than 7 days, **and**
    - all notifications older than 30 days.
- **FR-11** The cleanup task MUST hold a single-instance lock
  (`notifications:cleanup`) so two cron firings cannot duplicate work.
- **FR-12** Convenience producers MUST be available for the most
  common cases:
  `notifyAiCreditsDepleted`, `notifyAiProviderError`,
  `notifyGenerationAccountError`, `notifySchedulePaused`,
  `notifyGitAuthExpired`. Each MUST set a stable
  `deduplicationKey`, an `actionUrl`, and an `actionLabel`.

## 4. Non-Functional Requirements

- **Performance**: list queries are indexed on `(userId, createdAt
desc)` and `(userId, isPersistent)`; cap at 100 rows per request keeps
  the panel snappy.
- **Reliability**: distributed lock + idempotent dedup keys mean
  cleanup and producer code are safe to retry.
- **Security**: all endpoints sit behind `AuthSessionGuard`; row-level
  filtering is enforced via `findByIdAndUserId` on every mutation
  before any state change.
- **Observability**: cleanup emits a single log line per run with
  `expired / dismissed / old` counts; producer methods log on creation
  with the notification id.
- **Cost**: no external delivery channel — all notifications are local
  Postgres rows. Expansion to email / push is out of scope (see §6).

## 5. Key Entities & Domain Concepts

| Entity / concept              | Description                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Notification`                | TypeORM entity. Fields: `id, userId, type, category, title, message, actionUrl, actionLabel, metadata, isPersistent, isDismissed, isRead, expiresAt, deduplicationKey, createdAt`. |
| `NotificationType`            | Enum: `info / warning / error / success`.                                                                                                                                          |
| `NotificationCategory`        | Enum: `ai_credits / subscription / generation / system / security`.                                                                                                                |
| `NotificationService`         | `packages/agent/src/notifications/notification.service.ts` — create / dedup / list / read / dismiss / cleanup.                                                                     |
| `NotificationCleanupService`  | `apps/api/src/notifications/notification-cleanup.service.ts` — distributed-lock-guarded cron worker.                                                                               |
| Per-cleanup lock key          | `notifications:cleanup` (single-instance, 5-min ttl).                                                                                                                              |
| Deduplication key conventions | `ai_credits_depleted_<provider>`, `ai_provider_error_<provider>`, `generation_error_<workId>`, `schedule_paused_<workId>`, `git_auth_expired_<provider>`.                          |

## 6. Out of Scope

- Email or push delivery (handled by `mail-providers` for transactional
  email; push not yet implemented).
- Per-organisation or broadcast notifications (notifications are
  strictly per-user).
- User-configurable notification preferences (mute by category, quiet
  hours, etc.) — currently all notifications are delivered regardless
  of preference.
- Internationalisation of notification copy — strings are emitted in
  English by the service.

## 7. Acceptance Criteria

- [x] `POST` and `GET` endpoints all sit behind `AuthSessionGuard` and
      filter by the authenticated user's id.
- [x] `deduplicationKey` race condition (two concurrent inserts) does
      NOT produce two rows — second writer recovers the first writer's
      row.
- [x] `POST /api/notifications/:id/dismiss` returns 400 for persistent
      notifications with the resolve-underlying-issue message.
- [x] Cleanup deletes expired + dismissed (>7d) + old (>30d) and
      reports the counts in a single log line.
- [x] Two cleanup invocations under the same lock collapse to one
      effective run (`onLocked` debug logged on the loser).
- [x] Tests cover all controller endpoints (10) and the cleanup
      service (4) — see `apps/api/src/notifications/__tests__`.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: producer-side notifications are emitted from facades and
      services, not directly from controllers.
- [x] **II**: capability-driven — only the agent module exports
      `NotificationService`; the API consumes it as a black box.
- [x] **III**: notifications are stored in Postgres (a database
      concern), but the per-user filtering keeps multi-tenant isolation
      on every read.
- [x] **IV**: cleanup runs as a `DistributedTaskLockService`-guarded
      worker so multiple instances cannot duplicate work.
- [x] **V**: schema additions are additive (new columns can default to
      `null`); deduplication is enforced by a partial unique index on
      `(userId, deduplicationKey)` where `deduplicationKey IS NOT NULL`.
- [x] **VI**: covered by `apps/api/src/notifications/*.spec.ts`
      (controller + cleanup) — 14 unit tests, [#490](https://github.com/ever-works/ever-works/pull/490).
- [x] **VII**: no secrets in notifications; producer methods take only
      user-visible strings (provider name, work name, free-form error
      message).
- [x] **VIII**: N/A — no plugin surface.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: schema changes are additive; older clients that ignore
      `isPersistent` simply never render the persistent banner.

## 10. References

- Implementation:
    - Service: `packages/agent/src/notifications/notification.service.ts`
    - Controller: `apps/api/src/notifications/notifications.controller.ts`
    - Cleanup worker: `apps/api/src/notifications/notification-cleanup.service.ts`
    - Entity / enums: `packages/agent/src/entities/notification.entity.ts`,
      `packages/agent/src/entities/notification.types.ts`
- Tests:
    - `apps/api/src/notifications/notifications.controller.spec.ts` (10)
    - `apps/api/src/notifications/notification-cleanup.service.spec.ts` (4)
- Related specs:
    - [`../activity-log/spec.md`](../activity-log/spec.md) — separate
      audit-trail surface (notifications are user-facing, activity log
      is owner-facing).
- Lock primitive:
  [`../../../agent-services/distributed-task-lock.md`](../../../agent-services/distributed-task-lock.md)
