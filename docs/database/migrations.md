---
id: migrations
title: Database Migrations
sidebar_label: Migrations
sidebar_position: 3
---

# Database Migrations

Ever Works uses TypeORM migrations to manage database schema changes for production PostgreSQL and MySQL deployments. SQLite environments use schema synchronization instead.

## Migration Infrastructure

### TypeORM DataSource Configuration

The migration runner is configured in `apps/api/typeorm.config.ts`:

```typescript
export default new DataSource({
	...(databaseConfig() as any),
	migrationsRun: false,
	migrationsTableName: 'migrations',
	migrationsTransactionMode: 'all',
	migrations: [__dirname + '/src/migrations/**/*{.js,.ts}']
});
```

Key settings:

| Setting                     | Value                 | Purpose                                  |
| --------------------------- | --------------------- | ---------------------------------------- |
| `migrationsRun`             | `false`               | Migrations are not auto-run on startup   |
| `migrationsTableName`       | `migrations`          | Table tracking applied migrations        |
| `migrationsTransactionMode` | `all`                 | Each migration runs inside a transaction |
| `migrations`                | `src/migrations/**/*` | Glob pattern for migration files         |

The DataSource reuses the same `databaseConfig()` function used by the application, ensuring migrations target the same database.

## Migration Commands

All migration commands run from `apps/api/`:

```bash
# Generate a migration from entity changes
pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/MyMigration

# Run pending migrations
pnpm typeorm migration:run -d typeorm.config.ts

# Revert the most recent migration
pnpm typeorm migration:revert -d typeorm.config.ts
```

### Generate

The `migration:generate` command compares the current entity definitions against the database schema and produces a migration file with the necessary `ALTER TABLE` statements. The generated file is placed in `apps/api/src/migrations/`.

### Run

The `migration:run` command applies all pending migrations in order. Each migration runs inside a database transaction (`migrationsTransactionMode: 'all'`), so a failed migration is rolled back cleanly.

### Revert

The `migration:revert` command undoes the most recently applied migration by running its `down()` method.

## Multi-Database Support

The platform supports three database drivers, each with different migration strategies:

| Driver              | Migration Strategy                | When Used                 |
| ------------------- | --------------------------------- | ------------------------- |
| `better-sqlite3`    | Schema sync (`synchronize: true`) | Development, CLI, testing |
| `postgres`          | TypeORM migrations                | Production                |
| `mysql` / `mariadb` | TypeORM migrations                | Production (alternative)  |

### SQLite and Schema Sync

SQLite environments do not use migrations. Instead, schema synchronization is enabled:

```typescript
const baseConfig: any = {
	entities: ENTITIES,
	synchronize: config.database.autoMigrate(),
	logging: config.database.loggingEnabled()
};
```

The `synchronize` flag is controlled by the `DATABASE_AUTO_MIGRATE` environment variable. When `true`, TypeORM automatically creates and alters tables to match entity definitions on startup.

For CLI applications, the `DatabaseInitService` forces synchronization during module initialization:

```typescript
if (process.env.APP_TYPE === 'cli') {
	await this.dataSource.synchronize();
}
```

### PostgreSQL Configuration

PostgreSQL connections support both direct host/port configuration and URL-based configuration:

```typescript
// Host-based
{
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: '',
    database: 'ever_works',
}

// URL-based
{
    type: 'postgres',
    url: 'postgresql://user:pass@host:5432/ever_works',
}
```

SSL/TLS is supported via `DATABASE_SSL_MODE` and `DATABASE_CA_CERT` environment variables, which is required for managed database services like DigitalOcean Managed PostgreSQL.

### MySQL/MariaDB Configuration

MySQL and MariaDB share the same configuration pattern with different default ports:

```typescript
{
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'root',
    password: '',
    database: 'ever_works',
}
```

## Database Type Resolution

The `databaseConfig` function resolves the database type from environment variables with automatic normalization:

```typescript
let dbType = config.database.getType();

// Normalize sqlite variants to better-sqlite3
if (dbType === 'sqlite' || dbType === 'sqlite3') {
	dbType = 'better-sqlite3';
}
```

Supported `DATABASE_TYPE` values: `better-sqlite3`, `sqlite`, `sqlite3`, `postgres`, `mysql`, `mariadb`.

If an unknown type is provided, the configuration falls back to in-memory SQLite.

## Environment Variables

| Variable                | Purpose                         | Default                      |
| ----------------------- | ------------------------------- | ---------------------------- |
| `DATABASE_TYPE`         | Driver selection                | `better-sqlite3`             |
| `DATABASE_PATH`         | SQLite file path                | Platform-dependent           |
| `DATABASE_URL`          | Connection URL (postgres/mysql) | -                            |
| `DATABASE_HOST`         | Database host                   | `localhost`                  |
| `DATABASE_PORT`         | Database port                   | `5432` (pg) / `3306` (mysql) |
| `DATABASE_USERNAME`     | Database user                   | `postgres` / `root`          |
| `DATABASE_PASSWORD`     | Database password               | -                            |
| `DATABASE_NAME`         | Database name                   | `ever_works`                 |
| `DATABASE_AUTO_MIGRATE` | Enable schema sync              | -                            |
| `DATABASE_LOGGING`      | Enable query logging            | `false`                      |
| `DATABASE_IN_MEMORY`    | Use in-memory SQLite            | -                            |
| `DATABASE_SSL_MODE`     | Enable SSL/TLS                  | `false`                      |
| `DATABASE_CA_CERT`      | CA certificate (base64)         | -                            |

## Migration Workflow

### Development

1. Modify entity files in `packages/agent/src/entities/`.
2. If using SQLite (default for dev), schema sync handles changes automatically.
3. For PostgreSQL testing, generate a migration:
    ```bash
    cd apps/api
    DATABASE_TYPE=postgres DATABASE_URL=postgresql://... \
      pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddNewColumn
    ```
4. Review the generated migration file.
5. Run the migration against the target database:
    ```bash
    pnpm typeorm migration:run -d typeorm.config.ts
    ```

### Production

1. Migrations are applied manually or as part of the deployment pipeline.
2. The `RUN_MIGRATIONS` environment variable in the Docker entrypoint controls whether migrations run on container startup.
3. Migrations run inside transactions, so failed migrations do not leave the database in an inconsistent state.

## Cross-Database Compatibility

When writing entities and queries, be aware of cross-database differences:

| Concern                | SQLite                          | PostgreSQL            | MySQL                |
| ---------------------- | ------------------------------- | --------------------- | -------------------- |
| JSON columns           | `simple-json` (text serialized) | Native `json`/`jsonb` | Native `json`        |
| Timestamps             | Stored as text strings          | Native `timestamp`    | Native `datetime`    |
| Case sensitivity       | Case-insensitive by default     | Case-sensitive        | Depends on collation |
| Unique partial indexes | Not supported                   | Supported             | Not supported        |

The `TimestampColumn` decorator and `caseInsensitiveLike()` helper abstract these differences. When adding new queries, always use the `LOWER()` function for case-insensitive comparisons to ensure compatibility.
