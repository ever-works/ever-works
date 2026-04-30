---
id: error-handling
title: API Error Handling
sidebar_label: Error Handling
sidebar_position: 19
---

# API Error Handling

The Ever Works API uses a layered approach to error handling, combining NestJS built-in exception filters, global validation pipes, rate limiting, and structured error responses. This page documents the error handling patterns used throughout the API.

## Error Response Format

All API errors follow a consistent JSON structure:

```json
{
    "statusCode": 400,
    "message": "Descriptive error message",
    "error": "Bad Request"
}
```

For validation errors, the response includes an array of messages:

```json
{
    "statusCode": 400,
    "message": [
        "url must be a URL address",
        "viewportWidth must not be greater than 3840"
    ],
    "error": "Bad Request"
}
```

## Global Validation Pipe

The API bootstraps with a global `ValidationPipe` configured in `main.ts`:

```typescript
app.useGlobalPipes(
    new ValidationPipe({
        whitelist: true,            // Strip unknown properties
        transform: true,            // Auto-transform payloads to DTO instances
        forbidNonWhitelisted: true,  // Reject requests with unknown properties
    }),
);
```

### Validation Behavior

| Setting | Effect |
|---|---|
| `whitelist: true` | Properties not decorated with validators are silently removed |
| `transform: true` | Plain objects are transformed to class instances; query string numbers are parsed |
| `forbidNonWhitelisted: true` | Requests with properties not defined in the DTO receive a 400 error |

### Validation Decorators Used

The API uses `class-validator` decorators extensively:

| Decorator | Example Usage | Error Message |
|---|---|---|
| `@IsUrl()` | Screenshot URL | "url must be a URL address" |
| `@IsString()` | Directory ID | "directoryId must be a string" |
| `@IsNumber()` | Viewport width | "viewportWidth must be a number" |
| `@IsBoolean()` | Full page flag | "fullPage must be a boolean value" |
| `@IsOptional()` | Optional fields | (no error if absent) |
| `@Min(n)` / `@Max(n)` | Numeric bounds | "viewportWidth must not be less than 320" |
| `@IsIn([...])` | Enum values | "format must be one of: png, jpg, webp" |
| `@IsArray()` | Batch items | "directories must be an array" |
| `@ValidateNested()` | Nested DTOs | Validates child object properties |

## HTTP Exception Types

The API uses standard NestJS HTTP exceptions. Here are the patterns found across the codebase:

### BadRequestException (400)

The most commonly thrown exception, used for invalid user input or misconfigured resources:

```typescript
// Missing configuration
throw new BadRequestException({
    status: 'error',
    message: 'No screenshot provider configured',
});

// Invalid credentials
throw new BadRequestException({
    status: 'error',
    message: 'Vercel token is required. Please configure it in Plugin Settings.',
});

// Missing OAuth code
throw new BadRequestException('Authorization code is required');

// Invalid state
throw new BadRequestException('Invalid state parameter');
```

### HttpException (Various)

Used by the Twenty CRM integration for proxying upstream errors:

```typescript
// Proxy upstream CRM error with original status code
throw new HttpException(
    {
        message: errorData.message || 'Twenty CRM API error',
        details: errorData.details,
    },
    error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
);

// Service unavailable
throw new HttpException(
    'Failed to communicate with Twenty CRM',
    HttpStatus.SERVICE_UNAVAILABLE,
);
```

### UnauthorizedException (401)

Thrown automatically by the `JwtAuthGuard` when no valid JWT is provided, or by Passport when credentials are invalid.

### ForbiddenException (403)

Returned when a guard (e.g., `CrmSyncGuard`, `ThrottlerGuard`) blocks the request. The `CrmSyncGuard` returns `false` from `canActivate()`, which NestJS converts to a 403.

### Error (500)

Internal errors thrown within services are not caught by specific exception handlers and result in a generic 500:

```typescript
throw new Error('Git provider token not available');
throw new Error('GitHub plugin not available for CI/CD operations');
```

