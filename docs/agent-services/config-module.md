---
id: config-module
title: Agent Configuration Module
sidebar_label: Configuration
sidebar_position: 10
---

# Agent Configuration Module

The agent configuration module provides a centralized, typed interface for accessing all environment-driven configuration within the `@ever-works/agent` package. It reads from `process.env` and provides sensible defaults.

**Source:** `packages/agent/src/config/index.ts`

## Overview

The `config` object is a plain JavaScript object with nested namespaces, each exposing getter methods that read environment variables at call time. This approach avoids caching stale values and ensures configuration changes are reflected immediately.

```typescript
import { config } from '@src/config';

const dbType = config.database.getType();
const isSchedulingEnabled = config.subscriptions.scheduledUpdatesEnabled();
```

## Configuration Namespaces

### Root-Level Configuration

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getEnvironment()` | `string` | Value of `NODE_ENV` |
| `getAppType()` | `'cli' \| 'api'` | Application type from `APP_TYPE` (default: `'api'`) |
| `isCli()` | `boolean` | Whether running as CLI application |

### Trigger.dev Configuration

Controls the background task dispatcher (Trigger.dev integration).

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `trigger.isEnabled()` | `TRIGGER_ENABLED` | `false` | Master toggle |
| `trigger.getSecretKey()` | `TRIGGER_SECRET_KEY` | -- | Authentication key |
| `trigger.getApiUrl()` | `TRIGGER_API_URL` | `https://api.trigger.dev` | API endpoint |
| `trigger.getMachine()` | `TRIGGER_MACHINE` | `undefined` | Machine identifier |
| `trigger.getInternalBaseUrl()` | `TRIGGER_INTERNAL_API_URL` | -- | Internal API URL |
| `trigger.getInternalSecret()` | `TRIGGER_INTERNAL_SECRET` | -- | Internal secret |
| `trigger.shouldUseTrigger()` | Composite | `false` | Returns `true` only if both enabled and internal secret are set |

```typescript
if (config.trigger.shouldUseTrigger()) {
    // Dispatch to Trigger.dev
} else {
    // Fall back to in-process execution
}
```

### Database Configuration

Supports both SQLite and PostgreSQL through TypeORM.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `database.getType()` | `DATABASE_TYPE` | `'better-sqlite3'` | Database driver type |
| `database.isSqlite()` | Derived | `true` | Whether using SQLite |
| `database.getUrl()` | `DATABASE_URL` | -- | Connection URL (for PostgreSQL) |
| `database.getHost()` | `DATABASE_HOST` | -- | Database host |
| `database.getPort()` | `DATABASE_PORT` | -- | Database port |
| `database.autoMigrate()` | `DATABASE_AUTOMIGRATE` | `true` | Run migrations on startup |
| `database.loggingEnabled()` | `DATABASE_LOGGING` | `false` | Enable SQL query logging |
| `database.sslMode()` | `DATABASE_SSL_MODE` | `false` | Enable SSL for connections |
| `database.databaseCaCert()` | `DATABASE_CA_CERT` | -- | CA certificate for SSL |
| `database.getPath()` | `DATABASE_PATH` | -- | File path (for SQLite) |
| `database.getInMemory()` | `DATABASE_IN_MEMORY` | `false` | Use in-memory SQLite |
| `database.getUsername()` | `DATABASE_USERNAME` | -- | Database username |
| `database.getPassword()` | `DATABASE_PASSWORD` | -- | Database password |
| `database.getDatabaseName()` | `DATABASE_NAME` | -- | Database name |

### GitHub Configuration

Legacy GitHub-specific settings (for backward compatibility with direct GitHub API usage).

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `github.getApiKey()` | `GH_APIKEY` | -- | GitHub API key |
| `github.getOwner()` | `GH_OWNER` | -- | Default GitHub owner/organization |

### Git Configuration

Default committer identity for Git operations.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `git.getName()` | `GIT_NAME` | -- | Default committer name |
| `git.getEmail()` | `GIT_EMAIL` | -- | Default committer email |

### Sentry Configuration

Error monitoring and tracking.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `sentry.getDsn()` | `SENTRY_DSN` | -- | Sentry Data Source Name |
| `sentry.getProjectId()` | `SENTRY_PROJECT_ID` | -- | Sentry project identifier |

### PostHog Configuration

