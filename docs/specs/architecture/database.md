# Architecture: Database & TypeORM

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers writing migrations, adding
entities, debugging connection-pool issues, or extending the
repository layer.

---

## 1. Purpose

The platform speaks to a single relational database via **TypeORM**.
Both the API process and the Trigger.dev worker share the same
schema, the same connection pool factory, and the same repository
classes — there's only one database module
(`packages/agent/src/database/`) consumed by every NestJS application
context the platform bootstraps.

This spec covers the **module layout**, **multi-driver support
(PostgreSQL + SQLite)**, the **entity registry**, the **repository
layer**, **migration strategy**, **transaction patterns**, and the
**bigint-timestamp pattern** that's surfaced repeatedly when other
specs needed it.

## 2. Module Layout

```
packages/agent/src/database/
├── README.md
├── database-config.factory.ts            # NestJS dynamic module factory
├── database-init.service.ts              # Startup: ensures schema exists
├── database.config.ts                    # TypeORM config + ENTITIES registry
├── database.module.ts                    # Top-level module exporting repos
├── repositories/                         # 17 repository classes
│   ├── activity-log.repository.ts
│   ├── api-key.repository.ts
│   ├── auth-account.repository.ts
│   ├── conversation.repository.ts
│   ├── directory-advanced-prompts.repository.ts
│   ├── directory-custom-domain.repository.ts
│   ├── directory-generation-history.repository.ts
│   ├── directory-member.repository.ts
│   ├── directory-schedule.repository.ts
│   ├── directory.repository.ts
│   ├── notification.repository.ts
│   ├── refresh-token.repository.ts
│   ├── subscription-plan.repository.ts
│   ├── usage-ledger.repository.ts
│   ├── user-subscription.repository.ts
│   ├── user.repository.ts
│   └── __tests__/
├── utils/                                # Shared query helpers
└── index.ts
```

`DatabaseModule` exports every repository as a NestJS provider.
Services consume them via constructor injection — no service ever
imports `Repository<Entity>` directly from TypeORM. The repository
layer is the only thing that touches the ORM.

## 3. Multi-Driver Support

The platform runs against:

| Driver     | Use case                                                |
| ---------- | ------------------------------------------------------- |
| `postgres` | Production + staging                                    |
| `sqlite`   | Local development, e2e tests, single-tenant self-hosted |

Driver selection is by env var (`DATABASE_TYPE=postgres` or `sqlite`).
`database-config.factory.ts` builds the right TypeORM `DataSource`
config from the runtime env. Both drivers run the same SQL via
TypeORM's query builder; SQL that drifts (e.g. `jsonb` is
PostgreSQL-only) goes through repository helpers that branch on
driver.

The deliberate constraint: every query the platform writes works on
both drivers. Specs like
[`distributed-task-lock`](../../agent-services/distributed-task-lock.md)
and [`cache`](./cache.md) explicitly cite this — their `INSERT … ON
CONFLICT` (PostgreSQL) ↔ `INSERT OR REPLACE` (SQLite) handling lives
in the adapter, not in the consumer.

## 4. The `ENTITIES` Registry

`database.config.ts` exports a single `ENTITIES` array that lists
every TypeORM entity:

```ts
export const ENTITIES = [
	Directory,
	DirectoryMember,
	DirectorySchedule,
	DirectoryAdvancedPrompts,
	DirectoryCustomDomain,
	DirectoryGenerationHistory,
	User,
	AuthAccount,
	RefreshToken,
	ApiKey,
	SubscriptionPlan,
	UserSubscription,
	UsageLedgerEntry,
	Notification,
	ActivityLog,
	Conversation,
	CacheEntry,
	OAuthToken,
	PluginSettings,
	UserPlugin,
	DirectoryPlugin
	// ...
];
```

`TypeOrmModule.forRoot({ entities: ENTITIES, ... })` consumes this
list. **Adding a new entity** is one import + one array entry — never
forgetting an entity in module wiring.

The list is also re-exported from
`packages/agent/src/database/index.ts` so test setups (which create
their own `DataSource` for in-memory SQLite) get the same registry.

## 5. Repository Pattern

Every entity has a dedicated repository class that:

- Extends a thin base (`Repository<Entity>` from TypeORM, sometimes
  via `@InjectRepository`).
- Encapsulates **all** queries against that entity — services don't
  write SQL or query-builder calls.
- Provides typed methods named after the domain operation
  (`findLatestInProgressByDirectory`, `tryMarkDispatched`,
  `countActiveByUser`).
