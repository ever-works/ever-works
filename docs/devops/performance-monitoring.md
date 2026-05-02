---
id: performance-monitoring
title: Performance Monitoring
sidebar_label: Performance Monitoring
sidebar_position: 13
---

# Performance Monitoring

Ever Works integrates Sentry for application performance monitoring (APM) and PostHog for product analytics. Together they provide end-to-end visibility into API latency, background task performance, user behavior, and business metrics.

## Monitoring Architecture

```
+---------------------+        +-------------------+
|    NestJS API       |        |    Next.js Web    |
|                     |        |                   |
| +--Sentry----------+|        | +--Sentry--------+|
| | Interceptor       ||        | | Browser SDK    ||
| | tracing + errors  ||        | | page load perf ||
| +-------------------+|        | +----------------+|
|                     |        |                   |
| +--PostHog----------+|        | +--PostHog-------+|
| | Interceptor        ||        | | JS SDK        ||
| | API usage events   ||        | | user events   ||
| +--------------------+|        | +---------------+|
+----------+-----------+        +--------+---------+
           |                             |
     +-----v-----+               +------v------+
     |  Sentry   |               |  PostHog    |
     |  Cloud    |               |  Cloud      |
     +-----------+               +-------------+
```

## MonitoringModule Configuration

The `MonitoringModule` in `packages/monitoring/src/monitoring.module.ts` is a global NestJS module that initializes both Sentry and PostHog:

```typescript
interface MonitoringConfig {
	sentry?: SentryConfig;
	posthog?: PostHogConfig;
}

interface SentryConfig {
	dsn?: string;
	environment?: string;
	tracesSampleRate?: number; // 0.1 prod, 1.0 dev
	profilesSampleRate?: number; // 0.1 prod, 1.0 dev
	enableLogs?: boolean; // true by default
}

interface PostHogConfig {
	apiKey?: string;
	host?: string; // default: https://app.posthog.com
	flushAt?: number; // batch size, default: 20
	flushInterval?: number; // ms, default: 10000
}
```

Usage in `AppModule`:

```typescript
@Module({
	imports: [
		MonitoringModule.forRoot({
			sentry: { tracesSampleRate: 0.1 },
			posthog: { flushAt: 20 }
		})
	]
})
export class AppModule {}
```

## Sentry APM

### Transaction Tracing

The `SentryInterceptor` automatically creates a transaction span for every HTTP request:

- Tags each transaction with `{method} {url}` format
- Attaches user context from JWT authentication
- Sanitizes sensitive headers (`authorization`, `cookie`) and body fields (`password`, `token`, `secret`)
- Records error metadata including status codes and request bodies

### Performance Sampling

```typescript
// Production: 10% of transactions and profiles are captured
tracesSampleRate: 0.1;
profilesSampleRate: 0.1;

// Development: 100% capture for debugging
tracesSampleRate: 1.0;
profilesSampleRate: 1.0;
```

### Node Profiling

Sentry's `nodeProfilingIntegration()` is enabled by default, providing:

- Function-level CPU profiling for slow endpoints
- Flame graphs in the Sentry Performance dashboard
- Correlation between slow transactions and CPU-intensive code paths

### Key Sentry Dashboards

| Dashboard       | Purpose                                             |
| --------------- | --------------------------------------------------- |
| **Performance** | Transaction duration P50/P75/P95, throughput, Apdex |
| **Issues**      | Error grouping, stack traces, affected users        |
| **Profiles**    | CPU flame graphs for slow transactions              |
| **Logs**        | Structured log search and filtering                 |
| **Alerts**      | Configurable thresholds for errors and latency      |

### Recommended Sentry Alerts

```
Alert: API P95 Latency > 2s
  Metric: transaction.duration (p95)
  Threshold: > 2000ms over 5 minutes
  Action: Slack notification + PagerDuty

Alert: Error Rate Spike
  Metric: event.type:error
  Threshold: > 50 events / 5 minutes
  Action: Slack notification

Alert: Generation Task Failure
  Metric: event.type:error, tag:endpoint contains "generation"
  Threshold: > 5 events / hour
  Action: Email notification
```

## PostHog Analytics

### API Usage Tracking

The `PostHogInterceptor` in `packages/monitoring/src/interceptors/posthog.interceptor.ts` captures every API request as two events:

