---
id: work-schedule-dispatcher
title: 'WorkScheduleDispatcherService Deep Dive'
sidebar_label: 'Schedule Dispatcher'
sidebar_position: 15
---

# WorkScheduleDispatcherService Deep Dive

## Overview

`WorkScheduleDispatcherService` is the cron-triggered entry point that finds due work schedules and dispatches their scheduled updates. It runs on a configurable cron interval (every N minutes), recovers zombie schedules left behind by crashed workers, claims each due schedule **atomically via a single SQL `UPDATE ... WHERE`** (no Redis or external lock service needed), and delegates the actual generation work to `WorkGenerationService`.

This doc covers what the service does, the race-condition-safe claim pattern it uses, and the data it returns.

## Where It Runs

The dispatcher does not start itself — it's wrapped by a **Trigger.dev scheduled task** that fires it on a cron schedule:

```ts
// packages/tasks/src/tasks/trigger/work-schedule-dispatcher.task.ts
const interval = Math.max(1, config.subscriptions.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;

export const workScheduleDispatcherTask = schedules.task({
	id: 'work-schedule-dispatcher',
	cron: cronExpression,
	run: async () => {
		const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
		try {
			const dispatcher = appContext.get(WorkScheduleDispatcherService);
			return { intervalMinutes: interval, ...(await dispatcher.dispatchDue()) };
		} finally {
			await appContext.close();
		}
	}
});
```

The Trigger.dev runtime guarantees one execution per cron tick across the whole worker pool — so the cron itself is single-fired. What the service guards against is the case where _two cron ticks overlap_ (a slow tick still running when the next one fires) and try to grab the same due schedules.

## Architecture

```
Trigger.dev cron (*/N * * * *)
        |
        v
WorkScheduleDispatcherService.dispatchDue(limit?)
        |
        +-- Step 0: feature flag check (subscriptions.scheduledUpdatesEnabled)
        |
        +-- Step 1: recoverStuckSchedules()                    <- cleanup zombies
        |
        +-- Step 2: scheduleRepository.findDue(limit)          <- WHERE nextRunAt <= now()
        |
        +-- Step 3: For each due schedule:
        |       |
        |       +-- markRunDispatched(scheduleId)              <- atomic CAS claim
        |       |     |
        |       |     +-- null   -> already claimed elsewhere; record `skipped`
        |       |     +-- entity -> we own the run; continue
        |       |
        |       +-- workGenerationService.runScheduledUpdate(schedule)
        |       |
        |       +-- error -> record `failed`; finalization happens inside the
        |                   inner methods (finalizeGeneration, handleSyncFailure,
        |                   etc.) so we don't double-count failures here.
        |
        v
Returns: WorkScheduleDispatchSummary
```

## API Reference

### `dispatchDue(limit?): Promise<WorkScheduleDispatchSummary>`

| Parameter | Type     | Default                              | Description                                          |
| --------- | -------- | ------------------------------------ | ---------------------------------------------------- |
| `limit`   | `number` | `config.subscriptions.getMaxBatch()` | Maximum number of schedules to process in this batch |

Returns:

```ts
interface WorkScheduleDispatchSummary {
	limit: number;
	dueCount: number;
	dispatched: number;
	skipped: number;
	failed: number;
	entries: WorkScheduleDispatchEntry[];
}

interface WorkScheduleDispatchEntry {
	scheduleId: string;
	workId: string;
	workName: string;
	workSlug: string;
	workOwner: string;
	scheduledFor: string | null;
	outcome: 'dispatched' | 'skipped' | 'failed';
	message?: string;
	historyId?: string;
}
```

The Trigger.dev wrapper merges `intervalMinutes` into this summary and returns it as the run output, so you can see in the Trigger.dev dashboard exactly which schedules ran in each tick.

## How Claiming Works (The Race-Free Part)

The most important detail in this service is `markRunDispatched`, which delegates to the repository's **`tryMarkDispatched(scheduleId)`**. The repository performs the claim with a single conditional `UPDATE`:

