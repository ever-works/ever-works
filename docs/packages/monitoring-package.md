---
id: monitoring-package
title: Monitoring Package
sidebar_label: Monitoring Package
sidebar_position: 2
---

# Monitoring Package

The `@ever-works/monitoring` package integrates PostHog analytics and Sentry error tracking into the Ever Works platform. It provides a unified NestJS module with injectable services, HTTP interceptors, and typed event interfaces for consistent observability across the API.

## Package Overview

| Property           | Value                                           |
| ------------------ | ----------------------------------------------- |
| **Package name**   | `@ever-works/monitoring`                        |
| **Location**       | `platform/packages/monitoring/`                 |
| **Framework**      | NestJS (global module)                          |
| **Analytics**      | PostHog (posthog-node)                          |
| **Error tracking** | Sentry (@sentry/nestjs, @sentry/profiling-node) |

## Module Registration

The `MonitoringModule` is a global NestJS module that initializes both PostHog and Sentry based on provided configuration or environment variables.

```typescript
import { MonitoringModule } from '@ever-works/monitoring';

@Module({
	imports: [
		MonitoringModule.forRoot({
			sentry: {
				dsn: process.env.SENTRY_DSN,
				tracesSampleRate: 0.1
			},
			posthog: {
				apiKey: process.env.POSTHOG_API_KEY
			}
		})
	]
})
export class AppModule {}
```

Both services are optional -- if no DSN or API key is provided, the respective service initializes as a no-op.

## Configuration Types

```typescript
interface MonitoringConfig {
	sentry?: SentryConfig;
	posthog?: PostHogConfig;
}

interface SentryConfig {
	dsn?: string;
	environment?: string;
	tracesSampleRate?: number;
	profilesSampleRate?: number;
	enableLogs?: boolean;
	beforeSend?: (event: any) => any | null;
	beforeSendTransaction?: (event: any) => any | null;
}

interface PostHogConfig {
	apiKey?: string;
	host?: string; // default: 'https://app.posthog.com'
	flushAt?: number; // default: 20
	flushInterval?: number; // default: 10000ms
}
```

## AnalyticsService (PostHog)

The `AnalyticsService` wraps PostHog client operations with typed method signatures.

| Method                                                              | Description                            |
| ------------------------------------------------------------------- | -------------------------------------- |
| `track(distinctId, event, properties?, groups?)`                    | Track a custom event                   |
| `trackEvent(event: AnalyticsEvent)`                                 | Track using typed event interface      |
| `identify(distinctId, properties?)`                                 | Identify a user                        |
| `identifyUser(userProps: UserProperties)`                           | Identify using typed interface         |
| `setUserProperties(distinctId, properties)`                         | Set user properties                    |
| `trackApiUsage(distinctId, endpoint, method, statusCode, duration)` | Track API endpoint usage               |
| `trackAuth(distinctId, event, properties?)`                         | Track authentication events            |
| `trackBusinessEvent(distinctId, event, properties?)`                | Track business events                  |
| `isAvailable()`                                                     | Check if PostHog client is initialized |

### Usage Example

```typescript
@Injectable()
export class DirectoryService {
	constructor(private readonly analytics: AnalyticsService) {}

	async createDirectory(userId: string, data: CreateDirectoryDto) {
		const directory = await this.directoryRepo.create(data);

		this.analytics.trackBusinessEvent(userId, 'directory_created', {
			directoryId: directory.id,
			slug: directory.slug
		});

		return directory;
	}
}
```

## SentryService

The `SentryService` wraps the Sentry SDK with structured logging and exception capture.

| Method                                  | Description                                |
| --------------------------------------- | ------------------------------------------ |
| `getLogger()`                           | Access Sentry's structured logger instance |
| `trace(message, context?)`              | Log a trace message                        |
| `debug(message, context?)`              | Log a debug message                        |
| `info(message, context?)`               | Log an info message                        |
| `warn(message, context?)`               | Log a warning message                      |
| `error(message, context?)`              | Log an error message                       |
| `fatal(message, context?)`              | Log a fatal message                        |
| `captureException(exception, context?)` | Capture an exception                       |
| `captureMessage(message, level?)`       | Capture a message                          |
| `setUser(user)`                         | Set user context                           |
| `setContext(name, context)`             | Set additional context                     |
| `setTag(key, value)`                    | Set a single tag                           |
| `setTags(tags)`                         | Set multiple tags                          |
| `isInitialized()`                       | Check if Sentry DSN is configured          |

