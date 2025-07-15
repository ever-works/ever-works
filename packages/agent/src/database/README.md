# Database Configuration

This package provides TypeORM configuration with support for multiple database types (SQLite, PostgreSQL, MySQL, MariaDB) and different environments and app types.

## Usage

### Basic Setup

Import the `DatabaseModule` in your app module:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@packages/agent';

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
- `DATABASE_TYPE`: `'sqlite' | 'postgres' | 'mysql' | 'mariadb'` - Database type (default: sqlite)
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

| App Type | Environment | Default Database | Location |
|----------|-------------|------------------|----------|
| CLI | Any | File | `~/.ever-works/ever-works.db` |
| API | Development | In-memory | `:memory:` |
| API | Production | File | `/tmp/ever-works-api.db` |
| Any | Test | In-memory | `:memory:` |

### Using the Configuration Factory (Recommended)

For more control, use the factory functions that leverage the same configuration system:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseConfigurations } from '@packages/agent';

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
      databaseName: 'ever_works_prod'
    }),

    // MySQL production
    DatabaseConfigurations.mysql({
      host: 'mysql.example.com',
      username: 'app_user',
      password: 'secure_password',
      databaseName: 'ever_works'
    }),

    TypeOrmModule.forFeature([Directory, User]),
  ],
})
export class AppModule {}
```

**Note**: All factory configurations use the same `databaseConfig` function as `DatabaseModule`, ensuring consistency and avoiding duplication.

### Using the Repository

Inject the `DirectoryRepository` in your services:

```typescript
import { Injectable } from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent';

@Injectable()
export class MyService {
  constructor(private readonly directoryRepository: DirectoryRepository) {}

  async createDirectory(data: Partial<Directory>) {
    return await this.directoryRepository.create(data);
  }

  async findDirectory(slug: string) {
    return await this.directoryRepository.findBySlug(slug);
  }
}
```

## Migration from Mock Methods

The old static mock methods have been replaced:

```typescript
// Old way (removed)
Directory.createMock(directory);
const directory = await Directory.findMock(slug);

// New way
const directory = await this.directoryRepository.create(directoryData);
const directory = await this.directoryRepository.findBySlug(slug);
```

## Database Schema

The database will be automatically created with the following tables:

- `directory` - Stores directory information with unique constraint on (owner, slug)
- `user` - Stores user information (if using User entity)

### Directory Table Constraints

The `directory` table has a unique constraint on the combination of `owner` and `slug`, meaning:
- The same slug can be used by different owners
- Each owner can only have one directory with a specific slug
- This allows for proper multi-tenant directory management

### Schema Synchronization

The schema is automatically synchronized in development mode (`synchronize: true`). In production, you should use migrations instead of auto-synchronization.
