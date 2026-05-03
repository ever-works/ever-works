---
id: middleware-pipeline
title: Middleware Pipeline
sidebar_label: Middleware Pipeline
sidebar_position: 12
---

# Middleware Pipeline

The Ever Works API processes every HTTP request through a multi-stage pipeline. Understanding the execution order of middleware, guards, interceptors, pipes, handlers, and exception filters is essential for debugging and extending the platform.

## Request Lifecycle

```
    Client Request
          |
    +-----v------+
    |  Express    |  body-parser (json/urlencoded, 10MB limit)
    |  Middleware  |  helmet (security headers)
    +-----+------+  CORS
          |
    +-----v------+
    |   Guards    |  1. ThrottlerGuard  (rate limiting)
    |             |  2. JwtAuthGuard    (authentication)
    +-----+------+
          |
    +-----v------+
    | Interceptors|  (before handler - request phase)
    |             |  1. LoggingInterceptor   (log incoming request)
    |             |  2. SentryInterceptor    (set user context)
    |             |  3. PostHogInterceptor   (start timer)
    +-----+------+
          |
    +-----v------+
    |   Pipes     |  ValidationPipe (whitelist, transform, validate)
    +-----+------+
          |
    +-----v------+
    |  Handler    |  Controller method executes
    +-----+------+
          |
    +-----v------+
    | Interceptors|  (after handler - response phase)
    |             |  3. PostHogInterceptor   (track request)
    |             |  2. SentryInterceptor    (capture errors)
    |             |  1. LoggingInterceptor   (log response)
    +-----+------+
          |
    +-----v------+
    | Exception   |  Built-in NestJS exception filter
    |  Filters    |  (catches unhandled errors)
    +-----+------+
          |
    Client Response
```

## Express Middleware Layer

These run before NestJS takes over. Configured in `main.ts`:

```typescript
// Body parsing with size limits
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ limit: '10mb', extended: true }));

// Security headers (conditional CSP)
app.use((req, res, next) => {
	if (req.path.startsWith('/api/docs')) {
		return helmet({
			contentSecurityPolicy: {
				/* relaxed */
			}
		})(req, res, next);
	}
	return helmet()(req, res, next);
});

// CORS
app.enableCors({
	origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
	credentials: true
});
```

## Guards

Guards determine whether a request should proceed. They run **in registration order**:

### 1. ThrottlerGuard

Checks rate limits across all three tiers (short, medium, long):

```typescript
{
    provide: APP_GUARD,
    useClass: ThrottlerGuard,   // Runs first
},
```

If the rate limit is exceeded, the guard returns a `429 Too Many Requests` response. The request never reaches the auth guard.

### 2. JwtAuthGuard

Validates the JWT token (unless the route is `@Public()`):