- Hides driver differences (PostgreSQL upserts, SQLite shims).

Example shape:

```ts
@Injectable()
export class DirectoryScheduleRepository {
	constructor(
		@InjectRepository(DirectorySchedule)
		private readonly repository: Repository<DirectorySchedule>
	) {}

	async findDue(limit: number): Promise<DirectorySchedule[]> {
		return this.repository.find({
			where: {
				status: DirectoryScheduleStatus.ACTIVE,
				nextRunAt: LessThanOrEqual(new Date())
			},
			order: { nextRunAt: 'ASC' },
			take: limit,
			relations: ['directory']
		});
	}

	// The CAS claim — see directory-schedule-dispatcher spec
	async tryMarkDispatched(scheduleId: string): Promise<Date | null> {
		// ...
	}
}
```

This pattern is enforced by **lint rules and reviews** — any service
that imports `Repository<...>` directly fails review.

## 6. Migrations

### 6.1 Source location

Migrations live next to the API at
`apps/api/src/migrations/<timestamp>-<name>.ts`. Each migration:

- Implements TypeORM's `MigrationInterface` (`up()`, `down()`).
- Uses `QueryRunner` to issue raw SQL or schema-builder calls.
- Names follow `<unix-millis>-<description>.ts` so they sort
  chronologically.

### 6.2 Forward-only policy

Per Constitution Principle V, the platform is **forward-only**:

- Every migration adds columns / tables / indexes; never removes them
  in a way that breaks rollback to the previous release.
- Column drops happen in **two phases** across two releases — the
  first release stops writing to the column, the second release
  drops it.
- Renames also take two phases — add new column, dual-write,
  backfill, stop reading the old column, then drop in the next
  release.

### 6.3 Synchronize disabled in production

```ts
// database.config.ts (production branch)
synchronize: false,
migrationsRun: true,        // run migrations on startup
migrations: ['dist/migrations/*.js'],
```

`synchronize: true` is **only** allowed in `NODE_ENV=test` for fast
e2e suite startup. Production catches a misconfigured `synchronize`
at boot via `DatabaseInitService`.

### 6.4 Generate + run

```bash
# Generate a new migration from current entity diffs (run from apps/api/)
pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/<name>

# Apply pending migrations
pnpm typeorm migration:run -d typeorm.config.ts

# Revert the most recent migration (dev / staging only)
pnpm typeorm migration:revert -d typeorm.config.ts
```

CI runs `migration:run` against a fresh DB on every PR to catch
broken migrations before merge.

## 7. The `DatabaseInitService`

Runs once at application bootstrap:

1. Verifies the configured database is reachable.
2. Verifies the connection pool's user has the expected privileges.
3. (Test/dev only) Calls `synchronize` if requested.
4. (Production) Verifies migrations are caught up; refuses to start
   if pending migrations exist (operator must run them explicitly).
5. Logs schema version + driver + database name.

Refusing to start on pending migrations is deliberate — a freshly
deployed image with stale DB schema crashes loud rather than silently
serving requests with mismatched expectations.

## 8. Connection Pool

PostgreSQL pool defaults:

| Setting                   | Default | Override env var             |
| ------------------------- | ------- | ---------------------------- |
| `max` (connections)       | 20      | `DATABASE_POOL_MAX`          |
| `idleTimeoutMillis`       | 30 s    | `DATABASE_IDLE_TIMEOUT`      |
| `connectionTimeoutMillis` | 5 s     | `DATABASE_CONNECT_TIMEOUT`   |
| `statement_timeout`       | 30 s    | `DATABASE_STATEMENT_TIMEOUT` |

The Trigger.dev worker uses a **separate pool** (separate process →
separate pool) sized smaller (default 5) since it serves bursty,
long-running tasks rather than steady traffic.

SQLite drivers ignore pool settings — single-file, single-writer
semantics.

## 9. Transactions

Multi-step operations use the
`Repository.manager.transaction(...)` pattern:

```ts
return this.directoryRepository.manager.transaction(async (entityManager) => {
	const directory = await entityManager.save(Directory, dto);
	await entityManager.save(DirectoryMember, { ...owner, directoryId: directory.id });
	await entityManager.save(ActivityLog, { ...event, directoryId: directory.id });
	return directory;
});
```

Critical paths that must be atomic:

- **Directory creation** — DB row + initial member + activity-log entry
  in one transaction.
- **Membership change** — membership row + activity-log entry.
- **Schedule finalize** — generation-history update + activity-log
  entry + usage-ledger entry (when in usage mode).