## Rate Limiting

The API uses `@nestjs/throttler` with three tiers, registered globally:

```typescript
export const throttlerConfig: ThrottlerModuleOptions = {
    throttlers: [
        { name: 'short',  ttl: 1000,   limit: 50   },
        { name: 'medium', ttl: 10000,  limit: 300  },
        { name: 'long',   ttl: 60000,  limit: 1000 },
    ],
};
```

| Tier | Window | Max Requests | Use Case |
|---|---|---|---|
| `short` | 1 second | 50 | Burst protection |
| `medium` | 10 seconds | 300 | Sustained request limiting |
| `long` | 1 minute | 1000 | Overall rate cap |

The `ThrottlerGuard` is registered as a global guard via `APP_GUARD`. When a limit is exceeded, the response is:

```json
{
    "statusCode": 429,
    "message": "ThrottlerException: Too Many Requests"
}
```

## Logging Interceptor Error Handling

The `LoggingInterceptor` catches errors in the response pipeline and logs them:

```typescript
return next.handle().pipe(
    catchError((err) => {
        const response = err?.response || { statusCode: 500 };
        this.logger.error(
            `Error Response: ${method} ${originalUrl} ${statusCode || 400} - ${delay}ms`,
        );
        return throwError(() => err);
    }),
);
```

The interceptor only activates when `config.debug()` returns `true`. It logs the HTTP method, URL, status code, and response time for both successful and failed requests.

## Monitoring Integration

Two additional interceptors capture errors for external monitoring:

### SentryInterceptor

Captures unhandled exceptions and sends them to Sentry for error tracking. Configured via `SENTRY_DSN`.

### PostHogInterceptor

Tracks API usage events and errors in PostHog for product analytics. Configured via `POSTHOG_API_KEY`.

Both are registered as global interceptors in `ApiModule`:

```typescript
{ provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
{ provide: APP_INTERCEPTOR, useClass: PostHogInterceptor },
```

## Error Handling Patterns by Module

### Screenshot Capability

```typescript
if (!this.screenshotFacade.isAvailable()) {
    throw new BadRequestException({
        status: 'error',
        message: 'No screenshot provider configured',
    });
}
```

### Deploy Capability

```typescript
if (!isConfigured) {
    throw new BadRequestException({
        status: 'error',
        message: isCreator
            ? `${providerName} token is required. Configure it in Plugin Settings.`
            : `The directory owner has not configured ${providerName} credentials.`,
    });
}
```

### Git Provider / OAuth

Uses try-catch with graceful degradation:

```typescript
try {
    const organizations = await this.gitProviderService.getOrganizations(...);
    return { success: true, organizations };
} catch (error) {
    return {
        success: false,
        organizations: [],
        error: error instanceof Error ? error.message : 'Failed to fetch organizations',
    };
}
```

### CRM Integration

Structured error forwarding with details:

```typescript
throw new HttpException(
    {
        message: errorData.message || 'Twenty CRM API error',
        details: errorData.details,
    },
    error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
);
```

## Security Headers

The API uses Helmet middleware for security headers. API documentation routes (`/api/docs`) use a relaxed CSP to allow Scalar's inline scripts:

```typescript
app.use((req, res, next) => {
    if (req.path.startsWith('/api/docs')) {
        return helmet({ contentSecurityPolicy: { /* relaxed */ } })(req, res, next);
    }
    return helmet()(req, res, next);
});
```

## CORS Configuration

```typescript
app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});
```

CORS violations result in a browser-side error (no server response body).

## Source Files

| File | Purpose |
|---|---|
| `apps/api/src/main.ts` | Global pipes, CORS, Helmet, validation |
| `apps/api/src/api.module.ts` | Global guards and interceptors registration |
| `apps/api/src/logging.interceptor.ts` | Debug logging interceptor |
| `apps/api/src/config/throttler.config.ts` | Rate limiting configuration |
