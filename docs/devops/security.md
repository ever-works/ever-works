---
id: security
title: Security Configuration
sidebar_label: Security
sidebar_position: 7
---

# Security Configuration

Ever Works implements multiple security layers including JWT authentication, OAuth integration, rate limiting, CORS protection, and role-based access control. The security infrastructure lives primarily in `apps/api/src/auth/` with supporting entities in `packages/agent/src/entities/`.

## Authentication

### JWT Authentication

The platform uses JSON Web Tokens (JWT) for API authentication. The implementation is built on Passport.js with the `passport-jwt` strategy.

#### JWT Strategy

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor() {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: jwtConstants.secret
		});
	}
}
```

Tokens are extracted from the `Authorization: Bearer <token>` header and validated against the `JWT_SECRET` environment variable.

#### JWT Guard

The `JwtAuthGuard` is applied globally and protects all routes by default:

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
	canActivate(context: ExecutionContext) {
		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
			context.getHandler(),
			context.getClass()
		]);
		if (isPublic) {
			return true;
		}
		return super.canActivate(context);
	}
}
```

Routes are opted out of authentication using the `@Public()` decorator, which sets metadata read by the guard.

#### Public Decorator

```typescript
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Usage:

```typescript
@Public()
@Get('health')
healthCheck() { return { status: 'ok' }; }
```

### Token Lifecycle

#### Access Tokens

- Short-lived JWT tokens.
- Expiration configured via `JWT_EXPIRATION_TIME` (e.g., `3600s`).
- Contain user ID, email, and username in the payload.

#### Refresh Tokens

The `RefreshToken` entity supports secure token rotation:

| Field                    | Purpose                              |
| ------------------------ | ------------------------------------ |
| `token`                  | Unique token string (indexed)        |
| `family`                 | Groups tokens for rotation detection |
| `revoked`                | Whether the token has been revoked   |
| `revokedReason`          | Why the token was revoked            |
| `userAgent`, `ipAddress` | Device fingerprinting                |
| `expiresAt`              | Token expiration (indexed)           |

**Token rotation flow**:

1. Client sends a refresh token.
2. Server validates the token, checks it is not revoked, and verifies expiry.
3. The old token is revoked.
4. A new access + refresh token pair is issued in the same family.
5. If a revoked token is reused, the entire family is revoked (potential token theft detected).

### Password Security

Passwords are hashed using bcrypt with configurable salt rounds:

```typescript
const hashedPassword = await bcrypt.hash(password, authConstants.bcryptSaltRounds);
```

Validation uses `bcrypt.compare()` to verify passwords without exposing the hash.

### Email Verification

User registration triggers an email verification flow:

1. A random verification token is generated via `randomBytes()`.
2. The token and expiry are stored on the User entity.
3. A `UserCreatedEvent` is emitted (handled by the mail system).
4. The user clicks the verification link, which validates the token.

### Password Reset

The password reset flow:

1. User requests a reset via their email.
2. A `passwordResetToken` and `passwordResetExpires` are set on the User entity.
3. A `UserForgotPasswordEvent` is emitted to send the reset email.
4. The user submits a new password with the reset token.

## OAuth Integration

### Supported Providers

| Provider   | Environment Variables                                             |
| ---------- | ----------------------------------------------------------------- |
| **GitHub** | `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_CALLBACK_URL`             |
| **Google** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` |

### OAuth Flow

1. User initiates OAuth login (redirect to provider).
2. Provider redirects back to the callback URL with an authorization code.
3. The `AuthService` exchanges the code for access and refresh tokens.
4. Tokens are stored in the `OAuthToken` entity per provider per user.
5. If the user does not exist, a new account is created with `registrationProvider` set to the OAuth provider name.
6. JWT access + refresh tokens are issued for the session.

### OAuth Token Storage

```typescript
@Entity({ name: 'oauth_tokens' })
export class OAuthToken {
	provider: string; // 'github', 'google'
	accessToken: string; // Provider access token
	refreshToken: string; // Provider refresh token
	scope: string; // Granted scopes
	metadata: Record<string, any>; // Provider-specific data
}
```