- **Plugin settings update** — settings + activity-log entry.

The CAS-claim pattern in
[`directory-schedule-dispatcher`](../../agent-services/directory-schedule-dispatcher.md)
deliberately **doesn't** use a transaction — the single conditional
UPDATE is its own atomic unit and a transaction would just add
overhead.

## 10. The Bigint-Timestamp Pattern

Several columns store timestamps as `bigint` Unix-ms instead of
TypeORM's default `timestamptz`:

| Column                               | Why bigint                                                    |
| ------------------------------------ | ------------------------------------------------------------- |
| `cache_entries.expiresAt`            | Comparison hot path; integer compare faster than `now()` cast |
| `directory_schedules.nextRunAt` (ms) | Race-free CAS comparison without `Date` conversion edge cases |

The pattern surfaced as a recurring source of bugs: comparing
`Date` objects via `<` / `>` worked locally but failed under
ORM-driver coercion at certain pool refresh boundaries. Storing as
ms-ints sidesteps the issue. New columns should follow the pattern
when they participate in correctness-critical comparisons.

The bigint pattern is documented as a real lesson learned in the
[`scheduled-updates`](../features/scheduled-updates/spec.md) and
[`cache`](./cache.md) specs.

## 11. Soft Delete Strategy

Entities that need soft-delete (preserve audit trail, allow restore):

| Entity            | Strategy                                                    |
| ----------------- | ----------------------------------------------------------- |
| `Notification`    | `deletedAt` column; `where: { deletedAt: IsNull() }` filter |
| `ActivityLog`     | Hard delete only via cleanup task (90/180-day window)       |
| `DirectoryMember` | Hard delete (membership change is the audit trail)          |

Most entities **don't** soft-delete. Notifications + a couple of
others do because users explicitly recover them from a "Trash"
view. Domain rule: if there's no UI for "restore", don't soft-delete.

## 12. Indexes

Index inventory (informational — actual indexes are defined inline
on entities):

| Entity                         | Indexes                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `directories`                  | `(userId, slug)` unique, `(userId, status)`                        |
| `directory_schedules`          | `(nextRunAt) WHERE nextRunAt IS NOT NULL` partial, `(directoryId)` |
| `directory_generation_history` | `(directoryId, createdAt DESC)` for History tab pagination         |
| `activity_log`                 | `(userId, createdAt DESC)`, `(directoryId, createdAt DESC)`        |
| `cache_entries`                | `(expiresAt)` for sweep                                            |
| `api_keys`                     | `(hash)` unique                                                    |
| `notifications`                | `(userId, read, createdAt DESC)` covering for unread query         |
| `oauth_tokens`                 | `(userId, providerId)` unique                                      |

Adding indexes is migration-only — entity-level `@Index` decorators
work in `synchronize` mode but are discovered late in production.

## 13. Constitution Reconciliation

| Principle                   | How the database layer respects it                                                   |
| --------------------------- | ------------------------------------------------------------------------------------ |
| I — Plugin-first            | Plugins don't touch the DB; they go through services + facades.                      |
| II — Capability-driven      | Repositories are domain-named; capability resolution happens at facade level.        |
| III — Source-of-truth repos | The DB stores platform metadata; user content lives in their git repos.              |
| IV — Trigger.dev            | Worker shares the same DB module; separate connection pool.                          |
| V — Forward-only migrations | `synchronize: false` in production; two-phase column drops; CI runs migrations.      |
| VI — Tests                  | Each repository class has a `*.spec.ts` covering query semantics.                    |
| VII — Secret hygiene        | Encrypted columns (OAuth tokens, plugin secrets) decrypt only at read time.          |
| VIII — Plugin counts        | Counts are queries against `plugin_settings` / `user_plugins` / `directory_plugins`. |
| IX — Behaviour-first        | This spec describes observable DB behaviour.                                         |
| X — Backwards-compat        | Forward-only migrations + driver-agnostic queries keep schema stable.                |

## 14. References

- Source:
    - `packages/agent/src/database/`
    - `packages/agent/src/entities/`
    - `apps/api/src/migrations/`
    - `apps/api/typeorm.config.ts`
- Related specs:
    - [`cache`](./cache.md) (cache_entries table)
    - [`activity-log`](./activity-log.md)
    - [`subscriptions`](./subscriptions.md)
    - [`auth`](./auth.md) (token storage)
    - [`agent-services/distributed-task-lock`](../../agent-services/distributed-task-lock.md)
- User docs: [`docs/database/`](../../database/)
