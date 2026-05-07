# Implementation Plan: Notifications

**Feature ID**: `notifications`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    Producer[NotificationService.notifyXxx] --> Dedup{deduplicationKey?}
    Dedup -- yes --> Find[findByDeduplicationKey]
    Find -- exists & !dismissed --> Return[Return existing]
    Find -- missing --> Insert[repository.create]
    Dedup -- no --> Insert
    Insert -- 23505 / dup --> Recover[findByDeduplicationKey]
    Recover --> Return
    Insert -- ok --> Persist[(notifications row)]
    Persist --> Return

    User[Browser] -->|GET /api/notifications| Controller[NotificationsController]
    Controller -->|filter by userId| Repo[NotificationRepository]
    Repo --> Persist

    Cron[Cleanup cron] --> Lock[DistributedTaskLockService.runExclusive]
    Lock -- acquired --> Cleanup[deleteExpired + deleteOlderThan(7d, dismissed) + deleteOlderThan(30d)]
    Lock -- locked --> Skip[onLocked debug, exit]
```

## 2. Tech Choices

| Concern             | Choice                                                       | Rationale                                                |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Storage             | Postgres via TypeORM entity                                  | Same primary store as the rest of the platform           |
| Deduplication       | Optional `deduplicationKey` + service-side check + DB unique constraint | Defence in depth against in-process and cross-process races |
| Mutual exclusion    | `DistributedTaskLockService.runExclusive`                    | Constitution Principle IV; cleanup only                  |
| Cron                | Per-instance scheduled service (`@Cron`) + lock              | Multiple replicas safe; cleanup runs once per window     |
| API                 | NestJS REST controller behind `AuthSessionGuard`             | Matches the rest of the platform                         |
| Persistent banner   | `isPersistent` flag + dedicated `/persistent` endpoint        | UI can render a global banner without scanning the list  |

## 3. Data Model

```ts
@Entity('notifications')
class Notification {
    id: string;
    userId: string; // FK -> users
    type: 'info' | 'warning' | 'error' | 'success';
    category: 'ai_credits' | 'subscription' | 'generation' | 'system' | 'security';
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    metadata?: Record<string, any>; // jsonb
    isPersistent: boolean; // default false
    isDismissed: boolean; // default false
    isRead: boolean; // default false
    expiresAt?: Date;
    deduplicationKey?: string;
    createdAt: Date;
}
```

Indexes (additive, non-breaking migration):

- `(userId, createdAt desc)` — primary list query.
- `(userId, isPersistent)` partial — persistent banner query.
- Partial unique `(userId, deduplicationKey) WHERE deduplicationKey IS NOT NULL` — enforces dedup at the DB layer.

## 4. API Surface

| Method | Endpoint                              | Description                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/api/notifications`                  | List w/ `unreadOnly`/`limit`/`offset`/`category`. `limit` capped at 100. |
| `GET`  | `/api/notifications/unread-count`     | `{count}` envelope.                                                      |
| `GET`  | `/api/notifications/persistent`       | Returns only `isPersistent=true` rows for the current user.              |
| `POST` | `/api/notifications/:id/read`         | Mark single notification read; 400 if cross-user / missing.              |
| `POST` | `/api/notifications/read-all`         | Mark all current-user notifications read.                                |
| `POST` | `/api/notifications/:id/dismiss`      | Dismiss; 400 with explanation if `isPersistent=true`.                    |

All endpoints return JSON envelopes:

- List endpoints: `{ notifications: Notification[] }`.
- Mutation endpoints: `{ success: true }` (or 400 with `BadRequestException` body).

## 5. Plugin / Web / CLI

- **Plugin**: no plugin surface — internal cross-cutting service.
- **Web**: header bell icon polling `/unread-count` every 30s; full
  panel uses `/api/notifications`; persistent banner subscribes to
  `/persistent`. Dismissal is optimistic; on 400 the row is restored
  and the error toast is shown.
- **CLI**: not exposed (CLI is for the work / generator surface).

## 6. Background Jobs

`NotificationCleanupService` runs every 60 minutes (configurable per
deployment). Each invocation:

1. Calls `DistributedTaskLockService.runExclusive('notifications:cleanup', {ttlMs: 5 * 60_000, onLocked: () => debug log})`.
2. Inside the lock: `service.cleanup()` → 3 deletes:
    - `deleteExpired()`
    - `deleteOlderThan({ olderThanDays: 7, isDismissed: true })`
    - `deleteOlderThan({ olderThanDays: 30 })`
3. Logs a single line with the three counts.
4. On error: swallowed and logged; the next window retries.

## 7. Security & Permissions

- All endpoints behind `AuthSessionGuard`.
- All mutations route through `findByIdAndUserId(id, userId)` so a user
  cannot dismiss / read / target another user's notifications.
- Producer methods take only safe strings (provider name, work name,
  free-form error message) — no API keys, tokens, or PII other than
  the user-supplied workName.

## 8. Observability

- Producer log on create: `Created notification <id> for user <userId>: <title>`.
- Cleanup log: `Notification cleanup: <expired> expired, <dismissed> dismissed (>7d), <old> old (>30d)`.
- Dedup race log (debug): `Race condition detected for deduplication key <key>, fetching existing`.

## 9. Risks & Mitigations

| Risk                                            | Mitigation                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Notification flood from a stuck error loop      | `deduplicationKey` collapses repeated emissions to a single row           |
| Cleanup running on multiple replicas            | `DistributedTaskLockService` lock                                         |
| User dismisses a critical security notification | `isPersistent=true` notifications refuse dismissal w/ explanatory message |
| Race condition on parallel inserts of same key  | Catch unique-constraint code (`23505` / `ER_DUP_ENTRY` / `SQLITE_CONSTRAINT`) and recover |
| Notification table unbounded growth             | 30-day expiry sweep + 7-day dismissed sweep                               |
| Cleanup error wedges the next window            | Outer try/catch logs and swallows; lock TTL caps held lock to 5 min       |

## 10. Constitution Reconciliation

See `spec.md` §9.

## 11. References

- Spec: `./spec.md`
- Service: `packages/agent/src/notifications/notification.service.ts`
- Controller: `apps/api/src/notifications/notifications.controller.ts`
- Cleanup worker: `apps/api/src/notifications/notification-cleanup.service.ts`
- Tests: `apps/api/src/notifications/{notifications.controller.spec.ts,notification-cleanup.service.spec.ts}`
- Lock service:
  `packages/agent/src/cache/distributed-task-lock.service.ts`