```ts
// packages/agent/src/database/repositories/work-schedule.repository.ts
async tryMarkDispatched(scheduleId: string): Promise<Date | null> {
    const schedule = await this.repository.findOne({
        where: { id: scheduleId },
        select: ['id', 'nextRunAt'],
    });
    if (!schedule?.nextRunAt) return null;

    const originalNextRunAt = schedule.nextRunAt;
    const dispatchedAt = new Date();

    const result = await this.repository
        .createQueryBuilder()
        .update(WorkSchedule)
        .set({
            lastRunStatus: GenerateStatusType.GENERATING,
            scheduledFor: originalNextRunAt,   // preserved as drift anchor
            nextRunAt: null,                   // claim marker
            lastRunAt: dispatchedAt,
            updatedAt: dispatchedAt,
        })
        .where('id = :id', { id: scheduleId })
        .andWhere('status = :status', { status: WorkScheduleStatus.ACTIVE })
        .andWhere('nextRunAt IS NOT NULL')   // <-- the CAS predicate
        .execute();

    return (result.affected ?? 0) > 0 ? originalNextRunAt : null;
}
```

The `WHERE nextRunAt IS NOT NULL` clause is the lock. The first dispatcher to UPDATE flips `nextRunAt` to `null`; any second dispatcher's UPDATE matches zero rows and returns `null`. This holds because:

- **Updates against a single row are serializable** in every supported RDBMS (PostgreSQL, SQLite, etc.) without an explicit transaction.
- The dispatcher reads `nextRunAt` _before_ the UPDATE only to preserve it into `scheduledFor` for drift correction (see below). The actual claim guarantee comes from the WHERE clause, not the read.
- A `status = ACTIVE` check prevents racing with manual pause/cancel operations.

**No Redis, no advisory locks, no distributed lock service required** — the schedule row itself is the lock. This is why the dispatcher can run on multiple workers concurrently without coordination.

> The repository code includes a comment about a theoretical TOCTOU window between the read of `nextRunAt` and the UPDATE. In practice this window is microseconds and the only way `scheduledFor` could go stale is if a full generation cycle completed between the two queries — which can't happen.

## `scheduledFor` — The Drift Anchor

Standard "calculate the next run from now" cron logic causes drift: a 1-hour schedule that fires 90 seconds late and re-schedules from `now()` will be 90 seconds late forever. The dispatcher avoids this by:

1. At claim time, copying `nextRunAt` (the time the run _was supposed_ to fire) into `scheduledFor` and clearing `nextRunAt`.
2. At completion time, calculating the next `nextRunAt` from the `scheduledFor` anchor — not from "right now".

```ts
private resolveAnchorDate(schedule: WorkSchedule): Date {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (schedule.scheduledFor && schedule.scheduledFor.getTime() > oneDayAgo) {
        return schedule.scheduledFor;
    }
    if (schedule.nextRunAt && schedule.nextRunAt.getTime() > oneDayAgo) {
        return schedule.nextRunAt;
    }
    return new Date();
}
```

If the anchor is older than 24 hours (e.g. a schedule that was paused for a week and just resumed) the dispatcher gives up on drift correction and resets to "now" — otherwise the next `nextRunAt` could fire dozens of times in immediate succession.

A side benefit: a manual "Run Now" request that fires _before_ the scheduled slot doesn't reset the upcoming run. `isManualRunAheadOfSchedule` detects this case and preserves the existing `nextRunAt`.

## Zombie Recovery

Before claiming any new work, the dispatcher calls `workScheduleService.recoverStuckSchedules()`. A schedule is "stuck" if:

- Its `lastRunStatus` is `GENERATING`, **and**
- Its `lastRunAt` is older than `config.subscriptions.getScheduleStuckTimeoutMinutes()` (default 60).

Stuck schedules are flipped to `ERROR` via `markRunFailed`, which increments their failure counter (and may auto-pause them after exceeding `maxFailureBeforePause`). On the next dispatch cycle they become eligible for claiming again — assuming the schedule wasn't paused.

