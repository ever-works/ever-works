---
id: repositories
title: Database Repositories
sidebar_label: Repositories
sidebar_position: 2
---

# Database Repositories

Ever Works uses the repository pattern to encapsulate database access logic. Each repository wraps a TypeORM `Repository<T>` and exposes domain-specific query methods. All repositories are defined in `packages/agent/src/database/repositories/` and registered in the `DatabaseModule`.

## Repository Registry

The `DatabaseModule` provides and exports 12 repositories:

| Repository                        | Entity                  | Key Responsibilities                                    |
| --------------------------------- | ----------------------- | ------------------------------------------------------- |
| `WorkRepository`                  | `Work`                  | CRUD, search, member-aware queries, generation tracking |
| `WorkAdvancedPromptsRepository`   | `WorkAdvancedPrompts`   | Per-work custom prompt overrides                        |
| `WorkMemberRepository`            | `WorkMember`            | Role-based membership management                        |
| `UserRepository`                  | `User`                  | User CRUD, email lookup, CLI local user                 |
| `RefreshTokenRepository`          | `RefreshToken`          | Token creation, rotation, revocation                    |
| `OAuthTokenRepository`            | `OAuthToken`            | OAuth token storage per provider                        |
| `WorkGenerationHistoryRepository` | `WorkGenerationHistory` | Generation run tracking                                 |
| `SubscriptionPlanRepository`      | `SubscriptionPlan`      | Plan lookup and upsert                                  |
| `UserSubscriptionRepository`      | `UserSubscription`      | Subscription lifecycle                                  |
| `WorkScheduleRepository`          | `WorkSchedule`          | Schedule CRUD and status updates                        |
| `UsageLedgerRepository`           | `UsageLedgerEntry`      | Usage-based billing entries                             |
| `NotificationRepository`          | `Notification`          | Notification CRUD with deduplication                    |

## Repository Pattern

Each repository follows a consistent structure:

```typescript
@Injectable()
export class ExampleRepository {
	constructor(
		@InjectRepository(ExampleEntity)
		private readonly repository: Repository<ExampleEntity>
	) {}

	// Domain-specific methods...
}
```

Repositories are `@Injectable()` NestJS providers that receive the TypeORM repository via `@InjectRepository()`. This enables dependency injection throughout the application while keeping raw TypeORM access encapsulated.

## WorkRepository (Detailed)

The `WorkRepository` is the most complex repository, handling cross-database search, member-aware access, and generation state tracking.

### Cross-Database Case-Insensitive Search

A key design challenge is supporting case-insensitive search across SQLite, PostgreSQL, and MySQL. The repository uses a `LOWER()` function wrapper:

```typescript
function caseInsensitiveLike(search: string) {
	return Raw((alias) => `LOWER(${alias}) LIKE LOWER(:search)`, { search: `%${search}%` });
}
```

This produces compatible SQL across all three database drivers.

### Search Query Building

The `buildWhereConditions` private method constructs OR-based search conditions across `name`, `description`, and `slug` fields:

```typescript
const searchConditions = [
	{ name: caseInsensitiveLike(sanitizedSearch) },
	{ description: caseInsensitiveLike(sanitizedSearch) },
	{ slug: caseInsensitiveLike(sanitizedSearch) }
];
```

When a `userId` is also provided, each search condition is combined with the user filter.

### Member-Aware Queries

The `findAllAccessible()` method uses TypeORM's `QueryBuilder` to combine owned and member-accessible works:

```typescript
async findAllAccessible(options?: {
    userId: string;
    memberWorkIds?: string[];
    limit?: number;
    offset?: number;
    search?: string;
}): Promise<Work[]>
```

This method builds a WHERE clause using `Brackets` to create an OR condition: either the user is the creator (`work.userId = :userId`) or the work is in the user's membership list (`work.id IN (:...memberWorkIds)`).

### Generation State Methods

| Method                                 | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `updateGenerateStatus(id, status)`     | Updates status JSON, deduplicates warnings, sets `generationProgressedAt` |
| `recordGenerationStartTime(id, date)`  | Sets start time, clears finish time                                       |
| `recordGenerationFinishTime(id, date)` | Sets completion timestamp                                                 |
| `getUnfinishedGenerations(olderThan)`  | Finds stalled generations for cleanup                                     |

### Feature-Specific Queries

