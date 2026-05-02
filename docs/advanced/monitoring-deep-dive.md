---
id: monitoring-deep-dive
title: Monitoring Deep Dive
sidebar_label: Monitoring Deep Dive
sidebar_position: 11
---

# Monitoring Deep Dive

The Ever Works platform integrates **Sentry** for error tracking and performance monitoring, and **PostHog** for product analytics. Both are initialized at application startup and wired into the request pipeline via NestJS interceptors.

## Architecture Overview

```
    bootstrap()
        |
   +----v----+       +----v-----+
   | initSentry()    | initPostHog()
   +----+----+       +----+-----+
        |                  |
        +--------+---------+
                 |
           NestFactory.create(ApiModule)
                 |
        +--------v---------+
        |   APP_INTERCEPTOR |
        |  SentryInterceptor|----> Captures errors + sets user context
        |  PostHogInterceptor|---> Tracks every API request
        |  LoggingInterceptor|---> Console logging (debug mode)
        +------------------+
                 |
        +--------v---------+
        | AnalyticsService  |----> Custom event tracking
        | SentryService     |----> Structured logging, exception capture
        +------------------+
```

## Initialization

Both services are initialized before the NestJS application starts, in `apps/api/src/main.ts`:

```typescript
import { initSentry, initPostHog } from '@ever-works/monitoring';

async function bootstrap() {
	configDotenv({ path: path.resolve(process.cwd(), '.env') });

	// Initialize monitoring before app creation
	initSentry();
	initPostHog();

	const app = await NestFactory.create(ApiModule);
	// ...
}
```

The `MonitoringModule` is then registered in `ApiModule` to provide DI-managed services:

```typescript
MonitoringModule.forRoot({
    sentry: {
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
    },
    posthog: {
        apiKey: process.env.POSTHOG_API_KEY,
        host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    },
}),
```

## Sentry Configuration

The Sentry config in `packages/monitoring/src/sentry/sentry.config.ts` includes profiling and intelligent filtering:

```typescript
const defaultConfig = {
	dsn: process.env.SENTRY_DSN,
	environment: process.env.NODE_ENV || 'development',
	tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
	profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
	enableLogs: true,
	integrations: [nodeProfilingIntegration()],
	beforeSend(event) {
		// Filter out auth-related events to avoid logging credentials
		if (event.request?.url?.includes('/auth')) {
			return null;
		}
		return event;
	}
};
```

### Key Configuration Options

| Option               | Dev Value | Prod Value | Purpose                               |
| -------------------- | --------- | ---------- | ------------------------------------- |
| `tracesSampleRate`   | 1.0       | 0.1        | Percentage of transactions to trace   |
| `profilesSampleRate` | 1.0       | 0.1        | Percentage of transactions to profile |
| `enableLogs`         | true      | true       | Enable Sentry structured logging      |
| `beforeSend`         | --        | Filter     | Drop sensitive auth events            |

## Sentry Interceptor

The `SentryInterceptor` (registered as `APP_INTERCEPTOR`) runs on every request:

```typescript
@Injectable()
export class SentryInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const request = context.switchToHttp().getRequest();

		// Set user context for all Sentry events
		if (request.user) {
			Sentry.setUser({
				id: request.user.id,
				email: request.user.email,
				username: request.user.username
			});
		}

		// Set request metadata
		Sentry.setContext('request', {
			method,
			url: originalUrl,
			headers: this.sanitizeHeaders(headers),
			body: this.sanitizeBody(body)
		});

		return next.handle().pipe(
			catchError((error) => {
				Sentry.captureException(error, {
					tags: { endpoint, statusCode: error.status || 500 }
				});
				return throwError(() => error);
			})
		);
	}
}
```

Note the sanitization methods that strip `authorization`, `cookie`, `password`, `token`, and `secret` fields before sending data to Sentry.

## PostHog Configuration

PostHog is configured in `packages/monitoring/src/posthog/posthog.config.ts`:

