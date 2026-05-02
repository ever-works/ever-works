---
id: database-optimization
title: Database Optimization
sidebar_label: Database Optimization
sidebar_position: 10
---

# Database Optimization

The Ever Works platform uses TypeORM with support for multiple database backends (SQLite, PostgreSQL, MySQL/MariaDB). This guide covers query optimization patterns, indexing strategies, connection pooling, and N+1 prevention techniques used throughout the codebase.

## Architecture Overview

```
                     Application Layer
                           |
                  +--------v---------+
                  |  Repository Layer |   (e.g., WorkRepository)
                  +--------+---------+
                           |
                  +--------v---------+
                  |     TypeORM      |   Entity manager, query builder
                  +--------+---------+
                           |
           +---------------+----------------+
           |               |                |
    +------v------+  +-----v------+  +------v------+
    | better-     |  | PostgreSQL |  | MySQL /     |
    | sqlite3     |  |            |  | MariaDB     |
    +-------------+  +------------+  +-------------+
```

## Database Configuration

The platform supports multiple backends via the unified configuration in `packages/agent/src/database/database.config.ts`:

```typescript
// Database type selection
export const databaseConfig = registerAs('database', (): DatabaseConfig => {
	let dbType = config.database.getType();

	const baseConfig: any = {
		entities: ENTITIES,
		synchronize: config.database.autoMigrate(),
		logging: config.database.loggingEnabled()
	};

	// SSL support for production PostgreSQL
	if (config.database.sslMode()) {
		baseConfig.ssl = getTlsOptions(true, config.database.databaseCaCert());
	}

	// ... backend-specific configuration
});
```

Use predefined configurations for common environments:

```typescript
import { DatabaseConfigurations } from '@ever-works/agent/database';

// Development (in-memory SQLite)
DatabaseConfigurations.apiDevelopment();

// Production PostgreSQL
DatabaseConfigurations.postgres({
	host: 'db.example.com',
	port: 5432,
	username: 'app_user',
	password: process.env.DB_PASSWORD,
	databaseName: 'ever_works'
});

// Test (always in-memory)
DatabaseConfigurations.test();
```

## Repository Pattern

All database access goes through injectable repository services that wrap TypeORM:

```typescript
// packages/agent/src/database/repositories/work.repository.ts
@Injectable()
export class WorkRepository {
	constructor(
		@InjectRepository(Work)
		private readonly repo: Repository<Work>
	) {}

	async findByIdWithRelations(id: string): Promise<Work | null> {
		return this.repo.findOne({
			where: { id },
			relations: ['members', 'advancedPrompts']
		});
	}
}
```

The `DatabaseModule` registers all repositories and exports them for use across the application:

```typescript
@Module({
	imports: [
		ConfigModule.forFeature(databaseConfig),
		TypeOrmModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: (configService: ConfigService) => {
				return configService.get('database');
			},
			inject: [ConfigService]
		}),
		TypeOrmModule.forFeature(ENTITIES)
	],
	providers: [
		WorkRepository,
		UserRepository
		// ... all repositories
	],
	exports: [
		TypeOrmModule,
		WorkRepository,
		UserRepository
		// ... all repositories
	]
})
export class DatabaseModule {}
```

## N+1 Prevention

### Use Relations and Joins

Always load related entities in a single query rather than lazy-loading:

```typescript
// BAD: N+1 problem
const works = await repo.find();
for (const dir of works) {
	dir.members = await memberRepo.findByWorkId(dir.id); // N extra queries
}

// GOOD: Single query with join
const works = await repo.find({
	relations: ['members']
});
```

### Use QueryBuilder for Complex Joins

When you need selective fields or conditions on joined tables:

```typescript
const works = await this.repo
	.createQueryBuilder('work')
	.leftJoinAndSelect('work.members', 'member')
	.leftJoinAndSelect('work.advancedPrompts', 'prompts')
	.where('work.userId = :userId', { userId })
	.andWhere('member.role = :role', { role: 'admin' })
	.orderBy('work.createdAt', 'DESC')
	.take(20)
	.getMany();
```

### Select Only Needed Columns

Avoid loading full entities when only specific fields are required:

```typescript
// Select specific columns to reduce payload size
const summary = await this.repo
	.createQueryBuilder('work')
	.select(['work.id', 'work.name', 'work.status'])
	.where('work.userId = :userId', { userId })
	.getMany();
```

## Indexing Strategy

### Entity Index Definitions

