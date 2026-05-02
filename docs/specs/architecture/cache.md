# Architecture: Cache Module

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers debugging cache-backed behaviour
(distributed locking, pipeline checkpointing, AI facade caches, model
catalog), or wiring new cache consumers.

---

## 1. Purpose

The platform has **one** caching primitive — a TypeORM-backed key-value
store on the `cache_entries` table — that backs four very different
runtime behaviours:

1. **Distributed task locks** (per-resource mutual exclusion).
2. **Pipeline checkpointing** (skip steps that already succeeded).
3. **AI facade routing caches** (provider config, plugin lookup).
4. **Model catalog cache** (1h TTL on the model registry snapshot).

This unification matters: there's exactly one table to migrate, one
encryption story, one rotation strategy, one set of observability
dashboards. Adding a fifth or sixth consumer is a few lines on top of
the existing factory rather than a new infrastructure choice.

## 2. The `cache_entries` Table

```ts
@Entity({ name: 'cache_entries' })
export class CacheEntry {
	@PrimaryColumn('varchar') key: string;
	@Column('text') value: string;
	@Column({ type: 'bigint', nullable: true })
	@Index()
	expiresAt: number | null; // Unix ms timestamp
	@CreateDateColumn() createdAt: Date;
	@UpdateDateColumn() updatedAt: Date;
}
```

Only four columns. The `key` PRIMARY KEY is what makes the
[`distributed-task-lock`](../../agent-services/distributed-task-lock.md)
acquisition pattern work — concurrent INSERTs collide on the key, so
the loser cleanly learns "lock held".

`value` is `text` rather than `jsonb` because consumers JSON-encode
themselves; this keeps the column type simple across PostgreSQL +
SQLite (both supported as platform databases).

