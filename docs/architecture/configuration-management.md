---
id: configuration-management
title: Configuration Management
sidebar_label: Configuration Management
sidebar_position: 13
---

# Configuration Management

The Ever Works platform uses a layered configuration system that combines environment variables, NestJS ConfigModule, typed config objects, and runtime config accessors. This guide covers how configuration flows from `.env` files through to application code.

## Configuration Architecture

```
    .env file
       |
    +--v--+
    | dotenv |  Loads vars into process.env
    +--+--+
       |
    +--v----------------+        +--v------------------+
    | NestJS ConfigModule|        | Typed config objects |
    | (registerAs)       |        | (packages/agent/src/ |
    +--+----------------+         |  config/index.ts)    |
       |                          +--+------------------+
       |                             |
    +--v--+                       +--v--+
    | ConfigService.get()  |      | config.database.getType() |
    | (injected via DI)    |      | config.trigger.isEnabled() |
    +------+               +------+
```

## Environment Variable Loading

Environment variables are loaded at the very start of the bootstrap process:

```typescript
// apps/api/src/main.ts
import { configDotenv } from 'dotenv';

async function bootstrap() {
    configDotenv({ path: path.resolve(process.cwd(), '.env') });

    initSentry();
    initPostHog();

    const app = await NestFactory.create(ApiModule);
    // ...
}
```

## Typed Configuration Objects

### API Constants

The API application defines its constants in `apps/api/src/config/constants.ts`:

```typescript
export const jwtConstants = {
    secret: () => process.env.JWT_SECRET || 'aesh4Dai_secret_key_here',
    accessTokenExpiration: (): any => {
        const expiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION;
        return expiration === 'never' ? undefined : expiration || '7d';
    },
    refreshTokenExpiration: () => {
        const days = process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS;
        return days === 'never' ? -1 : parseInt(days || '14', 10);
    },
    isTokenExpirationDisabled: () => {
        return process.env.JWT_DISABLE_EXPIRATION === 'true';
    },
};

export const authConstants = {
    bcryptSaltRounds: 10,
    refreshTokenLength: 32,
    refreshTokenCleanupDays: 30,
};
```

### Agent Package Config

The core agent package has its own typed config in `packages/agent/src/config/index.ts`:

```typescript
export const config = {
    getEnvironment() {
        return process.env.NODE_ENV;
    },

    trigger: {
        isEnabled() { return process.env.TRIGGER_ENABLED === 'true'; },
        getSecretKey() { return process.env.TRIGGER_SECRET_KEY; },
        getApiUrl() { return process.env.TRIGGER_API_URL || 'https://api.trigger.dev'; },
        shouldUseTrigger() {
            return this.isEnabled() && Boolean(this.getInternalSecret());
        },
    },

    database: {
        getType() { return process.env.DATABASE_TYPE || 'better-sqlite3'; },
        isSqlite() { return this.getType()?.includes('sqlite'); },
        getUrl() { return process.env.DATABASE_URL; },
        autoMigrate() { return process.env.DATABASE_AUTOMIGRATE !== 'false'; },
        loggingEnabled() { return process.env.DATABASE_LOGGING === 'true'; },
        sslMode() { return process.env.DATABASE_SSL_MODE === 'true'; },
        // ... more accessors
    },

    sentry: {
        getDsn() { return process.env.SENTRY_DSN; },
    },

    posthog: {
        getApiKey() { return process.env.POSTHOG_API_KEY; },
        getHost() { return process.env.POSTHOG_HOST; },
    },

    subscriptions: {
        isEnabled() { return process.env.SUBSCRIPTIONS_ENABLED === 'true'; },
        getDefaultPlanCode() { return process.env.SUBSCRIPTIONS_DEFAULT_PLAN || 'free'; },
    },
};
```

### ConfigModule with registerAs

The database configuration uses NestJS `registerAs` for DI-based configuration:

```typescript
// packages/agent/src/database/database.config.ts
import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
    const dbType = config.database.getType();

    const baseConfig = {
        entities: ENTITIES,
        synchronize: config.database.autoMigrate(),
        logging: config.database.loggingEnabled(),
    };

    if (dbType === 'postgres') {
        return {
            ...baseConfig,
            type: 'postgres',
            host: config.database.getHost() || 'localhost',
            port: parseInt(config.database.getPort() || '5432'),
            username: config.database.getUsername() || 'postgres',
            password: config.database.getPassword() || '',
            database: config.database.getDatabaseName() || 'ever_works',
        };
    }

    // ... other backends
});
```

Used via `ConfigService` in module factories:

```typescript
TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    useFactory: (configService: ConfigService) => {
        return configService.get('database');
    },
    inject: [ConfigService],
}),
```

## Complete Environment Variable Reference

### Core Application

| Variable                   | Default                | Description                          |
|----------------------------|------------------------|--------------------------------------|
| `NODE_ENV`                 | `development`          | Runtime environment                  |
| `PORT`                     | `3100`                 | API server port                      |
| `WEB_URL`                  | `http://localhost:3000`| Frontend URL                         |
| `ALLOWED_ORIGINS`          | `http://localhost:3000`| CORS allowed origins (comma-sep)     |
| `HTTP_DEBUG`               | `false`                | Enable request/response logging      |

### Authentication