Define indexes directly on entities using TypeORM decorators:

```typescript
@Entity('works')
@Index(['userId', 'status']) // Composite index
@Index(['createdAt']) // Sort index
@Index(['name'], { unique: false }) // Search index
export class Work {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	@Index() // Single-column index
	userId: string;

	@Column({ default: 'draft' })
	status: string;

	@CreateDateColumn()
	createdAt: Date;
}
```

### Recommended Indexes by Table

| Table                | Index Columns               | Purpose                         |
| -------------------- | --------------------------- | ------------------------------- |
| `works`        | `(userId, status)`          | List user works by status |
| `work_members`  | `(workId, userId)`     | Membership lookups              |
| `refresh_tokens`     | `(token)`                   | Token validation                |
| `refresh_tokens`     | `(userId, revoked)`         | Active token lookup             |
| `generation_history` | `(workId, createdAt)`  | Generation history timeline     |
| `notifications`      | `(userId, read, createdAt)` | Unread notification feed        |

## Connection Pooling (PostgreSQL)

For production PostgreSQL deployments, configure connection pooling:

```typescript
DatabaseConfigurations.postgres({
	host: process.env.DATABASE_HOST,
	port: 5432,
	username: process.env.DATABASE_USERNAME,
	password: process.env.DATABASE_PASSWORD,
	databaseName: process.env.DATABASE_NAME
});

// Additional TypeORM pool options in database.config.ts
const poolConfig = {
	extra: {
		max: 20, // Maximum pool size
		min: 5, // Minimum pool size
		idleTimeoutMillis: 30000, // Close idle connections after 30s
		connectionTimeoutMillis: 5000
	}
};
```

### Pool Sizing Guidelines

| Deployment Size  | Max Connections | Min Connections | Notes                     |
| ---------------- | --------------- | --------------- | ------------------------- |
| Development      | 5               | 1               | SQLite, single connection |
| Small (1-2 pods) | 10              | 2               | Shared DB server          |
| Medium (3-5)     | 20              | 5               | Dedicated DB server       |
| Large (5+)       | 30-50           | 10              | Use PgBouncer as proxy    |

## Query Optimization Patterns

### Pagination

Always use cursor-based or offset pagination for list endpoints:

```typescript
async findPaginated(userId: string, page: number, limit: number) {
    return this.repo.findAndCount({
        where: { userId },
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
    });
}
```

### Batch Operations

Use TypeORM batch methods for bulk inserts/updates:

```typescript
// Batch insert
await this.repo.createQueryBuilder().insert().into(Notification).values(notifications).execute();

// Batch update
await this.repo
	.createQueryBuilder()
	.update(RefreshToken)
	.set({ revoked: true, revokedReason: reason })
	.where('userId = :userId', { userId })
	.execute();
```

### Conditional Logging

Enable SQL query logging only in development:

```bash
# .env
DATABASE_LOGGING=true    # Enable TypeORM SQL logging
```

## Best Practices

1. **Use the Repository layer** -- Never access `DataSource` or `EntityManager` directly from controllers or services. Always go through the typed repository classes.

2. **Prefer SQLite for development** -- The in-memory SQLite configuration starts instantly and requires zero setup.

3. **Disable synchronize in production** -- Set `DATABASE_AUTOMIGRATE=false` and use proper migrations instead.

4. **Index foreign keys** -- Every `@ManyToOne` relationship column should have an index.

5. **Monitor slow queries** -- Enable `DATABASE_LOGGING=true` temporarily to identify slow queries, then add indexes.

## Troubleshooting

### "SQLITE_BUSY" errors

SQLite uses file-level locking. In development with multiple processes, switch to PostgreSQL or ensure only one API instance runs.

### Connection pool exhaustion

Symptoms: requests hang, then timeout. Check `max` pool setting and look for unreleased connections (missing `await` on queries, long transactions).

### Migration failures

If `synchronize: true` fails on schema changes, generate and run a proper migration:

```bash
cd apps/api
pnpm typeorm migration:generate -d typeorm.config.ts
pnpm typeorm migration:run -d typeorm.config.ts
```

## Related Documentation

- [Configuration Management](../architecture/configuration-management.md) -- Database environment variables
- [Module System](../architecture/module-system.md) -- DatabaseModule integration
- [Performance Tuning](./performance-tuning.md) -- Overall API performance
- [Kubernetes Deployment](../devops/kubernetes.md) -- Database in containerized deployments
