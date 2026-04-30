---
id: security-hardening
title: Security Hardening
sidebar_label: Security Hardening
sidebar_position: 12
---

# Security Hardening

The Ever Works platform implements multiple layers of security, from HTTP headers and CORS to input validation, authentication guards, and data sanitization. This guide covers the full security configuration as implemented in the codebase.

## Security Architecture

```
    Incoming Request
          |
    +-----v------+
    |   Helmet    |  HTTP security headers (CSP, HSTS, X-Frame-Options)
    +-----+------+
          |
    +-----v------+
    |    CORS     |  Origin validation, credential control
    +-----+------+
          |
    +-----v------+
    | Body Parser |  Payload size limits (10MB)
    +-----+------+
          |
    +-----v------+
    | ThrottlerGuard |  Rate limiting (see rate-limiting.md)
    +-----+------+
          |
    +-----v------+
    | JwtAuthGuard |  Authentication (unless @Public())
    +-----+------+
          |
    +-----v------+
    | ValidationPipe |  Input sanitization (whitelist, transform)
    +-----+------+
          |
    +-----v------+
    |   Handler   |  Business logic
    +-----+------+
          |
    +-----v------+
    | SentryInterceptor | Sanitized error reporting
    +-------------+
```

## Helmet Configuration

Helmet sets security-critical HTTP headers. The platform uses conditional CSP to allow the API documentation UI to function while keeping all other routes locked down.

From `apps/api/src/main.ts`:

```typescript
// Relaxed CSP for API docs (Scalar requires inline scripts)
app.use((req, res, next) => {
	if (req.path.startsWith('/api/docs')) {
		return helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'", "'unsafe-inline'"],
					styleSrc: ["'self'", "'unsafe-inline'"],
					imgSrc: ["'self'", 'data:', 'https:']
				}
			}
		})(req, res, next);
	}
	// Strict defaults for all other routes
	return helmet()(req, res, next);
});
```

### Headers Set by Helmet

| Header                              | Value              | Purpose                          |
| ----------------------------------- | ------------------ | -------------------------------- |
| `X-Content-Type-Options`            | `nosniff`          | Prevent MIME type sniffing       |
| `X-Frame-Options`                   | `SAMEORIGIN`       | Prevent clickjacking             |
| `X-XSS-Protection`                  | `0`                | Disable legacy XSS auditor       |
| `Strict-Transport-Security`         | `max-age=15552000` | Force HTTPS (production)         |
| `Content-Security-Policy`           | Strict defaults    | Prevent XSS, injection           |
| `X-DNS-Prefetch-Control`            | `off`              | Disable DNS prefetching          |
| `X-Download-Options`                | `noopen`           | Prevent auto-open downloads (IE) |
| `X-Permitted-Cross-Domain-Policies` | `none`             | Restrict Flash/Acrobat access    |

## CORS Configuration

CORS is configured with an explicit allowlist of origins:

```typescript
app.enableCors({
	origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization']
});
```

### Production CORS Setup