### Sentry Configuration Defaults

The Sentry configuration applies sensible defaults:

| Setting              | Production                   | Development                  |
| -------------------- | ---------------------------- | ---------------------------- |
| `tracesSampleRate`   | 0.1                          | 1.0                          |
| `profilesSampleRate` | 0.1                          | 1.0                          |
| `enableLogs`         | true                         | true                         |
| **Integration**      | `nodeProfilingIntegration()` | `nodeProfilingIntegration()` |
| **Auth filtering**   | Excludes `/auth` routes      | Excludes `/auth` routes      |

## HTTP Interceptors

### PostHogInterceptor

Automatically tracks API requests as PostHog events. Attaches to the NestJS request pipeline via `tap()`.

**Tracked properties per request:**

| Property     | Source                 |
| ------------ | ---------------------- |
| `method`     | HTTP method            |
| `endpoint`   | Request URL            |
| `statusCode` | Response status code   |
| `duration`   | Request duration in ms |
| `userAgent`  | User-Agent header      |
| `ip`         | Client IP address      |
| `timestamp`  | ISO timestamp          |

The interceptor also generates a normalized endpoint event name by replacing numeric IDs with `:id` placeholders (e.g., `api_get_directories_:id`).

### SentryInterceptor

Enriches Sentry error context with request data and captures unhandled exceptions.

**Behavior:**

1. Sets Sentry user context from `request.user` (id, email, username)
2. Attaches sanitized request context (method, URL, headers, body)
3. Sets transaction tag as `{method} {url}`
4. On error, captures the exception with endpoint and status code tags

**Security:** The interceptor sanitizes sensitive data by removing `authorization` and `cookie` headers, and `password`, `token`, and `secret` fields from request bodies.

## Event Types

The package provides typed interfaces for structured event tracking:

```typescript
interface AnalyticsEvent {
	distinctId: string;
	event: string;
	properties?: Record<string, any>;
	groups?: Record<string, string | number>;
}

interface ApiUsageEvent {
	distinctId: string;
	endpoint: string;
	method: string;
	statusCode: number;
	duration: number;
}

interface AuthEvent {
	distinctId: string;
	event: 'login' | 'logout' | 'register' | 'password_reset';
	properties?: Record<string, any>;
}

interface BusinessEvent {
	distinctId: string;
	event: string;
	properties?: Record<string, any>;
}
```

## PostHog Client Functions

The `posthog.config.ts` module provides lower-level functions used internally:

| Function                                              | Description                       |
| ----------------------------------------------------- | --------------------------------- |
| `initPostHog(config?)`                                | Initialize the PostHog client     |
| `getPostHogClient()`                                  | Get the singleton client instance |
| `trackEvent(distinctId, event, properties?, groups?)` | Capture an event                  |
| `identifyUser(distinctId, properties?)`               | Identify a user                   |
| `setUserProperties(distinctId, properties)`           | Set user properties               |
| `shutdownPostHog()`                                   | Flush and shutdown the client     |

All events are automatically tagged with `source: 'api'` and an ISO `timestamp`.

## Module Structure

```
monitoring/src/
  index.ts                      # Public API exports
  monitoring.module.ts           # Root MonitoringModule
  posthog/
    posthog.module.ts            # PostHogModule with forRoot()
    posthog.config.ts            # Client initialization and helpers
  sentry/
    sentry.module.ts             # SentryModule with forRoot()
    sentry.config.ts             # Sentry init with profiling
  services/
    analytics.service.ts         # AnalyticsService (PostHog wrapper)
    sentry.service.ts            # SentryService (Sentry wrapper)
  interceptors/
    posthog.interceptor.ts       # Request tracking interceptor
    sentry.interceptor.ts        # Error capture interceptor
  types/
    index.ts                     # Config and event type definitions
```
