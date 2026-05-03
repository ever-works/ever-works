---
id: logging-aggregation
title: Logging & Aggregation
sidebar_label: Logging & Aggregation
sidebar_position: 11
---

# Logging & Aggregation

Ever Works uses a multi-layer logging strategy that spans the NestJS API, background task workers, and the Next.js web application. Structured logs flow into Sentry for error aggregation and into Trigger.dev for task-level observability.

## Architecture Overview

```
+-----------------+       +------------------+       +-----------------+
|  NestJS API     |       |  Trigger.dev     |       |  Next.js Web    |
|  (SentryService)|       |  (TriggerLogger) |       |  (console/      |
|                 |       |                  |       |   Sentry SDK)   |
+-------+---------+       +--------+---------+       +--------+--------+
        |                          |                          |
        v                          v                          v
   +---------+             +--------------+            +-------------+
   | Sentry  |             | Trigger.dev  |            | Sentry      |
   | (cloud) |             | Dashboard    |            | (browser)   |
   +---------+             +--------------+            +-------------+
        |                          |
        v                          v
   +-----------------------------------------+
   |        Unified Sentry Dashboard         |
   |   (errors, traces, performance, logs)   |
   +-----------------------------------------+
```

## Log Levels

The platform supports six structured log levels, consistent across both the `SentryService` and the `TriggerLogger`:

| Level   | Purpose                                    | Sentry Severity | Trigger.dev Method |
| ------- | ------------------------------------------ | --------------- | ------------------ |
| `trace` | Fine-grained debugging (rarely enabled)    | debug           | `logger.debug`     |
| `debug` | Diagnostic information during development  | debug           | `logger.debug`     |
| `info`  | Normal operational events                  | info            | `logger.log`       |
| `warn`  | Unexpected but non-critical conditions     | warning         | `logger.warn`      |
| `error` | Failures that affect a single request/task | error           | `logger.error`     |
| `fatal` | System-wide failures requiring attention   | fatal           | `logger.error`     |

## SentryService (API Layer)

The `SentryService` in `packages/monitoring/src/services/sentry.service.ts` wraps the `@sentry/nestjs` SDK and provides structured logging via `Sentry.logger`:

```typescript
interface SentryService {
	// Structured logging methods
	trace(message: string, context?: Record<string, any>): void;
	debug(message: string, context?: Record<string, any>): void;
	info(message: string, context?: Record<string, any>): void;
	warn(message: string, context?: Record<string, any>): void;
	error(message: string, context?: Record<string, any>): void;
	fatal(message: string, context?: Record<string, any>): void;

	// Exception capture
	captureException(exception: any, context?: any): string;
	captureMessage(message: string, level?: any): string;

	// Context enrichment
	setUser(user: { id?: string; email?: string; username?: string }): void;
	setContext(name: string, context: Record<string, any>): void;
	setTag(key: string, value: string): void;
	setTags(tags: Record<string, string>): void;
}
```

### Usage in Services

```typescript
@Injectable()
export class WorkService {
	constructor(private readonly sentryService: SentryService) {}

	async generate(workId: string) {
		this.sentryService.info('Generation started', { workId });
		try {
			// ... generation logic
			this.sentryService.info('Generation completed', { workId, itemCount: 42 });
		} catch (error) {
			this.sentryService.error('Generation failed', { workId, error: error.message });
			this.sentryService.captureException(error);
			throw error;
		}
	}
}
```

## SentryInterceptor (Automatic Request Logging)

The `SentryInterceptor` in `packages/monitoring/src/interceptors/sentry.interceptor.ts` automatically instruments every HTTP request:

1. Sets user context from JWT-authenticated `request.user`
2. Attaches sanitized request metadata (method, URL, headers, body)
3. Captures exceptions with endpoint tags and status codes
4. Strips sensitive fields: `authorization`, `cookie`, `password`, `token`, `secret`

```typescript
// Automatically applied via APP_INTERCEPTOR in the API module
Sentry.setContext('request', {
	method,
	url: originalUrl,
	headers: sanitizedHeaders,
	body: sanitizedBody
});
```

## TriggerLogger (Background Task Logging)

Background tasks run inside Trigger.dev workers where standard stdout is not visible in the dashboard. The `TriggerLogger` in `packages/tasks/src/trigger/worker/trigger-logger.ts` bridges NestJS logging to Trigger.dev's structured logger:

```typescript
// Creating a logger for a Trigger.dev task
const appContext = await NestFactory.createApplicationContext(TriggerInternalModule, {
	logger: createTriggerLogger('ScheduleDispatcher')
});
```

The `TriggerLogger` implements the NestJS `LoggerService` interface, forwarding all log calls to `@trigger.dev/sdk`'s `logger` object. Logs appear in the Trigger.dev run dashboard with:

- Formatted context prefixes: `[ScheduleDispatcher] Message here`
- Extracted error stack traces
- Structured metadata objects

## Sentry Configuration

Sentry is initialized via `packages/monitoring/src/sentry/sentry.config.ts`:

```typescript
interface SentryConfig {
	dsn?: string; // SENTRY_DSN env var
	environment?: string; // NODE_ENV
	tracesSampleRate?: number; // 0.1 in production, 1.0 in development
	profilesSampleRate?: number; // 0.1 in production, 1.0 in development
	enableLogs?: boolean; // true by default
	beforeSend?: (event) => any; // Filters auth-related events
}
```

Key behaviors:

- **Auth event filtering**: Requests matching `/auth` are automatically excluded from both error events and transactions via `beforeSend` and `beforeSendTransaction`.
- **Profiling**: Node profiling is enabled via `nodeProfilingIntegration()` for performance analysis.
- **Environment-aware sampling**: Production uses 10% sampling rates; development captures everything.

## Log Aggregation Patterns

### Searching Logs in Sentry

Use Sentry's Logs view to search structured log entries:

- Filter by level: `level:error` or `level:warn`
- Filter by context fields: `workId:abc-123`
- Filter by service: `logger.name:ScheduleDispatcher`

### Trigger.dev Dashboard

For background task logs, use the Trigger.dev dashboard at `https://cloud.trigger.dev`:

- Navigate to the specific run using the `triggerRunId` stored in generation history
- View structured logs with timestamps and metadata
- Filter by log level within the run timeline

### Alert Configuration

Configure Sentry alerts for critical conditions:

1. **Error spike alerts**: Trigger when error rate exceeds threshold over a 5-minute window
2. **Transaction duration alerts**: Trigger when P95 latency exceeds SLA targets
3. **New issue alerts**: Immediate notification for first occurrence of a new error type

## Environment Variables

| Variable          | Description             | Default                   |
| ----------------- | ----------------------- | ------------------------- |
| `SENTRY_DSN`      | Sentry Data Source Name | (disabled if unset)       |
| `NODE_ENV`        | Environment identifier  | `development`             |
| `POSTHOG_API_KEY` | PostHog analytics key   | (disabled if unset)       |
| `POSTHOG_HOST`    | PostHog instance URL    | `https://app.posthog.com` |

## Cross-References

- [Performance Monitoring](./performance-monitoring.md) -- APM metrics and dashboards
- [Disaster Recovery](./disaster-recovery.md) -- log retention policies during DR scenarios
- [Generation History UI](../web-dashboard/history-ui.md) -- viewing `triggerRunId` links in the dashboard
