---
id: guards-interceptors
title: Guards & Interceptors
sidebar_label: Guards & Interceptors
sidebar_position: 20
---

# Guards & Interceptors

The Ever Works API uses NestJS guards and interceptors as middleware layers for authentication, authorization, rate limiting, logging, and monitoring. This page documents all guards, interceptors, decorators, and middleware registered in the application.

## Execution Pipeline

NestJS processes requests through a well-defined pipeline. Here is the order for the Ever Works API:

```
Incoming Request
  --> Helmet Middleware (security headers)
  --> CORS Middleware
  --> Express body-parser (10MB limit)
  --> Global Guards
      ├── JwtAuthGuard (authentication)
      └── ThrottlerGuard (rate limiting)
  --> Route-specific Guards
      └── CrmSyncGuard, LocalAuthGuard, etc.
  --> Global Interceptors
      ├── LoggingInterceptor
      ├── SentryInterceptor
      └── PostHogInterceptor
  --> Global Pipes
      └── ValidationPipe
  --> Controller Method
  --> Response
```

## Global Guards

Global guards are registered in `ApiModule` using the `APP_GUARD` token:

```typescript
@Module({
    providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class ApiModule {}
```

### JwtAuthGuard

**Source:** `apps/api/src/auth/guards/jwt-auth.guard.ts`

The primary authentication guard, applied globally to all routes. It extends Passport's `AuthGuard('jwt')` and adds support for the `@Public()` decorator.

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private reflector: Reflector) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }
        return super.canActivate(context);
    }
}
```

**Behavior:**

| Scenario | Result |
|---|---|
| Valid JWT in `Authorization: Bearer` header | Request proceeds; `request.user` populated |
| Missing or invalid JWT | `401 Unauthorized` |
| Route decorated with `@Public()` | Guard skipped; request proceeds without auth |

**Key Feature:** The guard checks both the handler method and the controller class for the `IS_PUBLIC_KEY` metadata using `getAllAndOverride`, meaning `@Public()` can be applied at either level.

### ThrottlerGuard

The global rate limiter from `@nestjs/throttler`, configured with three tiers:

| Tier | Time Window | Max Requests |
|---|---|---|
| `short` | 1 second | 50 |
| `medium` | 10 seconds | 300 |
| `long` | 1 minute | 1000 |

When any tier limit is exceeded, the guard returns `429 Too Many Requests`.

## Route-Specific Guards

### LocalAuthGuard

**Source:** `apps/api/src/auth/guards/local-auth.guard.ts`

Used on the login endpoint to authenticate with username/password credentials via Passport's local strategy.

```typescript
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```

Applied only to the login route:

```typescript
@UseGuards(LocalAuthGuard)
@Post('login')
async login(@Request() req) { ... }
```

### CrmSyncGuard

**Source:** `apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts`

A feature-flag guard that blocks CRM-related requests when the integration is disabled or misconfigured.

```typescript
@Injectable()
export class CrmSyncGuard implements CanActivate {
    constructor(private readonly configService: CrmConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        if (!this.configService.isEnabled) {
            this.logger.warn('CRM integration is disabled - request blocked');
            return false;
        }

        try {
            this.configService.validateConfig();
            return true;
        } catch (error) {
            this.logger.error('CRM configuration validation failed:', error);
            return false;
        }
    }
}
```

| Check | Failure Result |
|---|---|
| `isEnabled` is false | `403 Forbidden` with warning log |
| `validateConfig()` throws | `403 Forbidden` with error log |
| Both pass | Request proceeds |

## Global Interceptors

Registered in `ApiModule` using the `APP_INTERCEPTOR` token:

```typescript
@Module({
    providers: [
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
        { provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
        { provide: APP_INTERCEPTOR, useClass: PostHogInterceptor },
    ],
})
```

### LoggingInterceptor

**Source:** `apps/api/src/logging.interceptor.ts`

Logs HTTP request/response details when debug mode is enabled.

```typescript
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private logger = new Logger('HTTP');

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (!config.debug()) {
            return next.handle(); // No-op when debug disabled
        }

        const now = Date.now();
        const { method, originalUrl } = request;

        this.logger.log(`Incoming Request: ${method} ${originalUrl}`);

        return next.handle().pipe(
            catchError((err) => {
                const delay = Date.now() - now;
                this.logger.error(`Error Response: ${method} ${originalUrl} ${statusCode} - ${delay}ms`);
                return throwError(() => err);
            }),
            tap(() => {
                const delay = Date.now() - now;
                this.logger.log(`Outgoing Response: ${method} ${originalUrl} ${statusCode} - ${delay}ms`);
            }),
        );
    }
}
```

**Output Examples:**

```
[HTTP] Incoming Request: POST /api/deploy/directories/abc123
[HTTP] Outgoing Response: POST /api/deploy/directories/abc123 200 - 342ms
[HTTP] Error Response: POST /api/screenshot/capture 400 - 15ms
```

### SentryInterceptor

**Source:** `@ever-works/monitoring`

Captures unhandled exceptions and forwards them to Sentry for real-time error tracking. Configured via:

```typescript
MonitoringModule.forRoot({
    sentry: {
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
    },
})
```

### PostHogInterceptor

**Source:** `@ever-works/monitoring`

Tracks API usage events and errors in PostHog for product analytics. Configured via:

```typescript
MonitoringModule.forRoot({
    posthog: {
        apiKey: process.env.POSTHOG_API_KEY,
        host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    },
})
```

## Custom Decorators

### @Public()

**Source:** `apps/api/src/auth/decorators/public.decorator.ts`

Marks a route or controller as publicly accessible, bypassing JWT authentication.

```typescript
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

