# ADR-005: Cache and Lock Pluggability — Keep PostgreSQL default, Add Redis as an Optional Provider

## Status

**Proposed** — Tracking implementation in [EW-629](https://evertech.atlassian.net/browse/EW-629). This ADR is forward-looking; **nothing changes today**. The PostgreSQL backend stays the default and remains fully supported.

## Date

- 2026-05-16 — Initial.

## Context

Ever Works deliberately runs all stateful concerns on PostgreSQL today:

- `CacheModule` (general-purpose key-value cache) uses `CacheFactory.TypeORM(...)` over the `cache_entries` table via a `TypeORMKeyvAdapter` — see [`caching.md`](../../architecture/caching.md).
- `DistributedTaskLockService` (per-resource mutex) uses the **same** `cache_entries` table, with atomic `INSERT` on the primary key as the acquisition primitive and a token-bound DELETE for release — see [`distributed-task-lock.md`](../../agent-services/distributed-task-lock.md).
- `WorkScheduleDispatcherService` uses CAS-style atomic UPDATE on its own schedule rows (the row IS the lock target).
- Background jobs run on Trigger.dev — no BullMQ-on-Redis wiring is present on the API or agent side.

This is a strong, simple architecture. One stateful store, one set of operational concerns, one backup story. It scales further than people usually expect — the `cache_entries` table is just an indexed PK, and PostgreSQL handles tens of thousands of QPS on commodity hardware.

**However**, as Ever Works grows past the open-source distribution and into hosted multi-tenant deployments at higher scale, some operators will want to:

1. **Offload hot cache traffic from the primary database.** A high-volume Work with frequent webhook bursts, plus the upcoming data-repo instant-sync dispatcher running every minute across thousands of Works, plus per-tick lock heartbeats, plus generic application caching — all hitting `cache_entries` — is fine today, but at 10× load some operators will prefer to move this traffic to Redis to keep their primary DB headroom for application data.
2. **Get sub-millisecond cache reads** for hot paths (rate limiters, request-scoped caches, etc.) — PostgreSQL is fast but Redis is faster for this workload class.
3. **Plug into existing Redis investments.** Operators running on platforms like AWS ElastiCache, Upstash, or Redis Cloud often already have a tuned Redis tier they want to reuse rather than stand up another PostgreSQL replica.
4. **Pubsub use cases** that may emerge later (cross-instance cache invalidation, distributed event fan-out). Redis is a natural fit if it's already in the stack.

The question isn't "PostgreSQL vs Redis" — it's whether we want to **lock ourselves to one option** or make the backend pluggable so each deployment can choose.

## Decision

Both `CacheModule` (via `CacheFactory`) and `DistributedTaskLockService` will become **pluggable** with a backend chosen at deployment time. Concretely:

1. **`CacheFactory` gains a third preset** — `CacheFactory.Redis(options)` — that returns a Keyv-Redis-backed `CacheModule` configuration. The existing `InMemory()` and `TypeORM(...)` presets remain unchanged and continue to be supported.
2. **`DistributedTaskLockService` is split into an abstract interface + two implementations** — `PostgresLockProvider` (current implementation, default) and `RedisLockProvider` (new, optional). The public `runExclusive` / `tryAcquire` / `release` API is unchanged.
3. **Configuration is driven by environment** — a new `EVER_WORKS_CACHE_BACKEND={typeorm,redis,memory}` and `EVER_WORKS_LOCK_BACKEND={postgres,redis}` pair selects the provider. Defaults: `typeorm` for cache, `postgres` for lock — i.e. existing deployments need no config change.
4. **Both backends must pass the same test suite.** The current `DistributedTaskLockService` test suite is generalised to run against a `LockProvider` interface; both providers must pass it identically.

### What does NOT change

- **The PostgreSQL backend remains the default and is fully supported.** No deployment is forced to add Redis. The self-hosted open-source distribution continues to work with just PostgreSQL as before.
- The existing `cache_entries` table, the `TypeORMKeyvAdapter`, and the current `DistributedTaskLockService` semantics (token-bound release, heartbeat refresh, 24h hard cap, stale-row sweep) all remain in place — they become the `PostgresLockProvider`.
- All existing callers (community-PR processor, future `data-repo-instant-sync` consumer) keep using the same injected service and high-level API. They never see a backend selector.

### Out of scope for this ADR

- Replacing Trigger.dev with a Redis-based queue (e.g. BullMQ). Trigger.dev stays.
- Distributed pubsub patterns (cross-instance cache invalidation). Can come later as a separate ADR if needed.
- Removing the PostgreSQL backend. **Never.** It stays the default and a first-class option.

## Consequences

**Positive**

- Operators with Redis investments can opt in without forking.
- High-scale deployments can offload cache + lock heartbeat traffic from the primary database.
- The platform retains its "just PostgreSQL" simplicity for self-hosters and small deployments.
- Decouples the abstract concern (lock / cache contract) from the storage choice — improves testability and lets us swap backends in tests too.

**Negative**

- Adds a small surface of provider-selection code paths to maintain (one extra abstraction layer).
- Operators choosing Redis pick up its operational concerns (persistence config, eviction policy, failover) — but that's their explicit choice.
- Two backends to keep at feature parity in tests + docs.

**Neutral**

- No new dependencies on the default path. Redis support arrives behind an optional `@ever-works/redis-provider` package or as a peer-dep.

## Implementation outline

Tracked in [EW-629](https://evertech.atlassian.net/browse/EW-629). High-level shape:

1. Define `LockProvider` interface (`packages/agent/src/cache/lock-provider.ts`):
    - `acquire(key, ttlMs): Promise<{ token: string } | null>`
    - `refresh(key, token, ttlMs): Promise<boolean>`
    - `release(key, token): Promise<void>`
    - `peek(key): Promise<boolean>`
2. Extract the current `DistributedTaskLockService` body that touches `cache_entries` into `PostgresLockProvider implements LockProvider`. `DistributedTaskLockService` becomes a thin orchestrator (heartbeat timer, error handling, `runExclusive` wrapper) that consumes any `LockProvider`.
3. Add `RedisLockProvider implements LockProvider` using `SET key token NX PX ttl` + Lua script for token-bound DELETE.
4. Add `CacheFactory.Redis({ url, ttl, namespace })` returning a `@keyv/redis`-backed `CacheModule.registerAsync(...)` config.
5. Module wiring: `LockProvider` injection token bound via factory provider that reads `EVER_WORKS_LOCK_BACKEND`.
6. Shared test suite (`packages/agent/src/cache/__tests__/lock-provider.contract.spec.ts`) that runs against both providers with the same expectations.
7. Docs: update [`caching.md`](../../architecture/caching.md) and [`distributed-task-lock.md`](../../agent-services/distributed-task-lock.md) to describe the provider selection and the `EVER_WORKS_*_BACKEND` env vars.

## References

- [EW-629 — Add Redis provider for Locks and Caching (optional, additive)](https://evertech.atlassian.net/browse/EW-629)
- [`distributed-task-lock.md`](../../agent-services/distributed-task-lock.md) — current PostgreSQL-backed lock service.
- [`caching.md`](../../architecture/caching.md) — current `CacheFactory` + `TypeORMKeyvAdapter`.
- [`data-repo-instant-sync` spec](../features/data-repo-instant-sync/spec.md) — first feature that explicitly notes both backends as supported (today: PostgreSQL; later: optionally Redis).