| Method                               | Purpose                             |
| ------------------------------------ | ----------------------------------- |
| `findWithWebsiteAutoUpdateEnabled()` | Works needing template sync         |
| `findWithCommunityPrEnabled()`       | Works with community PR processing  |
| `findWithComparisonsEnabled()`       | Works generating comparison content |
| `findByIdWithMembers(id)`            | Loads work with full member chain   |

### Standard CRUD

| Method                                      | Behavior                                          |
| ------------------------------------------- | ------------------------------------------------- |
| `create(dto, user)`                         | Creates work, throws if slug+owner already exists |
| `createOrUpdate(dto, user)`                 | Upserts based on owner+slug match                 |
| `findById(id)`                              | Loads with `user` relation                        |
| `findByOwnerAndSlug({userId, owner, slug})` | Exact match lookup                                |
| `findAll(options)`                          | Paginated list with optional search               |
| `countAll(options)`                         | Count with same filtering                         |
| `update(id, data)`                          | Partial update, returns refreshed entity          |
| `delete(id)`                                | Delete by ID                                      |
| `deleteBySlug(slug, userId)`                | Delete by slug and user                           |
| `exists(slug, userId)`                      | Boolean existence check                           |
| `increment(id, column, value)`              | Atomic column increment                           |

## UserRepository

Provides user CRUD with email-based lookup:

| Method                                  | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `findByEmail(email)`                    | Unique email lookup                                  |
| `findById(id)`                          | Standard find                                        |
| `create(data)`                          | Create new user                                      |
| `update(id, data)`                      | Partial update                                       |
| `createOrGetLocalUser(email, username)` | For CLI usage -- creates a non-persistent local user |

## WorkGenerationHistoryRepository

Tracks generation runs with typed create and update parameters:

```typescript
interface CreateHistoryParams {
	workId: string;
	userId?: string;
	generationMethod?: GenerationMethod;
	triggeredBy: 'user' | 'schedule' | 'api';
	triggerRunId?: string;
	scheduleId?: string;
	parameters?: Record<string, any>;
}
```

Key methods: `create(params)`, `updateStatus(id, status)`, `updateMetrics(id, metrics)`, `findByWork(workId)`.

## SubscriptionPlanRepository

Manages subscription plans with upsert capability:

| Method             | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `findByCode(code)` | Lookup by plan code (`free`, `standard`, `premium`) |
| `findAllActive()`  | Get all active plans                                |
| `upsert(plan)`     | Create or update plan by code                       |

## Module Wiring

The `DatabaseModule` imports TypeORM configuration and registers all entities and repositories:

```typescript
@Module({
	imports: [
		ConfigModule.forFeature(databaseConfig),
		TypeOrmModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: (configService: ConfigService) => configService.get('database'),
			inject: [ConfigService]
		}),
		TypeOrmModule.forFeature(ENTITIES)
	],
	providers: [WorkRepository, UserRepository /* ...10 more */],
	exports: [TypeOrmModule, WorkRepository, UserRepository /* ...10 more */]
})
export class DatabaseModule {}
```

Both `TypeOrmModule` and all repositories are exported, allowing any importing module to inject either the custom repositories or raw TypeORM repositories.

## Database Configuration Factory

The `DatabaseConfigurations` factory in `database-config.factory.ts` provides presets for common environments:

| Preset           | Database         | Details                                     |
| ---------------- | ---------------- | ------------------------------------------- |
| `cli`            | SQLite file      | Persistent at `~/.ever-works/ever-works.db` |
| `apiDevelopment` | SQLite in-memory | With logging enabled                        |
| `apiProduction`  | SQLite file      | Persistent at configurable path             |
| `test`           | SQLite in-memory | Logging disabled                            |
| `postgres`       | PostgreSQL       | Supports URL or host/port/credentials       |
| `mysql`          | MySQL/MariaDB    | Supports URL or host/port/credentials       |

Each preset uses `createDatabaseModuleWithEnv()` to set environment variables before returning the `DatabaseModule`.

## Database Initialization

The `DatabaseInitService` implements `OnModuleInit` to ensure the database is ready:

1. Checks if the `DataSource` is initialized; initializes if not.
2. For CLI mode (`APP_TYPE=cli`), forces schema synchronization to ensure all tables exist.

This is necessary because CLI applications use a persistent SQLite database that may not have the latest schema.
