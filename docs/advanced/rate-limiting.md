---
id: rate-limiting
title: Rate Limiting
sidebar_label: Rate Limiting
sidebar_position: 9
---

# Rate Limiting

The Ever Works platform uses the NestJS Throttler module to protect API endpoints from abuse. The system implements a multi-tier rate limiting strategy with short, medium, and long windows applied globally via guards.

## Architecture Overview

```
                    Incoming Request
                          |
                    +-----v------+
                    | ThrottlerGuard |  (APP_GUARD - applied globally)
                    +-----+------+
                          |
              +-----------+-----------+
              |           |           |
         +----v---+  +---v----+  +---v----+
         | Short  |  | Medium |  |  Long  |
         | 1s/50  |  | 10s/300|  | 60s/1k |
         +----+---+  +---+----+  +---+----+
              |           |           |
              +-----+-----+-----------+
                    |
              All pass? --> Route Handler
              Any fail? --> 429 Too Many Requests
```

## Configuration

The throttler configuration lives in `apps/api/src/config/throttler.config.ts` and defines three concurrent rate windows:

```typescript
// apps/api/src/config/throttler.config.ts
import { ThrottlerModuleOptions } from '@nestjs/throttler';

export const throttlerConfig: ThrottlerModuleOptions = {
    throttlers: [
        {
            name: 'short',
            ttl: 1000,       // 1 second window
            limit: 50,       // 50 requests per second
        },
        {
            name: 'medium',
            ttl: 10000,      // 10 second window
            limit: 300,      // 300 requests per 10 seconds
        },
        {
            name: 'long',
            ttl: 60000,      // 60 second window
            limit: 1000,     // 1000 requests per minute
        },
    ],
};
```

The module is registered globally in `ApiModule`:

```typescript
// apps/api/src/api.module.ts
@Module({
    imports: [
        ThrottlerModule.forRoot(throttlerConfig),
        // ...
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
    ],
})
export class ApiModule {}
```

## How Multi-Tier Throttling Works

Each incoming request is checked against all three windows simultaneously. A request is only allowed through if it satisfies **all** tiers:

| Tier   | Window | Limit | Purpose                                  |
|--------|--------|-------|------------------------------------------|
| Short  | 1s     | 50    | Burst protection against rapid-fire calls|
| Medium | 10s    | 300   | Sustained traffic smoothing              |
| Long   | 60s    | 1000  | Overall per-minute cap                   |

By default, the Throttler uses the client IP address as the tracking key.

## Per-Route Customization

Override the global limits on specific routes using the `@Throttle()` decorator:

```typescript
import { Throttle, SkipThrottle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
    // Stricter limit for login attempts (5 per 60 seconds)
    @Throttle([{ name: 'long', ttl: 60000, limit: 5 }])
    @Post('login')
    async login(@Body() loginDto: LoginDto) {
        // ...
    }

    // Skip throttling entirely for health checks
    @SkipThrottle()
    @Get('status')
    getStatus() {
        return { status: 'ok' };
    }
}
```

## User-Based Rate Limiting

To rate-limit by authenticated user instead of IP, extend the `ThrottlerGuard`:

```typescript
import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable, ExecutionContext } from '@nestjs/common';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        // Use user ID if authenticated, fall back to IP
        return req.user?.sub || req.ip;
    }
}
```

Register as an APP_GUARD replacement or apply per-controller:

```typescript
@UseGuards(UserThrottlerGuard)
@Controller('directories')
export class DirectoriesController {
    // All routes in this controller use user-based throttling
}
```

## Sensitive Endpoint Protection

Critical endpoints like authentication and password reset should have tighter limits:

```typescript
// Recommended limits for sensitive endpoints
const SENSITIVE_LIMITS = {
    login:          { ttl: 60000,  limit: 5  },   // 5 attempts/min
    register:       { ttl: 3600000, limit: 10 },   // 10 registrations/hour
    forgotPassword: { ttl: 3600000, limit: 3  },   // 3 resets/hour
    verifyEmail:    { ttl: 60000,  limit: 10 },    // 10 verifications/min
};
```

## Response Headers

When rate limiting is active, the Throttler module sets standard headers on every response:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 997
X-RateLimit-Reset: 1709654400
Retry-After: 42          (only on 429 responses)
```

## Storage Backends

By default, Throttler uses in-memory storage. For multi-instance deployments, switch to Redis:

```typescript
import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';

ThrottlerModule.forRoot({
    throttlers: throttlerConfig.throttlers,
    storage: new ThrottlerStorageRedisService({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
    }),
});
```

## Best Practices

1. **Keep global limits generous** -- The default 1000 req/min is appropriate for most API consumers. Tighten only on sensitive endpoints.

2. **Use per-user tracking for authenticated routes** -- IP-based throttling can be too aggressive when many users share a single IP (corporate proxies, NAT).

3. **Separate read and write limits** -- GET endpoints can tolerate higher limits than POST/PUT/DELETE.

4. **Monitor 429 responses** -- Track rate limit rejections in your monitoring dashboard to detect legitimate users hitting limits.

5. **Combine with the security middleware** -- Rate limiting works alongside Helmet and CORS (see [Security Hardening](./security-hardening.md)).

## Troubleshooting

### "Too Many Requests" errors in development

The default limits are generous, but hot-reload during development can trigger them. Either increase limits in development or skip throttling:

```typescript
ThrottlerModule.forRoot({
    throttlers: process.env.NODE_ENV === 'development'
        ? [{ name: 'dev', ttl: 1000, limit: 10000 }]
        : throttlerConfig.throttlers,
});
```

### Rate limits not applying to certain routes

Check if the route uses the `@Public()` decorator -- this skips the JWT guard but NOT the throttler. Throttling still applies. If throttling is explicitly skipped, check for `@SkipThrottle()`.

### Multiple instances counting separately

In production with multiple API replicas, each instance maintains its own in-memory counter. Use Redis storage (shown above) so all instances share a single counter pool.

## Related Documentation

- [Security Hardening](./security-hardening.md) -- Helmet, CORS, and CSP configuration
- [Middleware Pipeline](../architecture/middleware-pipeline.md) -- Guard execution order
- [Kubernetes Deployment](../devops/kubernetes.md) -- Multi-replica deployments
- [Monitoring Deep Dive](./monitoring-deep-dive.md) -- Tracking 429 responses