Product analytics and feature flags.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `posthog.getApiKey()` | `POSTHOG_API_KEY` | -- | PostHog project API key |
| `posthog.getHost()` | `POSTHOG_HOST` | -- | PostHog instance URL |

### Subscriptions Configuration

Controls scheduled updates, plan limits, and billing.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `subscriptions.isEnabled()` | `SUBSCRIPTIONS_ENABLED` | `false` | Master toggle for subscription features |
| `subscriptions.scheduledUpdatesEnabled()` | `SCHEDULED_UPDATES_ENABLED` | `true` | Enable directory scheduling |
| `subscriptions.getDispatchIntervalMinutes()` | `SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES` | `5` | Cron dispatch interval |
| `subscriptions.getMaxBatch()` | `SCHEDULED_UPDATES_MAX_BATCH` | `25` | Max schedules per dispatch cycle |
| `subscriptions.getDefaultPlanCode()` | `SUBSCRIPTIONS_DEFAULT_PLAN` | `'free'` | Default subscription plan |
| `subscriptions.getMaxFailureBeforePause()` | `SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE` | `3` | Failures before auto-pause |
| `subscriptions.getPayPerUsePriceCents()` | `PAY_PER_USE_PRICE_USD` | `500` (cents) | Per-run cost in cents (parsed from USD) |

```typescript
// Example: Check if scheduling is available
if (config.subscriptions.scheduledUpdatesEnabled()) {
    const maxBatch = config.subscriptions.getMaxBatch();
    await dispatcher.dispatchDue(maxBatch);
}
```

### Website Template Configuration

Controls automatic website template updates.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `websiteTemplate.autoUpdateEnabled()` | `WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED` | `true` | Auto-update templates |
| `websiteTemplate.getBetaBranch()` | `WEBSITE_TEMPLATE_BETA_BRANCH` | `'stage'` | Git branch for beta templates |

### Billing Configuration

Stripe integration for payment processing.

| Method | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `billing.getDefaultCurrency()` | `BILLING_DEFAULT_CURRENCY` | `'usd'` | Default currency |
| `billing.stripe.getSecretKey()` | `STRIPE_SECRET_KEY` | -- | Stripe secret key |
| `billing.stripe.getWebhookSecret()` | `STRIPE_WEBHOOK_SECRET` | -- | Stripe webhook signing secret |

### Branding Configuration

Application identity and branding strings.

| Method | Environment Variable | Fallback Variable | Default | Description |
|--------|---------------------|-------------------|---------|-------------|
| `branding.getAppName()` | `APP_NAME` | `NEXT_PUBLIC_APP_NAME` | `'Ever Works'` | Application display name |
| `branding.getCompanyOwner()` | `COMPANY_OWNER` | `NEXT_PUBLIC_COMPANY_OWNER` | `'Ever Co.'` | Company name |
| `branding.getPlatformWebsite()` | `PLATFORM_WEBSITE` | `NEXT_PUBLIC_COMPANY_OWNER_WEBSITE` | `'https://ever.works'` | Platform URL |

```typescript
// Used in PR bodies, commit messages, and generated content
const appName = config.branding.getAppName();
const website = config.branding.getPlatformWebsite();
const prBody = `Generated by [${appName}](${website})`;
```

## Usage Across the Agent Package

The configuration module is imported directly (not injected via DI) throughout the agent package:

```typescript
import { config } from '@src/config';
```

### Key Consumers

| Consumer | Config Namespace | Purpose |
|----------|-----------------|---------|
| `DirectoryScheduleService` | `subscriptions` | Check scheduling enabled, get defaults |
| `DirectoryScheduleDispatcherService` | `subscriptions` | Get batch limits |
| `ItemSubmissionService` | `branding` | PR body branding strings |
| Database module | `database` | Connection setup |
| Trigger integration | `trigger` | Background task dispatch |

## Design Decisions

**Why not NestJS ConfigService?** The config module uses a plain object with getter methods rather than NestJS's `ConfigService` for two reasons:

1. **Import simplicity** -- Can be used in any file without DI injection, including utility functions and non-injectable classes.
2. **Namespace organization** -- Getter methods with nested namespaces (`config.database.getType()`) provide better discoverability than flat key strings.

**Why getter methods instead of properties?** Each value is read from `process.env` at call time, which means:
- Environment changes are reflected without restart (useful for testing).
- Default values are computed on each call.
- No initialization order issues.
