---
id: database
title: Database
sidebar_label: Database
sidebar_position: 9
---

# Database

The Ever Works Platform uses TypeORM for database access and supports multiple database engines.

## Supported Databases

| Engine | Use Case | Driver |
|--------|----------|--------|
| **SQLite** | Development, single-user (default) | `better-sqlite3` |
| **PostgreSQL** | Production recommended | `pg` |
| **MySQL / MariaDB** | Production alternative | `mysql2` |

SQLite is the default for development. It supports both in-memory mode (fastest, no persistence) and file-based storage.

## Configuration

### SQLite (Default)

```bash
DATABASE_TYPE=sqlite

# In-memory database (development default)
DATABASE_IN_MEMORY=true

# Or file-based storage
# DATABASE_PATH=/path/to/database.db
```

### PostgreSQL

```bash
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=your_password
DATABASE_NAME=ever_works

# Or use a connection URL
# DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

### MySQL

```bash
DATABASE_TYPE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USERNAME=root
DATABASE_PASSWORD=your_password
DATABASE_NAME=ever_works

# Or use a connection URL
# DATABASE_URL=mysql://user:pass@host:3306/dbname
```

### Common Options

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_LOGGING` | `false` | Enable SQL query logging |
| `DATABASE_SSL_MODE` | `false` | Enable SSL/TLS for connections |
| `DATABASE_CA_CERT` | — | CA certificate for SSL connections |

## Entities

The platform defines 16 TypeORM entities:

| Entity | Table | Description |
|--------|-------|-------------|
| **Directory** | `directories` | Core directory with name, slug, description, generation status, deployment state, repository config, community PR settings |
| **User** | `users` | User account with email, password, subscription info |
| **DirectoryMember** | `directory_members` | Many-to-many relationship between users and directories with roles (owner, manager, editor, viewer) |
| **DirectoryGenerationHistory** | `directory_generation_history` | Tracks each generation run: method, status, metrics, item counts, duration |
| **DirectorySchedule** | `directory_schedules` | Scheduled update configuration: cadence, status, billing mode, failure tracking |
| **DirectoryAdvancedPrompts** | `directory_advanced_prompts` | Per-directory custom prompts for pipeline steps |
| **OAuthToken** | `oauth_tokens` | OAuth provider tokens with access/refresh tokens and metadata |
| **RefreshToken** | `refresh_tokens` | JWT refresh tokens with family-based rotation, revocation tracking, and device info |
| **Notification** | `notifications` | User notifications with type, category, read/dismissed state, expiration |
| **SubscriptionPlan** | `subscription_plans` | Plan definitions: max directories, allowed cadences, pricing |
| **UserSubscription** | `user_subscriptions` | Active subscriptions: plan, status, billing provider (Stripe/manual), period info |
| **UsageLedgerEntry** | `usage_ledger_entries` | Usage tracking: trigger type, billing mode, units, amount, settlement status |
| **CacheEntry** | `cache_entries` | Key-value cache entries with TTL expiration |
| **PluginEntity** | `plugins` | Plugin registry: metadata, status, global settings |
| **UserPluginEntity** | `user_plugins` | Per-user plugin settings and API keys |
| **DirectoryPluginEntity** | `directory_plugins` | Per-directory plugin configuration and overrides |

## Auto-Sync

TypeORM's `synchronize` option is controlled by the `DATABASE_AUTOMIGRATE` environment variable (defaults to `true`). When enabled, it automatically creates and updates database tables to match entity definitions. **Set `DATABASE_AUTOMIGRATE=false` in production** and use migrations instead.

## Docker Compose

The default `compose.yaml` uses SQLite with file-based storage:

```yaml
services:
  ever-works-api:
    environment:
      - DATABASE_TYPE=sqlite
      - DATABASE_PATH=/app/apps/api/data/database.db
    volumes:
      - api_data:/app/apps/api/data
```

For PostgreSQL in Docker, add a PostgreSQL service and update the API environment:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: ever_works
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - pg_data:/var/lib/postgresql/data

  ever-works-api:
    environment:
      - DATABASE_TYPE=postgres
      - DATABASE_HOST=postgres
      - DATABASE_PORT=5432
      - DATABASE_USERNAME=postgres
      - DATABASE_PASSWORD=password
      - DATABASE_NAME=ever_works
```