```typescript
{
    provide: APP_GUARD,
    useClass: JwtAuthGuard,     // Runs second
},
```

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
	canActivate(context: ExecutionContext) {
		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
			context.getHandler(),
			context.getClass()
		]);
		if (isPublic) return true;
		return super.canActivate(context);
	}
}
```

If authentication fails, a `401 Unauthorized` response is returned.

## Interceptors (Before Handler)

Interceptors wrap the handler execution. The "before" phase runs in registration order:

### 1. LoggingInterceptor

Logs the incoming request (only when `HTTP_DEBUG=true`):

```typescript
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		if (!config.debug()) {
			return next.handle(); // Skip entirely in production
		}

		const now = Date.now();
		this.logger.log(`Incoming Request: ${method} ${originalUrl}`);

		return next.handle().pipe(
			tap(() => {
				const delay = Date.now() - now;
				this.logger.log(`Outgoing Response: ${method} ${originalUrl} ${statusCode} - ${delay}ms`);
			})
		);
	}
}
```

### 2. SentryInterceptor

Sets Sentry user context and request metadata:

```typescript
if (request.user) {
	Sentry.setUser({ id: request.user.id, email: request.user.email });
}
Sentry.setContext('request', { method, url, headers: sanitized, body: sanitized });
Sentry.setTag('transaction', `${method} ${originalUrl}`);
```

### 3. PostHogInterceptor

Records the start time for duration tracking:

```typescript
const startTime = Date.now();
// ... handler executes ...
// After handler:
trackEvent(user?.id || 'anonymous', 'api_request', {
	method,
	endpoint,
	statusCode,
	duration: Date.now() - startTime
});
```

## Pipes

The global `ValidationPipe` runs after guards and interceptors but before the handler:

```typescript
app.useGlobalPipes(
	new ValidationPipe({
		whitelist: true, // Strip unknown properties
		transform: true, // Type coercion
		forbidNonWhitelisted: true // Reject unknown properties with 400
	})
);
```

Pipes can also be applied per-parameter:

```typescript
@Get(':id')
async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
}
```

## Handler Execution

The controller method runs with validated, transformed parameters and the authenticated user available via `@CurrentUser()`:

```typescript
@Post()
async createWork(
    @CurrentUser() user: JwtPayload,
    @Body() createDto: CreateWorkDto,
) {
    return this.service.create(user.sub, createDto);
}
```

## Interceptors (After Handler)

After the handler returns, interceptors run in **reverse** order through RxJS operators:

1. **PostHogInterceptor** (`tap`) -- Tracks the request with duration and status code
2. **SentryInterceptor** (`catchError`) -- Captures any unhandled exception
3. **LoggingInterceptor** (`tap` / `catchError`) -- Logs the response or error

## Exception Filters

If an error escapes all interceptors, NestJS built-in exception filters convert it to an HTTP response:

| Exception Type          | Status Code | Response Body                         |
| ----------------------- | ----------- | ------------------------------------- |
| `BadRequestException`   | 400         | `{ statusCode: 400, message: [...] }` |
| `UnauthorizedException` | 401         | `{ statusCode: 401, message: "..." }` |
| `ConflictException`     | 409         | `{ statusCode: 409, message: "..." }` |
| `ThrottlerException`    | 429         | `{ statusCode: 429, message: "..." }` |
| Unhandled Error         | 500         | `{ statusCode: 500, message: "..." }` |

## Execution Order Summary

```
1. Express Middleware:  body-parser -> helmet -> CORS
2. Guards (in order):  ThrottlerGuard -> JwtAuthGuard
3. Interceptors (before): LoggingInterceptor -> SentryInterceptor -> PostHogInterceptor
4. Pipes:              ValidationPipe
5. Handler:            Controller method
6. Interceptors (after): PostHogInterceptor -> SentryInterceptor -> LoggingInterceptor
7. Exception Filters:  Built-in NestJS filters
```

## Adding Custom Middleware

### Per-Module Middleware

```typescript
@Module({
	/* ... */
})
export class WorksModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(RequestLoggerMiddleware).forRoutes('works');
	}
}
```

### Per-Route Guards

```typescript
@Controller('admin')
@UseGuards(AdminRoleGuard)
export class AdminController {
	// AdminRoleGuard runs after the global guards
}
```

### Per-Route Interceptors

```typescript
@UseInterceptors(CacheInterceptor)
@Get('popular')
async getPopularWorks() {
    // Response will be cached
}
```

## Best Practices

1. **Understand the order** -- Guards run before interceptors, which run before pipes. Errors in guards skip the entire pipeline.

2. **Use `@SkipThrottle()` intentionally** -- Skipping rate limiting should be explicit and documented.

3. **Keep interceptors lean** -- The three global interceptors run on every request. Heavy logic should be in per-route interceptors.

4. **Validate at the pipe level** -- Do not validate input inside the handler. Let the `ValidationPipe` handle it.

5. **Use exception filters for consistency** -- Custom exception filters ensure all errors follow the same response format.

## Troubleshooting

### Request body is empty

Check that `Content-Type: application/json` header is set. The body parser only processes `application/json` and `application/x-www-form-urlencoded`.

### Guard order issues

`APP_GUARD` providers run in the order they are registered in the `providers` array. If `JwtAuthGuard` should run before `ThrottlerGuard`, swap their order.

### Interceptor not firing

Ensure the interceptor is registered as `APP_INTERCEPTOR` or applied with `@UseInterceptors()`. Global interceptors do not apply to middleware.

## Related Documentation

- [Dependency Injection](./dependency-injection.md) -- How guards and interceptors are registered
- [Rate Limiting](../advanced/rate-limiting.md) -- ThrottlerGuard details
- [Security Hardening](../advanced/security-hardening.md) -- Guard and validation security
- [Monitoring Deep Dive](../advanced/monitoring-deep-dive.md) -- Interceptor-based monitoring
