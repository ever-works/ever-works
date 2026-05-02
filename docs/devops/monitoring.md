---
id: monitoring
title: Monitoring & Observability
sidebar_label: Monitoring
sidebar_position: 4
---

# Monitoring & Observability

Ever Works uses Sentry for error tracking and performance monitoring, and PostHog for product analytics. Both are integrated through the `@ever-works/monitoring` package located in `packages/monitoring/`.

## Architecture

The monitoring package provides a global NestJS module with a `forRoot()` configuration pattern:

```typescript
@Global()
@Module({})
export class MonitoringModule {
	static forRoot(config?: MonitoringConfig) {
		return {
			module: MonitoringModule,
			global: true,
			imports: [SentryModule.forRoot(config?.sentry), PostHogModule.forRoot(config?.posthog)],
			providers: [AnalyticsService, SentryService],
			exports: [AnalyticsService, SentryService]
		};
	}
}
```

The `@Global()` decorator makes `AnalyticsService` and `SentryService` available throughout the application without explicit imports.

## Sentry Integration

### Configuration

Sentry is initialized in `sentry/sentry.config.ts` with environment-aware defaults:

| Setting              | Production  | Development  |
| -------------------- | ----------- | ------------ |
| `tracesSampleRate`   | `0.1` (10%) | `1.0` (100%) |
| `profilesSampleRate` | `0.1` (10%) | `1.0` (100%) |
| `enableLogs`         | `true`      | `true`       |

The configuration includes `nodeProfilingIntegration()` for server-side performance profiling.

### Auth Route Filtering

Authentication routes are excluded from Sentry tracking to avoid capturing sensitive data:

```typescript
beforeSend(event) {
    if (event.request?.url?.includes('/auth')) {
        return null;
    }
    return event;
},
beforeSendTransaction(event) {
    if (event.request?.url?.includes('/auth')) {
        return null;
    }
    return event;
},
```

Both `beforeSend` (errors) and `beforeSendTransaction` (performance) filters drop any events from `/auth` endpoints.

### Sentry Interceptor

The `SentryInterceptor` is a NestJS interceptor that enriches error reports with request context:

**On every request**:

- Sets the Sentry user context (`id`, `email`, `username`) if authenticated.
- Sets request context (`method`, `url`, sanitized headers, sanitized body).
- Tags the transaction with the endpoint pattern.

**On error**:

- Captures the exception with additional tags (`endpoint`, `statusCode`) and extras (`requestBody`, `userAgent`).

### Data Sanitization

The interceptor sanitizes sensitive data before sending to Sentry:

```typescript
// Headers: remove auth and cookies
private sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    return sanitized;
}

// Body: remove credentials
private sanitizeBody(body) {
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    return sanitized;
}
```

### SentryService

The `SentryService` wraps Sentry's logging API with standard log levels:

| Method           | Sentry Level |
| ---------------- | ------------ |
| `trace(message)` | `trace`      |
| `debug(message)` | `debug`      |
| `info(message)`  | `info`       |
| `warn(message)`  | `warning`    |
| `error(message)` | `error`      |
| `fatal(message)` | `fatal`      |

## PostHog Integration

### Configuration

PostHog is initialized in `posthog/posthog.config.ts` with the `POSTHOG_API_KEY` and optional `POSTHOG_HOST` environment variables. The client exposes three functions:

| Function                                            | Purpose                         |
| --------------------------------------------------- | ------------------------------- |
| `trackEvent(distinctId, event, properties, groups)` | Track a custom event            |
| `identifyUser(distinctId, properties)`              | Identify a user with properties |
| `setUserProperties(distinctId, properties)`         | Update user properties          |

### PostHog Interceptor

The `PostHogInterceptor` automatically tracks API request metrics:

- **Duration**: Measures request processing time.
- **Endpoint normalization**: Strips dynamic path segments for consistent grouping.
- **Properties captured**: method, endpoint, status code, duration, user agent.

## AnalyticsService

The `AnalyticsService` is the high-level API for product analytics. It wraps PostHog with typed event methods.

### Event Categories

| Category      | Method                                                              | Events                                          |
| ------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| **Generic**   | `track(distinctId, event, properties)`                              | Any custom event                                |
| **API Usage** | `trackApiUsage(distinctId, endpoint, method, statusCode, duration)` | Endpoint performance                            |
| **Auth**      | `trackAuth(distinctId, event, properties)`                          | `login`, `logout`, `register`, `password_reset` |
| **Business**  | `trackBusinessEvent(distinctId, event, properties)`                 | Business-specific metrics                       |

### Typed Event Interfaces

The service supports both positional parameters and typed event objects:

```typescript
// Positional
analytics.trackApiUsage(userId, '/api/works', 'GET', 200, 150);

// Typed object
analytics.trackApiUsageEvent({
	distinctId: userId,
	endpoint: '/api/works',
	method: 'GET',
	statusCode: 200,
	duration: 150
});
```

### Availability Check

```typescript
analytics.isAvailable(): boolean
```

Returns `true` if PostHog is configured and available. This allows callers to skip expensive property collection when analytics is disabled.

## Environment Variables

| Variable          | Service | Purpose                                           |
| ----------------- | ------- | ------------------------------------------------- |
| `SENTRY_DSN`      | Sentry  | Data Source Name for error reporting              |
| `NODE_ENV`        | Sentry  | Controls sample rates (production vs development) |
| `POSTHOG_API_KEY` | PostHog | API key for event tracking                        |
| `POSTHOG_HOST`    | PostHog | Custom PostHog instance URL (optional)            |

## Module Structure

```
packages/monitoring/
  src/
    monitoring.module.ts        # Global module with forRoot()
    types.ts                    # MonitoringConfig, event interfaces
    sentry/
      sentry.module.ts          # Sentry NestJS module
      sentry.config.ts          # Sentry initialization
    posthog/
      posthog.module.ts         # PostHog NestJS module
      posthog.config.ts         # PostHog client initialization
    interceptors/
      sentry.interceptor.ts     # Request context enrichment
      posthog.interceptor.ts    # Request duration tracking
    services/
      analytics.service.ts      # High-level analytics API
      sentry.service.ts         # Sentry logging wrapper
```
