# Architecture: Activity Log & Audit Infrastructure

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers debugging "why didn't this event
get logged?", adding new activity types, or wiring downstream
analytics consumers.

---

## 1. Purpose

The activity log is the platform's audit trail — every work
mutation, generation run, and notable user action lands as a row in
`activity_log` (per-action) and/or as a structured `changelog`
attachment on `work_generation_history` (per-mutation
audit detail).

This spec covers how those two stores relate, the **synchronous write
path** every mutation goes through, the **async analytics dispatcher**
that fans out to PostHog without blocking the request, and the
**activity-type taxonomy** that drives the History tab and the
[`work-changelog`](../features/work-changelog/spec.md)
filter UI.

## 2. Two Stores, Different Jobs

| Store                     | Granularity       | Drives                                                     |
| ------------------------- | ----------------- | ---------------------------------------------------------- |
| `activity_log`            | Per user-action   | Activity feed, security audit, PostHog                     |
| `work_generation_history` | Per work mutation | History tab, schedule failure tracking, generation metrics |

`work_generation_history` rows can carry a `changelog` jsonb
payload — see [`features/work-changelog/spec`](../features/work-changelog/spec.md)
for the user-facing shape. `activity_log` rows summarise _what the
user did_; history rows summarise _what changed in the work_. The
two coexist by design — a single AI generation run produces one
history row plus one `work_generation_completed` activity-log
row, plus item-level changelog entries on the history row.

## 3. The `ActivityLogService`

Every mutation that needs to be audited goes through
`ActivityLogService.recordActivity(...)`:

```ts
await activityLogService.recordActivity({
	userId,
	workId,
	actionType: ActivityActionType.WORK_GENERATED,
	action: 'generation_completed',
	status: ActivityStatus.COMPLETED,
	summary: `Generated 27 items for "${work.name}"`,
	details: { runId, itemCount, durationMs },
	metadata: { triggerSource: 'schedule' },
	ipAddress,
	userAgent
});
```

The service:

1. Builds the canonical row (`ActivityLog` entity).
2. Persists it via `ActivityLogRepository.insert(...)`.
3. Fires-and-forgets the analytics dispatcher (§5) so the request
   isn't blocked on PostHog.
4. Returns the inserted row.

Failures to write the row throw — an audit gap is an integrity
problem. Failures to dispatch analytics log a warning but don't throw.

## 4. The Activity Type Taxonomy

The `ActivityActionType` enum defines every kind of action the platform
records. The platform groups them into UI-level filter groups for the
History tab:

| Filter group   | `ActivityActionType` values                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `generation`   | `WORK_GENERATED`, `WORK_REGENERATED`, `WORK_GENERATION_FAILED`                                              |
| `items`        | `ITEM_ADDED`, `ITEM_UPDATED`, `ITEM_REMOVED`                                                                |
| `comparisons`  | `COMPARISON_ADDED`, `COMPARISON_REMOVED`                                                                    |
| `taxonomy`     | `CATEGORY_CHANGE`, `TAG_CHANGE`, `COLLECTION_CHANGE`                                                        |
| `community_pr` | `COMMUNITY_PR_MERGED`                                                                                       |
| `chat`         | `CHAT_CONVERSATION`                                                                                         |
| `auth`         | `USER_LOGGED_IN`, `USER_LOGGED_OUT`, `API_KEY_CREATED`, `API_KEY_REVOKED`, `OAUTH_LINKED`, `OAUTH_UNLINKED` |
| `account`      | `ACCOUNT_EXPORTED`, `ACCOUNT_IMPORTED`, `SYNC_PUSHED`, `SYNC_PULLED`                                        |

The grouping lives on the API side (server-side mapping in the History
controller) so the UI doesn't need to know the full enum.

## 5. The Async Analytics Dispatcher

`ActivityLogAnalyticsDispatcher` is an optional injection token (`@Optional`
on the constructor). When wired, it's called after every successful
write with the just-written row. Today's only implementation pushes
events to PostHog with the row's `actionType` as the event name.

It runs **out-of-band**:

- The dispatcher's `dispatch(row)` is called in a fire-and-forget way.
- The dispatcher itself uses
  [`DistributedTaskLockService`](../../agent-services/distributed-task-lock.md)
  on a per-batch key to coalesce bursts.
- A failed dispatch logs a warning but never bubbles up to the
  request.

This split ensures the platform's auditing path stays synchronous and
reliable, while analytics push (a best-effort concern) doesn't add
latency to user requests or risk losing audit rows.

## 6. The `ActivityLog` Row

```ts
@Entity('activity_log')
export class ActivityLog {
	@PrimaryGeneratedColumn('uuid') id: string;
	@Column() userId: string;
	@Column({ nullable: true }) workId: string | null;
	@Column({ type: 'varchar' }) actionType: ActivityActionType;
	@Column() action: string;
	@Column({ type: 'varchar' }) status: ActivityStatus;
	@Column() summary: string;
	@Column({ type: 'jsonb', nullable: true }) details: Record<string, any> | null;
	@Column({ type: 'jsonb', nullable: true }) metadata: Record<string, any> | null;
	@Column({ nullable: true }) ipAddress: string | null;
	@Column({ nullable: true }) userAgent: string | null;
	@CreateDateColumn() createdAt: Date;
}
```