```bash
# .env
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

Never use `origin: true` or `origin: '*'` in production. Always specify the exact domains that should be allowed.

## Input Validation and Sanitization

The global `ValidationPipe` is the primary defense against malformed or malicious input:

```typescript
app.useGlobalPipes(
	new ValidationPipe({
		whitelist: true, // Strip properties not in DTO
		transform: true, // Auto-transform types
		forbidNonWhitelisted: true // Throw on unknown properties
	})
);
```

### How It Protects

| Setting                | Protection                                          |
| ---------------------- | --------------------------------------------------- |
| `whitelist: true`      | Removes any properties not defined in the DTO class |
| `transform: true`      | Converts string "123" to number 123 per DTO types   |
| `forbidNonWhitelisted` | Returns 400 if unknown properties are sent          |

### DTO Validation Example

```typescript
import { IsString, IsEmail, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
	@IsString()
	@MinLength(2)
	@MaxLength(50)
	username: string;

	@IsEmail()
	email: string;

	@IsString()
	@MinLength(8)
	@MaxLength(128)
	password: string;
}
```

## Authentication Security

### JWT Guard (Global)

The `JwtAuthGuard` is registered as `APP_GUARD`, meaning every route requires authentication unless explicitly marked `@Public()`:

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
	constructor(private reflector: Reflector) {
		super();
	}

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

### Password Security

Passwords are hashed with bcrypt at 10 salt rounds:

```typescript
const hashedPassword = await bcrypt.hash(password, authConstants.bcryptSaltRounds);
```

### Refresh Token Rotation

The platform implements refresh token rotation with family tracking to detect token reuse:

```typescript
// Token reuse detection (security: compromised token detection)
if (tokenData.revoked) {
	// Revoke ALL tokens in the family
	await this.refreshTokenRepository.revokeTokenFamily(tokenData.family, 'Token reuse detected');
	throw new UnauthorizedException('Token reuse detected');
}
```

### JWT Payload

The JWT includes essential claims with issuer and audience validation:

```typescript
const payload: JwtPayload = {
	sub: user.id,
	email: user.email,
	provider: user.registrationProvider,
	iat: Math.floor(Date.now() / 1000),
	iss: 'ever-works-api',
	aud: 'ever-works-users'
};
```

## Payload Size Limits

The API limits request body size to prevent denial-of-service via large payloads:

```typescript
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ limit: '10mb', extended: true }));
```

## Data Sanitization in Monitoring

The `SentryInterceptor` sanitizes sensitive data before sending to external services:

```typescript
private sanitizeHeaders(headers: any): any {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    return sanitized;
}

private sanitizeBody(body: any): any {
    if (!body) return body;
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    return sanitized;
}
```

## Security Checklist for Production

```
[x] ALLOWED_ORIGINS set to specific production domains
[x] JWT_SECRET set to a strong, unique secret (not the default)
[x] SENTRY_DSN auth events filtered via beforeSend
[x] DATABASE_AUTOMIGRATE=false (use migrations)
[x] HTTPS enforced at load balancer / reverse proxy
[x] Rate limiting configured (see rate-limiting.md)
[x] Body size limits applied (10MB)
[x] Helmet enabled with strict CSP
[x] bcrypt salt rounds >= 10
[x] Token rotation with family-based reuse detection
[x] Sensitive fields stripped from error reports
```

## Best Practices

1. **Default to closed** -- The `JwtAuthGuard` as `APP_GUARD` means all new routes require auth unless you opt out with `@Public()`.

2. **Validate everything** -- Every DTO should use `class-validator` decorators. The `forbidNonWhitelisted` setting catches extra properties.

3. **Rotate JWT secrets** -- Change `JWT_SECRET` periodically. Use a secret manager, not hardcoded values.

4. **Never log secrets** -- The sanitization patterns in `SentryInterceptor` show how to strip sensitive data before external transmission.

5. **Use environment-specific CSP** -- Only relax CSP for API docs routes, keep strict defaults everywhere else.

## Troubleshooting

### CORS errors in the browser

Check that the request origin is listed in `ALLOWED_ORIGINS`. The `credentials: true` setting requires exact origin matching (no wildcards).

### 401 on new endpoints

New routes require authentication by default. Add `@Public()` if the route should be accessible without a JWT.

### Password reset tokens expiring immediately

The reset token has a 1-hour expiry. Verify server clocks are synchronized, especially in containerized environments.

## Related Documentation

- [Rate Limiting](./rate-limiting.md) -- Throttler guard configuration
- [Middleware Pipeline](../architecture/middleware-pipeline.md) -- Guard and pipe execution order
- [Configuration Management](../architecture/configuration-management.md) -- Secret management
- [Monitoring Deep Dive](./monitoring-deep-dive.md) -- Error tracking with sanitization
