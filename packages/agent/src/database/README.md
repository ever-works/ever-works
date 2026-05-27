# Database Configuration

This package provides TypeORM configuration with support for multiple database types (SQLite, PostgreSQL, MySQL) and different environments and app types.

## Usage

### Basic Setup

Import the `DatabaseModule` in your app module:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';

@Module({
    imports: [DatabaseModule],
    // ... other configuration
})
export class AppModule {}
```

### Environment-Specific Configuration

The database configuration automatically adapts based on environment variables:

#### Environment Variables

**Common Variables:**

- `APP_TYPE`: `'cli' | 'api'` - Determines the default database behavior
- `DATABASE_TYPE`: `'sqlite' | 'postgres' | 'mysql'` - Database type (default: sqlite)
- `DATABASE_LOGGING`: `'true' | 'false'` - Enable/disable SQL logging
- `NODE_ENV`: `'development' | 'production' | 'test'` - Environment mode

**SQLite Specific:**

- `DATABASE_PATH`: Explicit path to SQLite database file
- `DATABASE_IN_MEMORY`: `'true' | 'false'` - Force in-memory or file-based database

**PostgreSQL/MySQL/MariaDB Specific:**

- `DATABASE_HOST`: Database host (default: localhost)
- `DATABASE_PORT`: Database port (default: 5432 for PostgreSQL, 3306 for MySQL/MariaDB)
- `DATABASE_USERNAME`: Database username
- `DATABASE_PASSWORD`: Database password
- `DATABASE_NAME`: Database name

#### Default Behavior

| App Type | Environment | Default Database | Location                      |
| -------- | ----------- | ---------------- | ----------------------------- |
| CLI      | Any         | File             | `~/.ever-works/ever-works.db` |
| API      | Development | In-memory        | `:memory:`                    |
| API      | Production  | File             | `/tmp/ever-works-api.db`      |
| Any      | Test        | In-memory        | `:memory:`                    |

### Using the Configuration Factory (Recommended)

For more control, use the factory functions that leverage the same configuration system:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseConfigurations } from '@ever-works/agent/database';

@Module({
    imports: [
        // Use predefined configurations (RECOMMENDED)
        DatabaseConfigurations.cli(),
        DatabaseConfigurations.apiDevelopment(),
        DatabaseConfigurations.apiProduction('/path/to/database.db'),
        DatabaseConfigurations.test(),

        // PostgreSQL production
        DatabaseConfigurations.postgres({
            host: 'localhost',
            port: 5432,
            username: 'postgres',
            password: 'password',
            databaseName: 'ever_works_prod',
        }),

        // MySQL production
        DatabaseConfigurations.mysql({
            host: 'mysql.example.com',
            username: 'app_user',
            password: 'secure_password',
            databaseName: 'ever_works',
        }),

        TypeOrmModule.forFeature([Work, User]),
    ],
})
export class AppModule {}
```

**Note**: All factory configurations use the same `databaseConfig` function as `DatabaseModule`, ensuring consistency and avoiding duplication.

### Using the Repository

Inject the `WorkRepository` in your services:

```typescript
import { Injectable } from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';

@Injectable()
export class MyService {
    constructor(private readonly workRepository: WorkRepository) {}

    async createWork(data: Partial<Work>) {
        return await this.workRepository.create(data);
    }

    async findWork(slug: string) {
        return await this.workRepository.findBySlug(slug);
    }
}
```

## Migration from Mock Methods

The old static mock methods have been replaced:

```typescript
// Old way (removed)
Work.createMock(work);
const work = await Work.findMock(slug);

// New way
const work = await this.workRepository.create(workData);
const work = await this.workRepository.findBySlug(slug);
```

## Database Schema

The database will be automatically created with the following tables:

- `work` - Stores work information with unique constraint on (owner, slug)
- `user` - Stores user information (if using User entity)

### Work Table Constraints

The `work` table has a unique constraint on the combination of `owner` and `slug`, meaning:

- The same slug can be used by different owners
- Each owner can only have one work with a specific slug
- This allows for proper multi-tenant work management

### Schema Synchronization

The schema is automatically synchronized in development mode (`synchronize: true`). In production, you should use migrations instead of auto-synchronization.