Stuck schedules are caused by hard worker crashes (process killed, container restarted mid-generation) where the run never gets a chance to call its own finalization handlers.

## Sequential Processing & Limits

Schedules are processed sequentially in a `for` loop, not in parallel. This is intentional:

| Reason                | Why it matters                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Resource exhaustion   | A single generation can use 1+ CPU core and several GB of RAM; concurrent ones would saturate the worker.   |
| Predictable batch cap | `limit` (default `subscriptions.getMaxBatch()`) is a true batch ceiling, not a "max concurrent" suggestion. |
| Failure isolation     | One schedule's exception doesn't take down sibling runs.                                                    |

The trade-off is that a single batch's wall-clock time grows linearly with `limit`. Tune `getDispatchIntervalMinutes()` and `getMaxBatch()` together to make sure one tick finishes before the next fires.

## Outcome Recording

Every schedule processed in a batch produces exactly one entry in `summary.entries`, even if it errors. Outcomes:

| Outcome      | When it happens                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatched` | Generation kicked off successfully.                                                                                                                                                                                                  |
| `skipped`    | Either another worker already claimed the schedule (`markRunDispatched` returned `null`), or `WorkGenerationService.runScheduledUpdate` returned `status: skipped` (e.g. the work was deleted between queue and dispatch). |
| `failed`     | The dispatch threw. The actual finalization (`markRunFailed`) is handled by the inner methods so the dispatcher only logs and counts here.                                                                                           |

## Configuration

| Setting                            | Source                 | Description                                                      |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `scheduledUpdatesEnabled`          | `config.subscriptions` | Global feature flag — `false` returns an empty summary.          |
| `getDispatchIntervalMinutes()`     | `config.subscriptions` | Cron tick interval (drives `*/N * * * *`).                       |
| `getMaxBatch()`                    | `config.subscriptions` | Default `limit` for `dispatchDue()`.                             |
| `getScheduleStuckTimeoutMinutes()` | `config.subscriptions` | Threshold above which an in-progress run is treated as a zombie. |
| `getMaxFailureBeforePause()`       | `config.subscriptions` | Default failure ceiling before auto-pausing a schedule.          |

## Database Interactions

| Repository / Service          | Method                             | Purpose                                                     |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `WorkScheduleService`    | `recoverStuckSchedules()`          | Reset zombie schedules                                      |
| `WorkScheduleRepository` | `findDue(limit)`                   | `WHERE nextRunAt <= NOW() AND status = ACTIVE`              |
| `WorkScheduleService`    | `markRunDispatched(id)`            | Wraps the CAS claim and triggers the work sync         |
| `WorkScheduleRepository` | `tryMarkDispatched(id)`            | The actual atomic UPDATE (returns the original `nextRunAt`) |
| `WorkGenerationService`  | `runScheduledUpdate(schedule)`     | Execute the actual generation                               |
| `WorkScheduleService`    | `finalizeScheduleRun(id, outcome)` | Idempotent finalize (called from inner methods, not here)   |

## Why This Doesn't Use `DistributedTaskLockService`

`DistributedTaskLockService` (see [Distributed Task Lock](./distributed-task-lock)) is a generic cache-row-backed lock used by background workers that **don't have a single row to UPDATE** — for example, "run an analytics aggregation" doesn't have a per-target row.

The schedule dispatcher does have such a row (the `WorkSchedule` itself), so the conditional UPDATE is both simpler and stronger: it claims the work and updates state in one atomic step, no separate lock acquire/release lifecycle.

## Related

- [Work Scheduling](./work-scheduling) — schedule CRUD and state transitions
- [Work Generation](./work-generation) — the generation work the dispatcher kicks off
- [Distributed Task Lock](./distributed-task-lock) — the alternative locking mechanism for non-schedule background jobs
- [Scheduled Updates](/features/scheduled-updates) — the user-facing feature this powers
- [Work Import Service](./work-import-service) — creates schedules during import