```typescript
export const initPostHog = (config?: PostHogConfig) => {
	const apiKey = config?.apiKey || process.env.POSTHOG_API_KEY;
	const host = config?.host || process.env.POSTHOG_HOST;
	const flushAt = config?.flushAt || 20; // Batch size
	const flushInterval = config?.flushInterval || 10000; // 10 seconds

	if (apiKey) {
		posthogClient = new PostHog(apiKey, { host, flushAt, flushInterval });
	}
};
```

## PostHog Interceptor

The `PostHogInterceptor` tracks every API request as an analytics event:

```typescript
@Injectable()
export class PostHogInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const startTime = Date.now();

		return next.handle().pipe(
			tap(() => {
				trackEvent(user?.id || 'anonymous', 'api_request', {
					method,
					endpoint: originalUrl,
					statusCode,
					duration: Date.now() - startTime
				});
			})
		);
	}
}
```

## AnalyticsService

For custom event tracking beyond automatic request logging, inject `AnalyticsService`:

```typescript
import { AnalyticsService } from '@ever-works/monitoring';

@Injectable()
export class WorkService {
	constructor(private readonly analytics: AnalyticsService) {}

	async createWork(userId: string, data: CreateWorkDto) {
		const work = await this.repo.create(data);

		// Track business event
		this.analytics.trackBusinessEvent(userId, 'work_created', {
			workId: work.id,
			workName: work.name
		});

		return work;
	}
}
```

### Available Tracking Methods

| Method                 | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `track()`              | Custom event with arbitrary properties  |
| `identify()`           | Associate user properties               |
| `trackApiUsage()`      | API endpoint metrics                    |
| `trackAuth()`          | Login, logout, register, password_reset |
| `trackBusinessEvent()` | Business-specific events                |

## SentryService

For structured logging that flows to Sentry's Logs feature:

```typescript
import { SentryService } from '@ever-works/monitoring';

@Injectable()
export class GenerationService {
	constructor(private readonly sentry: SentryService) {}

	async generateContent(workId: string) {
		this.sentry.info('Generation started', { workId });

		try {
			// ... generation logic
			this.sentry.info('Generation completed', { workId, duration });
		} catch (error) {
			this.sentry.error('Generation failed', { workId });
			this.sentry.captureException(error);
			throw error;
		}
	}
}
```

## Environment Variables

| Variable          | Required | Default                   | Description             |
| ----------------- | -------- | ------------------------- | ----------------------- |
| `SENTRY_DSN`      | No       | --                        | Sentry project DSN      |
| `POSTHOG_API_KEY` | No       | --                        | PostHog project API key |
| `POSTHOG_HOST`    | No       | `https://app.posthog.com` | PostHog instance URL    |
| `NODE_ENV`        | No       | `development`             | Controls sample rates   |

Both services gracefully degrade when credentials are not provided -- no errors, just no-ops.

## Best Practices

1. **Always sanitize before sending** -- Never include passwords, tokens, or API keys in Sentry events or PostHog properties.

2. **Use structured logging** -- Prefer `SentryService.info()` with context objects over plain string messages.

3. **Sample in production** -- Keep `tracesSampleRate` at 0.1 (10%) to control costs while maintaining visibility.

4. **Track business events** -- Use `AnalyticsService.trackBusinessEvent()` for product metrics, not just technical metrics.

5. **Filter noisy errors** -- Use `beforeSend` to drop expected errors (404s on optional resources, auth failures).

## Troubleshooting

### Events not appearing in Sentry

Check that `SENTRY_DSN` is set and valid. Events from auth endpoints are intentionally filtered out by `beforeSend`.

### PostHog events delayed

PostHog batches events (default: 20 events or 10 seconds). In development, you can reduce `flushAt` to 1 for immediate delivery.

### High Sentry bill

Reduce `tracesSampleRate` and `profilesSampleRate`. Use `beforeSend` to drop low-value events like health checks.

## Related Documentation

- [Middleware Pipeline](../architecture/middleware-pipeline.md) -- Interceptor execution order
- [Security Hardening](./security-hardening.md) -- Data sanitization patterns
- [Configuration Management](../architecture/configuration-management.md) -- Environment variables
- [Performance Tuning](./performance-tuning.md) -- Using profiling data