1. **`api_request`**: Generic request with method, endpoint, status code, duration, user agent, IP
2. **`api_{method}_{endpoint_name}`**: Specific endpoint event (e.g., `api_get_works_:id`)

```typescript
// Event properties captured:
{
    method: 'GET',
    endpoint: '/api/works/abc-123',
    statusCode: 200,
    duration: 145,           // milliseconds
    userAgent: 'Mozilla/5.0...',
    timestamp: '2025-01-15T10:30:00.000Z'
}
```

### AnalyticsService API

The `AnalyticsService` provides typed methods for tracking business and operational events:

```typescript
interface AnalyticsService {
	// Generic event tracking
	track(distinctId: string, event: string, properties?: Record<string, any>): void;
	trackEvent(event: AnalyticsEvent): void;

	// User identification
	identify(distinctId: string, properties?: Record<string, any>): void;
	setUserProperties(distinctId: string, properties: Record<string, any>): void;

	// Specialized tracking
	trackApiUsage(distinctId, endpoint, method, statusCode, duration): void;
	trackAuth(distinctId, event: 'login' | 'logout' | 'register' | 'password_reset'): void;
	trackBusinessEvent(distinctId, event: string, properties?): void;
}
```

### Event Types

| Interface        | Fields                                                       | Usage               |
| ---------------- | ------------------------------------------------------------ | ------------------- |
| `AnalyticsEvent` | `distinctId`, `event`, `properties`, `groups`                | Custom events       |
| `ApiUsageEvent`  | `distinctId`, `endpoint`, `method`, `statusCode`, `duration` | API performance     |
| `AuthEvent`      | `distinctId`, `event` (login/logout/register/password_reset) | Authentication flow |
| `BusinessEvent`  | `distinctId`, `event`, `properties`                          | Business metrics    |

### PostHog Dashboards

Build the following dashboards in PostHog for operational visibility:

**API Performance Dashboard**:

- Average response time by endpoint (trend)
- Error rate by endpoint (bar chart)
- Request volume by hour (time series)
- Slowest endpoints P95 (table)

**User Engagement Dashboard**:

- Daily active users (trend)
- Feature adoption funnel (funnel)
- Work generation frequency (histogram)
- Deployment success rate (pie chart)

**Business Metrics Dashboard**:

- New work creations per day
- Generation runs per user
- Deployment frequency by provider
- Subscription plan distribution

## Custom Metrics

### Background Task Metrics

Background tasks (Trigger.dev) emit structured metrics visible in the Trigger.dev dashboard:

```typescript
// work-schedule-dispatcher.task.ts returns metrics:
return {
	dispatched: 5, // number of schedules dispatched
	intervalMinutes: 10 // dispatcher interval
};
```

### Generation History Metrics

Each generation run stores metrics in the `WorkGenerationHistoryEntry`:

| Metric                      | Description                      |
| --------------------------- | -------------------------------- |
| `durationInSeconds`         | Total generation wall-clock time |
| `newItemsCount`             | Items created during this run    |
| `updatedItemsCount`         | Items updated during this run    |
| `totalItemsCount`           | Total items in work after run    |
| `metrics.total_tokens_used` | LLM token consumption            |
| `metrics.total_cost`        | Estimated LLM cost (USD)         |

These metrics are displayed in the [Generation History UI](../web-dashboard/history-ui.md).

## Health Check Endpoints

Both the API and Web services expose health endpoints used by Kubernetes probes:

| Service | Endpoint      | Port | Purpose                       |
| ------- | ------------- | ---- | ----------------------------- |
| API     | `/api/health` | 3100 | Liveness and readiness checks |
| Web     | `/api/health` | 3000 | Liveness and readiness checks |

## Environment Variables

| Variable          | Service | Description                    |
| ----------------- | ------- | ------------------------------ |
| `SENTRY_DSN`      | API     | Sentry Data Source Name        |
| `NODE_ENV`        | API/Web | Environment for sampling rates |
| `POSTHOG_API_KEY` | API     | PostHog project API key        |
| `POSTHOG_HOST`    | API     | PostHog instance URL           |

## Cross-References

- [Logging & Aggregation](./logging-aggregation.md) -- structured logging with SentryService
- [Disaster Recovery](./disaster-recovery.md) -- health check configuration for failover
- [Generation History UI](../web-dashboard/history-ui.md) -- viewing generation metrics
- [Schedule UI](../web-dashboard/schedule-ui.md) -- schedule failure counts and status
