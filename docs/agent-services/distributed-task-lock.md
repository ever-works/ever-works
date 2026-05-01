---
id: distributed-task-lock
title: 'DistributedTaskLockService Deep Dive'
sidebar_label: 'Distributed Task Lock'
sidebar_position: 16
---

# DistributedTaskLockService Deep Dive

## Overview

`DistributedTaskLockService` is a generic, **database-backed mutex** that lets the platform run "at most one of these at a time" workloads safely across multiple worker processes. It's used by background jobs that aren't naturally protected by a single-row `UPDATE ... WHERE` (the way the [Schedule Dispatcher](./directory-schedule-dispatcher) is) — for example, "process all open community PRs for directory X" or "rebuild analytics rollups".

The implementation lives in `packages/agent/src/cache/distributed-task-lock.service.ts`. It uses the `cache_entries` table that's already present for general-purpose caching, so there's **no Redis, no advisory-locking driver, and no extra infrastructure** — the same SQL database that holds your data also holds the locks.

## When To Use It

Reach for `DistributedTaskLockService` when:

- The work has no single "owning row" you can claim with an atomic `UPDATE` (otherwise prefer the CAS pattern from [Schedule Dispatcher](./directory-schedule-dispatcher#how-claiming-works-the-race-free-part)).
- You need "at most one of this thing per X" (per-directory, per-user, global), and "X" is something you can express as a string key.
- The protected work might run for many minutes — a heartbeat-refreshed lease is more robust than holding an open transaction.

Don't use it when:

- The work is short and idempotent — just let workers race; idempotency is cheaper than locks.
- You need cross-process **ordering** (FIFO). This service gives you mutual exclusion, not a queue.

## API

```ts
class DistributedTaskLockService {
	runExclusive<T>(
		key: string,
		fn: () => Promise<T>,
		options?: {
			ttlMs?: number; // default 15 minutes
			refreshIntervalMs?: number; // default max(30_000, ttl/3)
			maxLifetimeMs?: number; // default 24 hours, hard cap
			onLocked?: () => void; // called when acquisition fails
		}
	): Promise<{ acquired: boolean; result?: T }>;
}
```

### Return Value

| Field      | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `acquired` | `true` if this caller got the lock and `fn` ran. `false` if another holder already had it. |
| `result`   | The return value of `fn` — only present when `acquired === true`.                          |

When `acquired === false`, `fn` never executed and the optional `onLocked()` callback fires so the caller can log/skip cleanly.

### Key Namespacing

Whatever string you pass as `key` is automatically prefixed with `task-lock:` before being written to the `cache_entries` table. So a caller's `community-pr:abc-123` becomes the row key `task-lock:community-pr:abc-123`. Pick keys that already include the resource id (directory id, user id, etc.) — this service never derives keys for you.

## How It Works

### Acquisition

```ts
private async tryAcquire(key, ttlMs, maxLifetimeMs): Promise<string | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 1. Sweep expired or absurdly old rows for this key
    await this.cacheEntryRepository
        .createQueryBuilder()
        .delete()
        .where('key = :key', { key: lockKey })
        .andWhere('(expiresAt < :now OR createdAt < :staleBefore)', { now, staleBefore })
        .execute();

    // 2. Try to INSERT the row — PRIMARY KEY collision = locked
    try {
        await this.cacheEntryRepository.insert({
            key: lockKey,
            value: token,
            expiresAt: Math.min(now + ttlMs, now + maxLifetimeMs),
        });
        return token;
    } catch {
        // Distinguish "lock held" from "real error" by checking if the row exists
        const existing = await this.cacheEntryRepository.findOne({ where: { key: lockKey }, select: ['key'] });
        if (existing) return null;
        throw error;
    }
}
```

The atomicity comes from the `cache_entries` PRIMARY KEY on `key`. Two concurrent inserts can't both succeed; the loser learns "lock held" by retrying a SELECT.

The pre-INSERT DELETE is idempotent — it only removes rows whose `expiresAt < now()` or whose `createdAt` is older than the absolute max lifetime (24h). This is what reclaims locks abandoned by crashed workers, without ever touching a live holder's row.

### The Token

Each acquisition generates a token of the form `<pid>-<timestamp>-<random>`. The token is stored in the row's `value` column. **Every refresh and release operation includes `WHERE value = :token`.** So even if another worker thinks it owns the lock (e.g. it acquired after a stale-sweep wiped the previous row), no one can refresh or release a lock they don't own.

### Heartbeat Refresh

Once acquired, the service starts a `setInterval` that bumps `expiresAt` periodically:

```ts
const heartbeat = setInterval(() => {
	if (Date.now() >= hardDeadline) {
		clearInterval(heartbeat);
		this.logger.warn(`Lock "${key}" reached max lifetime — will be allowed to expire`);
		return;
	}
	this.refresh(key, token, ttlMs, hardDeadline).catch((err) => {
		this.logger.warn(`Failed to refresh lock "${key}": ${err.message}`);
	});
}, refreshIntervalMs);

heartbeat.unref?.();
```

This keeps long-running work alive past the initial TTL without holding an open transaction. Two safety nets:

| Mechanism        | Effect                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hardDeadline`   | After `maxLifetimeMs` from acquisition the heartbeat stops trying to refresh, so a runaway task can't hold the lock forever.           |
| `unref()`        | The Node.js timer doesn't keep the process alive — if the worker is shutting down, the timer doesn't keep it from exiting.             |
| Refresh-on-error | A failed refresh is logged but doesn't crash the workload. If refreshes keep failing the lock will eventually expire and be reclaimed. |

### Release

```ts
private async release(key: string, token: string): Promise<void> {
    await this.cacheEntryRepository
        .createQueryBuilder()
        .delete()
        .where('key = :key', { key: this.buildKey(key) })
        .andWhere('value = :value', { value: token })
        .execute();
}
```

Token-scoped. If the lock already expired and someone else reclaimed it, this DELETE matches zero rows — safe.

The release runs in a `finally` block, so it fires whether `fn` returned, threw, or was rejected.

## Defaults & Bounds

| Setting             | Default                | Hard cap                       |
| ------------------- | ---------------------- | ------------------------------ |
| `ttlMs`             | 15 minutes             | `maxLifetimeMs`                |
| `refreshIntervalMs` | `max(30 s, ttlMs / 3)` | —                              |
| `maxLifetimeMs`     | 24 hours               | 24 hours (`MAX_STALE_LOCK_MS`) |

The 24-hour ceiling is also the staleness threshold for the pre-acquire sweep — any lock row older than that is treated as abandoned regardless of `expiresAt`.

## Usage Example

The community-PR processor uses one lock per directory so two API calls (or a webhook racing with a manual refresh) can't both walk the same set of open PRs at once:

```ts
// packages/agent/src/community-pr/community-pr-processor.service.ts
private directoryLockKey(directoryId: string): string {
    return `community-pr:${directoryId}`;
}

async processDirectory(directory: Directory, ...): Promise<number> {
    const lockResult = await this.taskLockService.runExclusive(
        this.directoryLockKey(directory.id),
        async () => {
            // ... walk open PRs, extract items, commit, etc.
            return processedCount;
        },
    );

    if (!lockResult.acquired) {
        this.logger.log(`Directory ${directory.id} already being processed; skipping`);
        return 0;
    }

    return lockResult.result ?? 0;
}
```

This pattern (lock-per-resource keyed by id, return-zero-on-miss) is the recommended idiom for new callers.

## Module Wiring

`DistributedTaskLockService` is **not** auto-provided by the `agent` package's main module — it's intentionally registered by feature modules that need it, so the `cache_entries` repository binding stays scoped:

```ts
// e.g. packages/agent/src/community-pr/community-pr.module.ts
@Module({
	imports: [TypeOrmModule.forFeature([CacheEntry /* ... */])],
	providers: [CommunityPrProcessorService, DistributedTaskLockService]
})
export class CommunityPrModule {}
```

If you add a new feature module that uses the lock service, copy this pattern: import `CacheEntry` via `TypeOrmModule.forFeature`, then list `DistributedTaskLockService` in `providers`.

## Limitations & Failure Modes

- **No fairness / FIFO.** If you need a queue, use BullMQ or Trigger.dev — this service is a mutex, not a scheduler.
- **No global ordering across keys.** Each key is independent. If you need to coordinate across multiple locks, acquire them in a fixed order to avoid deadlocks.
- **Database load.** Every refresh is a write; with hundreds of long-running locks the heartbeat traffic is non-zero. Tune `refreshIntervalMs` upward for very long-running workloads.
- **Clock skew.** `expiresAt` is a millisecond timestamp generated by the worker that holds the lock. If your workers' clocks drift significantly the staleness sweep could either reclaim live locks or fail to reclaim dead ones. Run NTP.
- **Per-process timer.** Heartbeats run in-process. If the Node event loop is blocked for longer than the TTL, the lock will expire even though the worker is still alive — pick a TTL longer than your worst-case event-loop block.

## Related

- [Schedule Dispatcher](./directory-schedule-dispatcher) — uses CAS-style atomic UPDATE rather than this lock service, because the schedule row itself is the lock target.
- [Cache Module](./cache-module) — the `cache_entries` table this service piggybacks on.
- [Community PR Service](./community-pr-service) — the canonical caller (one lock per directory).