**Usage:**

```typescript
@Public()
@Get('health')
healthCheck() {
    return { status: 'ok' };
}
```

### @CurrentUser()

**Source:** `apps/api/src/auth/decorators/user.decorator.ts`

Parameter decorator that extracts the authenticated user from the request.

```typescript
export const CurrentUser = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        return request.user;
    },
);
```

**Usage:**

```typescript
@Post('deploy')
async deploy(@CurrentUser() auth: AuthenticatedUser) {
    // auth.userId is available
}
```

The returned `AuthenticatedUser` object contains at minimum `userId` and other JWT claims.

### @CrmSync()

**Source:** `apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts`

Metadata decorator for marking routes that require CRM synchronization:

```typescript
export const CRM_SYNC_KEY = 'crm_sync';
export const CrmSync = (enabled: boolean = true) => SetMetadata(CRM_SYNC_KEY, enabled);
```

## Middleware Stack

### Helmet

Security headers middleware applied in `main.ts`. Uses a relaxed Content Security Policy for the API documentation route (`/api/docs`) to support Scalar's inline scripts:

```typescript
// Documentation routes: relaxed CSP
helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
        },
    },
})

// All other routes: strict defaults
helmet()
```

### CORS

Cross-Origin Resource Sharing configured for the web frontend:

```typescript
app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});
```

### Body Parser

Increased payload limits for large requests:

```typescript
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ limit: '10mb', extended: true }));
```

## Guard Application Patterns

### Controller-Level Guard

```typescript
@Controller('api/twenty-crm/companies')
@UseGuards(JwtAuthGuard)
export class CompaniesController { ... }
```

### Method-Level Guard

```typescript
@UseGuards(LocalAuthGuard)
@Post('login')
async login() { ... }
```

### Global Guard (all routes)

```typescript
{ provide: APP_GUARD, useClass: JwtAuthGuard }
```

## Source Files

| File | Purpose |
|---|---|
| `apps/api/src/auth/guards/jwt-auth.guard.ts` | JWT authentication guard |
| `apps/api/src/auth/guards/local-auth.guard.ts` | Username/password auth guard |
| `apps/api/src/auth/decorators/public.decorator.ts` | `@Public()` decorator |
| `apps/api/src/auth/decorators/user.decorator.ts` | `@CurrentUser()` decorator |
| `apps/api/src/logging.interceptor.ts` | HTTP logging interceptor |
| `apps/api/src/api.module.ts` | Global guard/interceptor registration |
| `apps/api/src/main.ts` | Middleware and pipe configuration |
| `apps/api/src/config/throttler.config.ts` | Rate limiter configuration |
| `apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts` | CRM feature guard |
| `apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts` | CRM sync decorator |