`expiresAt` is a `bigint` Unix-ms timestamp rather than a `Date` — see
the rationale in
[`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
for similar millisecond-vs-Date issues; cache entries hit the same
edge case.

## 3. The `CacheFactory`

`packages/agent/src/cache/cache.factory.ts` exposes two registration
helpers consumed by feature modules:

```ts
export const CacheFactory = {
	InMemory(): DynamicModule {
		return CacheModule.register();
	},

	TypeORM(options?: { ttl?: number; namespace?: string; isGlobal?: boolean }): DynamicModule {
		return CacheModule.registerAsync({
			imports: [TypeOrmModule.forFeature([CacheEntry])],
			inject: [DataSource],
			isGlobal: options?.isGlobal,
			useFactory: async (dataSource) => {
				const repository = dataSource.getRepository(CacheEntry);
				const adapter = new TypeORMKeyvAdapter({
					repository,
					namespace: options?.namespace,
					ttl: options?.ttl
				});
				return { stores: [new Keyv({ store: adapter })] };
			}
		});
	}
};
```

Two registration modes:

- **`InMemory`** — used by tests and the internal CLI where persistence
  isn't needed. Backed by `cache-manager`'s default in-memory store.
- **`TypeORM`** — used in production. Backed by the `cache_entries`
  table via the [TypeORMKeyvAdapter](#5-the-typeormkeyvadapter).

Modules choose at registration time:

```ts
@Module({
	imports: [CacheFactory.TypeORM({ namespace: 'plugins', ttl: 5 * 60_000, isGlobal: true })]
})
export class PluginsModule {}
```

`namespace` prefixes every key (`plugins:<key>`) so unrelated consumers
can't collide; `ttl` is a default the consumer can override per-`set`
call.

## 4. Keyv as the Common Interface

The factory wires the TypeORM adapter into [Keyv](https://github.com/jaredwray/keyv),
a simple `get/set/delete` interface NestJS's `cache-manager` already
speaks. This gives every consumer the same shape regardless of
backing store:

```ts
@Injectable()
export class SomeService {
	constructor(@Inject(CACHE_MANAGER) private cache: Cache) {}

	async getOrCompute(key: string): Promise<Value> {
		const hit = await this.cache.get<Value>(key);
		if (hit) return hit;
		const fresh = await expensiveCompute();
		await this.cache.set(key, fresh, 60_000); // 60s TTL
		return fresh;
	}
}
```

Switching from `TypeORM` to `InMemory` (or to a future Redis adapter)
doesn't require any consumer changes.

## 5. The `TypeORMKeyvAdapter`

`packages/agent/src/cache/typeorm-keyv.adapter.ts` implements the Keyv
store interface:

| Operation              | SQL action                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `get(key)`             | `SELECT value, expiresAt WHERE key = ? AND (expiresAt IS NULL OR expiresAt > now())` |
| `set(key, value, ttl)` | `INSERT ... ON CONFLICT(key) DO UPDATE` (PostgreSQL) / `INSERT OR REPLACE` (SQLite)  |
| `delete(key)`          | `DELETE WHERE key = ?`                                                               |
| `clear(namespace)`     | `DELETE WHERE key LIKE 'namespace:%'`                                                |
| `has(key)`             | Same as `get` but returns `boolean`                                                  |

Expired rows are filtered on read but **not eagerly deleted** — a
periodic Trigger.dev sweep task purges rows where
`expiresAt < now()`. This keeps reads cheap (no DELETE on the hot
path) and avoids transaction overhead for the most common operation.

## 6. The Four Consumers

### 6.1 Distributed Task Lock

Documented in detail at
[`agent-services/distributed-task-lock`](../../agent-services/distributed-task-lock.md).
Uses keys prefixed `task-lock:<caller-key>` and stores tokens of the
form `<pid>-<timestamp>-<random>` in `value`. PRIMARY KEY collision is
the lock acquisition primitive.

### 6.2 Pipeline Checkpointing

Steps that declare `checkpoint: true` in their `BasePipelineStep`
implementation participate in checkpointing. Keys are
`checkpoint:<directoryId>:<runId>:<stepName>`. Values are the
JSON-encoded step output. TTL is configurable per step (typically
24h for "stick around long enough that a retry an hour later still
benefits"). See [`pipeline-executor`](./pipeline-executor.md#8-checkpointing).

### 6.3 AI Facade Routing & Provider-Config Cache

The `AiFacadeService` caches:

- **Resolved plugin per `(userId, directoryId)`** — saves the plugin
  registry lookup on hot paths.
- **Resolved provider config per `(userId, directoryId, providerId)`**
  — saves the [Settings System §9](./settings-system.md) cascade on
  every AI call.

Both invalidate on the `onSettingsUpdated` event a plugin emits when
its settings change. TTL is a 1-hour ceiling so even if invalidation
were missed, the cache would self-heal within an hour.

### 6.4 Model Catalog

`fetchModelCatalog()` in [AI Facade §5](./ai-facade.md#5-model-catalog)
caches the entire model registry per process for 1h. Key:
`model-catalog:current`. The catalog is process-wide and not really
cross-process — every worker pulls its own copy. This is cheap because
the catalog is a static JSON snapshot embedded in the agent package.

## 7. Namespacing Strategy

Every consumer **must** specify a namespace. The platform uses
single-purpose namespaces rather than a shared one:

| Consumer              | Namespace       |
| --------------------- | --------------- |
| Task locks            | `task-lock`     |
| Pipeline checkpoints  | `checkpoint`    |
| AI facade resolutions | `ai-facade`     |
| Model catalog         | `model-catalog` |
| Auth refresh tokens   | `auth-refresh`  |
| Webhook idempotency   | `webhook-idem`  |

A consumer who shares a namespace with another can stomp on its keys.
The factory enforces a non-empty `namespace` argument when creating a
non-global cache.

## 8. TTL Strategy

| Use case                 | Typical TTL        | Rationale                                                     |
| ------------------------ | ------------------ | ------------------------------------------------------------- |
| Task lock                | 15 min default     | Long enough for typical jobs; short enough for crash recovery |
| Task lock max-lifetime   | 24 h               | Hard ceiling to reclaim crashed-worker locks                  |
| Pipeline checkpoint      | 24 h               | Retries within a day still benefit                            |
| AI facade resolution     | 1 h                | Self-heals settings cache misses                              |
| Model catalog            | 1 h                | Static-ish data, refreshes hourly                             |
| Auth refresh token reuse | TTL = token expiry | Matches the refresh-token lifecycle                           |
| Webhook idempotency      | 24 h               | Stripe / GitHub webhook replay window                         |

Consumers should pick TTLs by _what's the longest interval at which
serving stale is OK?_ — if the answer is "never", caching is the wrong
tool, use direct DB reads.

## 9. Eviction & Stale Cleanup

Two cleanup mechanisms:

1. **Read-time filter** — every `get` filters expired rows; expired
   keys behave as if they don't exist.
2. **Periodic sweep** — a Trigger.dev task (`cache-cleanup`) runs every
   hour and `DELETE`s rows where `expiresAt < now()`. Keeps the table
   bounded.

The distributed task lock's pre-acquire DELETE (see
[`distributed-task-lock`](../../agent-services/distributed-task-lock.md#how-it-works))
also removes very-stale rows (`createdAt < 24h ago`) regardless of
`expiresAt`. This is a defence against rows that lost their TTL
metadata during database migrations.

## 10. Observability

Every cache consumer logs at three levels:

- **`debug`** — every hit and miss (off by default; enabled via env).
- **`info`** — cache initialisation (which adapter, which namespace,
  default TTL).
- **`warn`** — adapter errors (DB unavailable, write conflict).

Sentry breadcrumbs include cache operation + key for traces leading
into errors. The breadcrumbs **never include the cached value** — only
the key — so secret-bearing values don't leak.

## 11. Security Considerations

- The cache **does not encrypt values at rest** by default. Consumers
  that store sensitive data must encrypt before `set` and decrypt
  after `get`. (Today no consumer does — locks store random tokens,
  checkpoints store pipeline outputs, AI resolutions store config
  pointers, model catalog is public data.)
- The cache is **not** a database for PII. Consumers must not store
  user emails, names, or any persisting identity data — that belongs
  in a regular table.
- `expiresAt` is **advisory** — a worker that bypasses the read-time
  filter and reads directly will see expired rows. Consumers must
  use `cache.get(...)`, not raw repository reads.

## 12. Testing

Test setup uses `CacheFactory.InMemory()` so suites don't need a real
database. The TypeORM adapter has its own integration test suite
(`cache/typeorm-keyv.adapter.spec.ts`) that runs against an in-memory
SQLite to verify the upsert + expiry behaviour.

The distributed-task-lock test suite specifically covers the
PRIMARY-KEY-collision lock acquisition path, ensuring the SQL semantics
hold across both PostgreSQL and SQLite.

## 13. Constitution Reconciliation

| Principle                   | How the cache module respects it                                                       |
| --------------------------- | -------------------------------------------------------------------------------------- |
| I — Plugin-first            | Plugins consume the cache via their `PluginContext.cache` — never the table directly.  |
| II — Capability-driven      | Adapter is swappable (`InMemory` vs `TypeORM`).                                        |
| III — Source-of-truth repos | Cache is platform-side; never holds user content.                                      |
| IV — Trigger.dev            | Periodic sweep runs as a Trigger.dev task.                                             |
| V — Forward-only migrations | `cache_entries` schema is additive.                                                    |
| VI — Tests                  | Adapter + every consumer has unit and integration coverage.                            |
| VII — Secret hygiene        | Default no-encryption — consumers encrypt sensitive values; logs never include values. |
| VIII — Plugin counts        | N/A.                                                                                   |
| IX — Behaviour-first        | This spec describes observable cache behaviour.                                        |
| X — Backwards-compat        | Adding consumers is namespace-additive; never breaks existing ones.                    |

## 14. References

- Source:
    - `packages/agent/src/cache/cache.factory.ts`
    - `packages/agent/src/cache/typeorm-keyv.adapter.ts`
    - `packages/agent/src/cache/distributed-task-lock.service.ts`
    - `packages/agent/src/entities/cache.entity.ts`
- Related specs:
    - [`agent-services/distributed-task-lock`](../../agent-services/distributed-task-lock.md)
    - [`pipeline-executor`](./pipeline-executor.md)
    - [`ai-facade`](./ai-facade.md)
    - [`plugin-sdk`](./plugin-sdk.md)