GitHub tokens include specific scopes for repository operations (configured in `github-scopes.config.ts`).

## Rate Limiting

The API uses `@nestjs/throttler` with three concurrent tiers:

```typescript
export const throttlerConfig: ThrottlerModuleOptions = {
	throttlers: [
		{ name: 'short', ttl: 1000, limit: 50 },
		{ name: 'medium', ttl: 10000, limit: 300 },
		{ name: 'long', ttl: 60000, limit: 1000 }
	]
};
```

| Tier       | Window     | Limit | Purpose            |
| ---------- | ---------- | ----- | ------------------ |
| **short**  | 1 second   | 50    | Burst protection   |
| **medium** | 10 seconds | 300   | Sustained load     |
| **long**   | 1 minute   | 1000  | Per-minute ceiling |

All tiers are evaluated simultaneously. A request is rejected if it exceeds any tier's limit.

## CORS Protection

CORS origins are configured via the `ALLOWED_ORIGINS` environment variable:

```
ALLOWED_ORIGINS=https://app.ever.works,https://api.ever.works
```

In production, only the web application and API domains are allowed. Development environments can use `*` for convenience.

## Role-Based Access Control

### Work Roles

The `WorkMemberRole` enum defines four access levels:

| Role        | Level | Capabilities                                 |
| ----------- | ----- | -------------------------------------------- |
| **OWNER**   | 4     | Full access (implicit for work creator) |
| **MANAGER** | 3     | Edit content, manage members                 |
| **EDITOR**  | 2     | Edit content                                 |
| **VIEWER**  | 1     | Read-only                                    |

The OWNER role is never directly assigned to a member. It is inferred from `work.userId`. Only MANAGER, EDITOR, and VIEWER can be assigned to members.

### Access Checks

The `Work` entity provides access control methods:

```typescript
// Check if user has any access
work.hasAccess(userId): boolean

// Get user's role
work.getUserRole(userId): WorkMemberRole | null

// Check specific member capabilities
member.hasRoleOrHigher(WorkMemberRole.EDITOR): boolean
member.canManageMembers(): boolean
member.canEdit(): boolean
```

## Data Sanitization

### Sentry Integration

The Sentry interceptor sanitizes request data before transmission:

- **Headers**: Removes `authorization` and `cookie`.
- **Body**: Removes `password`, `token`, `secret`.

### Auth Route Exclusion

All `/auth` endpoints are excluded from Sentry error and performance tracking to prevent sensitive authentication data from being captured.

## Security Headers & Environment

### Production Environment Variables

| Variable              | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `JWT_SECRET`          | Signing key for JWT tokens                 |
| `JWT_EXPIRATION_TIME` | Token lifetime (e.g., `3600s`)             |
| `AUTH_SECRET`         | General auth secret (used by Next.js Auth) |
| `ALLOWED_ORIGINS`     | CORS whitelist                             |
| `DATABASE_SSL_MODE`   | Require TLS for database connections       |
| `DATABASE_CA_CERT`    | Certificate authority for database TLS     |

### Docker Security

- Production containers run as the non-root `node` user.
- File ownership is explicitly set with `--chown=node:node`.
- Only built artifacts (`dist/`, `node_modules/`) are included in the final image.
- Source code, test files, and development dependencies are excluded.

### Kubernetes Secrets

All sensitive configuration is stored as Kubernetes secrets and injected via environment variables during deployment. No secrets are embedded in images or manifests committed to version control.

## User Status

The `User` entity includes status tracking:

| Field           | Purpose                                     |
| --------------- | ------------------------------------------- |
| `isActive`      | Soft-disable user accounts (default `true`) |
| `emailVerified` | Email confirmation status                   |
| `lastLoginAt`   | Last successful login timestamp             |
| `lastLoginIp`   | IP address of last login                    |

The `AuthService.ensureUserIsActive()` method checks `isActive` before allowing login, enabling administrators to disable accounts without deleting data.