| Variable                              | Default   | Description                        |
|---------------------------------------|----------|------------------------------------|
| `JWT_SECRET`                          | fallback  | JWT signing secret                 |
| `JWT_ACCESS_TOKEN_EXPIRATION`         | `7d`      | Access token TTL (`never` to disable)|
| `JWT_REFRESH_TOKEN_EXPIRATION_DAYS`   | `14`      | Refresh token TTL in days          |
| `JWT_DISABLE_EXPIRATION`              | `false`   | Disable all token expiration       |

### Database

| Variable              | Default          | Description                          |
|-----------------------|------------------|--------------------------------------|
| `DATABASE_TYPE`       | `better-sqlite3` | `better-sqlite3`, `postgres`, `mysql`|
| `DATABASE_URL`        | --               | Full connection URL (overrides host) |
| `DATABASE_HOST`       | `localhost`      | Database host                        |
| `DATABASE_PORT`       | `5432` / `3306`  | Database port                        |
| `DATABASE_USERNAME`   | `postgres`       | Database user                        |
| `DATABASE_PASSWORD`   | --               | Database password                    |
| `DATABASE_NAME`       | `ever_works`     | Database name                        |
| `DATABASE_PATH`       | --               | SQLite file path                     |
| `DATABASE_IN_MEMORY`  | `false`          | Use in-memory SQLite                 |
| `DATABASE_AUTOMIGRATE`| `true`           | Auto-sync schema (disable in prod)   |
| `DATABASE_LOGGING`    | `false`          | Enable SQL query logging             |
| `DATABASE_SSL_MODE`   | `false`          | Enable SSL for PostgreSQL            |
| `DATABASE_CA_CERT`    | --               | CA certificate for SSL               |

### OAuth Providers

| Variable               | Default | Description                          |
|------------------------|---------|--------------------------------------|
| `GH_CLIENT_ID`        | --      | GitHub OAuth app client ID           |
| `GH_CLIENT_SECRET`    | --      | GitHub OAuth app client secret       |
| `GH_CALLBACK_URL`     | auto    | GitHub OAuth callback URL            |
| `GOOGLE_CLIENT_ID`    | --      | Google OAuth client ID               |
| `GOOGLE_CLIENT_SECRET`| --      | Google OAuth client secret           |
| `GOOGLE_CALLBACK_URL` | auto    | Google OAuth callback URL            |

### Monitoring

| Variable            | Default                   | Description                  |
|---------------------|---------------------------|------------------------------|
| `SENTRY_DSN`        | --                        | Sentry project DSN           |
| `POSTHOG_API_KEY`   | --                        | PostHog project API key      |
| `POSTHOG_HOST`      | `https://app.posthog.com` | PostHog instance URL         |

### Background Tasks

| Variable                   | Default                     | Description                   |
|----------------------------|-----------------------------|-------------------------------|
| `TRIGGER_ENABLED`          | `false`                     | Enable Trigger.dev            |
| `TRIGGER_SECRET_KEY`       | --                          | Trigger.dev API key           |
| `TRIGGER_API_URL`          | `https://api.trigger.dev`   | Trigger.dev API URL           |
| `TRIGGER_INTERNAL_API_URL` | --                          | Internal API base URL         |
| `TRIGGER_INTERNAL_SECRET`  | --                          | Secret for internal API calls |

## Per-Environment Configuration

Use the `DatabaseConfigurations` factory for environment-specific setups:

```typescript
// Development
DatabaseConfigurations.apiDevelopment();

// Production
DatabaseConfigurations.postgres({ url: process.env.DATABASE_URL });

// Testing
DatabaseConfigurations.test();  // Always in-memory SQLite
```

## Secrets Management

### Development

Use `.env` files (never committed to git):

```bash
# .env
JWT_SECRET=my-dev-secret
GH_CLIENT_SECRET=github-dev-secret
DATABASE_PASSWORD=local-db-password
```

### Production

Use platform-native secrets:

```bash
# Kubernetes
kubectl create secret generic api-secrets \
    --from-literal=JWT_SECRET=$JWT_SECRET \
    --from-literal=DATABASE_PASSWORD=$DB_PASSWORD

# Docker Compose
services:
  api:
    env_file: .env.production
```

## Best Practices

1. **Never hardcode secrets** -- Always use environment variables. The JWT default fallback is only for development.

2. **Use typed accessors** -- Prefer `config.database.getType()` over raw `process.env.DATABASE_TYPE` for type safety and default values.

3. **Validate at startup** -- Critical configuration should be validated in `onModuleInit` or `onApplicationBootstrap`.

4. **Separate concerns** -- API-specific config stays in `apps/api/src/config/`, shared config goes in `packages/agent/src/config/`.

5. **Document all variables** -- Every new environment variable should be added to the reference table above.

## Troubleshooting

### Config values not loading

Ensure `configDotenv()` is called before `NestFactory.create()`. The `.env` file path is resolved from `process.cwd()`.

### Database not connecting

Check that `DATABASE_TYPE` matches one of the supported values: `better-sqlite3`, `sqlite`, `postgres`, `mysql`, `mariadb`.

### JWT secret warning

If you see "using default secret" in logs, `JWT_SECRET` is not set. This is acceptable in development but must be set in production.

## Related Documentation

- [Module System](./module-system.md) -- ConfigModule integration
- [Database Optimization](../advanced/database-optimization.md) -- Database configuration details
- [Security Hardening](../advanced/security-hardening.md) -- Secret management
- [Kubernetes Deployment](../devops/kubernetes.md) -- Secrets in containers