`status` is one of `pending` / `in_progress` / `completed` / `failed`.
For long-running operations (generation runs), the platform records a
single row with the final status — not a row per state transition.

## 7. Generation Counts Summary

`activity-log-summary.ts` exports two helpers used to format the
human-readable summary line on history pages:

- `formatGenerationCountsSummary({addedCount, updatedCount, removedCount})`
  → "Generated 27 items, updated 5 items".
- `formatStoredActivitySummary(row)` → uses the row's `details` to
  produce a similar string for non-generation activities.

These keep summary text consistent across the History tab, the
notifications drawer, and the activity feed.

## 8. The Changelog Attachment Path

When a mutation produces a structured `changelog` (added/updated/removed
items, taxonomy entries, comparisons), the writer:

1. Builds the
   [`WorkChangelog`](../features/work-changelog/spec.md)
   payload.
2. Writes it to the `work_generation_history.changelog` jsonb
   column **inside the same transaction** as the underlying mutation.
3. Records a single `activity_log` row that points at the history row
   via `details.historyId`.

This dual-write happens in one transaction so we never have an
activity-log entry without its corresponding history row, or vice
versa.

## 9. PostHog Event Naming Convention

When the analytics dispatcher pushes to PostHog, the event name uses
the snake-case `actionType`:

| `actionType`          | PostHog event name    |
| --------------------- | --------------------- |
| `WORK_GENERATED`      | `work_generated`      |
| `ITEM_ADDED`          | `item_added`          |
| `COMMUNITY_PR_MERGED` | `community_pr_merged` |

Properties on the event mirror the row's `details` block. PII (email,
IP) is **not** sent to PostHog — only `userId` (an opaque UUID) and
the action context.

## 10. Performance & Scale

- **Write latency**: < 5 ms typical. The synchronous write is a
  single insert into an indexed table.
- **Read latency**: < 200 ms for a paginated history page on a
  work with 100K rows (offset-based pagination + index on
  `(workId, createdAt DESC)`).
- **Analytics dispatch** never blocks the write path.
- **Storage growth**: per-work partitioning is _not_ used today
  — the platform uses a single `activity_log` table. At 10K active
  works the row count is manageable; at 1M+ this would call
  for partitioning, which is a documented future change.

## 11. Querying

`ActivityLogQueryOptions` supports:

| Filter            | Effect                                       |
| ----------------- | -------------------------------------------- |
| `userId`          | Required — every query is user-scoped        |
| `workId`          | Restrict to one work                         |
| `actionType`      | Single value or array                        |
| `actionGroup`     | UI-level group (`generation`, `items`, etc.) |
| `status`          | One of the four statuses                     |
| `since` / `until` | Time range                                   |
| `limit`           | Defaults to 20, capped at 100                |
| `offset`          | Standard offset pagination                   |

The repository uses query-builder joins to load the related history
row (`changelog`) when the caller asks for it via `includeChangelog`.

## 12. Idempotency & Deduplication

The activity log is **not** idempotent at the row level — duplicate
inserts produce duplicate rows. Callers handle deduplication
themselves where it matters:

- The schedule dispatcher calls
  `markRunFailed` only once per run via the `isAlreadyMarkedFailed`
  guard (see
  [Schedule Dispatcher](../../agent-services/work-schedule-dispatcher.md)).
- Pipeline finalisation calls `recordActivity` exactly once per run.
- Manual mutations (item add / taxonomy change) call once per HTTP
  request — natural idempotency from the request lifecycle.

## 13. Constitution Reconciliation

| Principle                   | How activity-log respects it                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- |
| I — Plugin-first            | N/A.                                                                                |
| II — Capability-driven      | The PostHog dispatcher is swappable via the `ActivityLogAnalyticsDispatcher` token. |
| III — Source-of-truth repos | Audit data is platform-side, mirrors what's in user repos but doesn't replace it.   |
| IV — Trigger.dev            | Heavy fan-out (e.g. PostHog batch dispatch) runs as Trigger.dev tasks.              |
| V — Forward-only migrations | `activity_log` schema is additive; new action types add enum values.                |
| VI — Tests                  | `activity-log.service.spec.ts` covers every action type + dispatcher fan-out.       |
| VII — Secret hygiene        | Row `details` and `metadata` columns must never contain secret values.              |
| VIII — Plugin counts        | N/A.                                                                                |
| IX — Behaviour-first        | This spec describes observable audit behaviour.                                     |
| X — Backwards-compat        | New filter groups + activity types are additive.                                    |

## 14. References

- Source:
    - `packages/agent/src/activity-log/activity-log.service.ts`
    - `packages/agent/src/activity-log/activity-log-analytics-dispatcher.ts`
    - `packages/agent/src/activity-log/activity-log-summary.ts`
    - `packages/agent/src/entities/activity-log.types.ts`
- Related specs:
    - [`features/work-changelog/spec`](../features/work-changelog/spec.md)
    - [`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
    - [`agent-services/distributed-task-lock`](../../agent-services/distributed-task-lock.md)
- User docs: [`docs/web-dashboard/history-ui.md`](../../web-dashboard/history-ui.md)
