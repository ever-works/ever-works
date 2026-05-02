# Architecture: Authentication & Authorisation

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers debugging auth flows, adding new
auth methods, or hardening permissions.

---

## 1. Purpose

Every Ever Works API request crosses one of three authentication
front-doors and resolves to an `AuthenticatedUser`. This spec covers
how those front-doors compose, how OAuth providers plug in, where
permissions are enforced (vs where the platform leaves them to the
caller), and how the CLI / MCP server / dashboard flows differ.

## 2. The Front Doors

| Front door         | Header                                                      | Spec                                                     | Used by                            |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| **JWT Bearer**     | `Authorization: Bearer <jwt>`                               | The dashboard after login                                | Web UI                             |
| **API key**        | `x-api-key: ew_live_…` or `Authorization: Bearer ew_live_…` | [`features/api-keys/spec`](../features/api-keys/spec.md) | CI, CLI, MCP server                |
| **OAuth callback** | `?code=...&state=...` on `/api/auth/<provider>/callback`    | This spec, §5                                            | First-party login (GitHub, Google) |
| **Device flow**    | Polling against `/api/auth/device/...`                      | This spec, §6                                            | The public CLI on first login      |

The auth guard fans incoming requests out to the right validator based
on the value's prefix and falls through to JWT when nothing else
matches. Anything that fails all of them returns `401`.

## 3. The Module Layout

```
apps/api/src/auth/
├── auth.module.ts
├── controllers/                # /api/auth/* HTTP surface
├── decorators/
│   ├── public.decorator.ts     # @Public() — opt out of auth
│   └── user.decorator.ts       # @CurrentUser() — inject AuthenticatedUser
├── guards/
│   └── auth-session.guard.ts   # The composite guard fanning out to all front doors
├── providers/                  # OAuth provider abstractions
│   ├── auth-provider.abstract.ts
│   ├── auth-provider.constants.ts
│   ├── auth-provider.service.ts
│   ├── auth-provider.types.ts
│   ├── auth-runtime.instance.ts
│   ├── auth-sync.service.ts
│   └── request-headers.ts
├── services/
│   ├── auth.service.ts         # Issuance, validation, user resolution
│   ├── api-key.service.ts      # API-key CRUD + auth (see api-keys spec)
│   └── social-auth.service.ts  # OAuth-provider-driven sign-in
├── dto/                        # Login / register / OAuth callback DTOs
├── config/                     # Auth-related config validation
└── types/
```

## 4. JWT Issuance

JWTs are issued by `AuthService` after one of:

- **Email + password registration** → email verification → `POST
/api/auth/login`.
- **OAuth sign-in** → provider exchanges code → user resolved or
  created → JWT issued.

The token payload includes:

| Claim   | Source                                 |
| ------- | -------------------------------------- |
| `sub`   | User UUID                              |
| `email` | User email                             |
| `iat`   | Issued-at Unix timestamp               |
| `exp`   | Expiry (default: 7 days, configurable) |
| `roles` | Platform roles (`user`, `admin`)       |

There are **no per-directory roles in the JWT** — those are resolved
fresh on every request via `DirectoryOwnershipService` so role changes
propagate immediately (see
[`features/directory-members/spec`](../features/directory-members/spec.md)).

Refresh tokens are stored server-side keyed by `userId`. Refresh exchanges
old → new and rotates the refresh token (one-time-use).

## 5. OAuth Providers

OAuth is abstracted behind `auth-provider.abstract.ts`'s
`AbstractAuthProvider`. Each provider (GitHub, Google) is a NestJS
service implementing:

```ts
abstract class AbstractAuthProvider {
	abstract readonly id: string; // 'github' / 'google'
	abstract getAuthorizationUrl(state: string): string;
	abstract exchangeCode(code: string): Promise<OAuthTokens>;
	abstract fetchUserProfile(tokens: OAuthTokens): Promise<OAuthProfile>;
	abstract refreshTokens(refresh: string): Promise<OAuthTokens>;
}
```

`AuthProviderService` is the registry — it returns the right provider
for a given id, surfaces them at `/api/auth/<id>/start` and
`/api/auth/<id>/callback`, and stores the resulting OAuth tokens in
the `oauth_tokens` table for later use by `GitFacadeService` / Octokit.

**Important: OAuth tokens are dual-purpose.** When a user signs in via
GitHub OAuth, the same tokens are saved against their account so the
platform can clone their data repos later. Disconnecting an OAuth
provider revokes both the login binding and the git access.

`SocialAuthService` handles the post-OAuth flow:

1. Match `OAuthProfile.email` against existing users.
2. If found, attach the OAuth account to that user (one user can
   have multiple linked OAuth accounts).
3. If not found, create the user and attach the OAuth account.
4. Issue JWT.
5. Store OAuth tokens in `oauth_tokens` keyed by `(userId, providerId)`
   — encrypted with the same envelope as plugin secrets.

## 6. Device Auth Flow (CLI)

The public CLI uses the OAuth **device authorisation grant** to log
in without a browser redirect:

1. CLI: `POST /api/auth/device/start` → server returns
   `{deviceCode, userCode, verificationUri, interval, expiresIn}`.
2. CLI: shows the user the `userCode` and instructs them to open
   `verificationUri` in a browser.
3. CLI: polls `POST /api/auth/device/poll {deviceCode}` every
   `interval` seconds.
4. Browser: user logs in normally and approves the device code.
5. Server: marks the device code as approved.
6. Next CLI poll: server returns `{jwt, refreshToken}`.

This is implemented by an `IDeviceAuthProviderPlugin` implementation
(today only the platform's first-party device-auth provider, but the
plugin contract leaves room for external IDP integrations). See the
[Plugin SDK](./plugin-sdk.md) for the capability shape.

## 7. The Composite Guard

`AuthSessionGuard` is registered globally and runs on every controller
unless the route has `@Public()`. It implements:

```ts
async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.get(Public, ctx.getHandler())) return true;

    const req = ctx.switchToHttp().getRequest();

    // 1. API key path
    const apiKeyHeader = req.headers['x-api-key']
        ?? extractBearer(req.headers.authorization);
    if (apiKeyHeader?.startsWith('ew_live_')) {
        const auth = await this.apiKeyService.authenticate(apiKeyHeader);
        if (!auth) throw new UnauthorizedException();
        req.user = auth;
        return true;
    }

    // 2. JWT path
    const jwt = extractBearer(req.headers.authorization);
    if (!jwt) throw new UnauthorizedException();
    const claims = await this.authService.validateJwt(jwt);
    req.user = { userId: claims.sub, email: claims.email, roles: claims.roles };
    return true;
}
```

The shape stored on `req.user` is `AuthenticatedUser`. Controllers
access it via the `@CurrentUser()` decorator.

## 8. Decorators

| Decorator         | Effect                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `@Public()`       | Skips the guard entirely. Used on `/api/auth/login`, `/api/auth/register`, callbacks, `/api/health`.         |
| `@CurrentUser()`  | Parameter decorator that injects `AuthenticatedUser` (or throws if missing).                                 |
| `@Roles('admin')` | Class/method-level roles guard layered on top of `AuthSessionGuard` (when `auth-roles.guard` is registered). |

`@CurrentUser({ optional: true })` returns `null` instead of throwing
— used on routes that behave differently for anonymous vs authed
visitors.

## 9. Per-Resource Authorisation

`AuthSessionGuard` only proves **who** the caller is. **What they can
do** to a specific resource is enforced separately by domain services:

- `DirectoryOwnershipService.ensureCanRead / ensureCanEdit / ensureCanManage`
  — see [`features/directory-members/spec`](../features/directory-members/spec.md).
- `SubscriptionService.ensureWithinPlan` — for plan-gated operations.
- `ApiKeyService` — manages API keys; rejects API-key-authenticated
  requests on its own endpoints (JWT-only by design).

This split makes it possible for an authenticated user to call an
endpoint they're allowed to call (auth pass) but get `403` because of
their per-directory role (authorisation fail). The dashboard surfaces
both as distinct error states.

## 10. API-Key vs JWT Differences

| Behaviour                    | JWT                   | API key                                                |
| ---------------------------- | --------------------- | ------------------------------------------------------ |
| Lifetime                     | 7 days (refreshable)  | Until revoked or `expiresAt`                           |
| Per-directory role           | Resolved live from DB | Same — keys carry the user's full per-directory rights |
| Manage other API keys        | Allowed               | Rejected (`403`)                                       |
| Manage own account / profile | Allowed               | Rejected (`403`)                                       |
| Connect OAuth providers      | Allowed               | Rejected (`403`)                                       |
| Trigger directory generation | Allowed               | Allowed                                                |
| Run MCP tool calls           | N/A                   | The MCP server's only auth path                        |
| Dashboard sessions           | Yes                   | No                                                     |

API keys are deliberately **second-class for management endpoints** —
they can do work but can't bootstrap their own access.

## 11. Token Storage

| Token               | Storage                                 | Encryption                                    |
| ------------------- | --------------------------------------- | --------------------------------------------- |
| JWT                 | Browser cookie / `Authorization` header | None at rest (signed only)                    |
| Refresh token       | `refresh_tokens` table                  | Hashed (one-way)                              |
| API key             | `api_keys` table — see api-keys spec    | SHA-256 hash + display prefix                 |
| OAuth access token  | `oauth_tokens` table                    | AES-256-GCM (same envelope as plugin secrets) |
| OAuth refresh token | `oauth_tokens` table                    | AES-256-GCM                                   |
| Device-flow code    | `device_auth_codes` table               | None at rest (short TTL)                      |

Encryption keys are configured via `PLUGIN_SECRETS_ENCRYPTION_KEY`
(see [Settings System §5](./settings-system.md)).

## 12. Auth Sync

`AuthSyncService` mirrors **provider-side state** (e.g. revoked GitHub
OAuth grants) into platform state:

- On login, the server checks whether the OAuth refresh token still
  works. If not, the linked account is marked `disconnected`.
- A periodic job re-validates connected accounts and surfaces "git
  provider needs reconnection" banners on the dashboard before users
  hit failing generation runs.

## 13. Public Endpoints

The handful of endpoints that bypass auth entirely:

| Endpoint                             | Reason                   |
| ------------------------------------ | ------------------------ |
| `POST /api/auth/login`               | Login itself             |
| `POST /api/auth/register`            | Registration             |
| `POST /api/auth/refresh`             | Refresh-token exchange   |
| `POST /api/auth/forgot-password`     | Pre-login password reset |
| `POST /api/auth/reset-password`      | Pre-login password reset |
| `GET  /api/auth/<provider>/start`    | OAuth start              |
| `GET  /api/auth/<provider>/callback` | OAuth callback           |
| `POST /api/auth/device/start`        | CLI device-flow start    |
| `POST /api/auth/device/poll`         | CLI device-flow poll     |
| `POST /api/auth/verify-email`        | Email verification       |
| `GET  /api/health`                   | Liveness probe           |

Everything else requires authentication.

## 14. Testing

`apps/api/test/` contains Supertest e2e suites for every front door
plus the device flow. Per-directory authorisation is covered by both
e2e and the
`directory-ownership.service.spec.ts` unit suite. Mocking strategy:

- **Unit tests** mock `AuthSessionGuard` to inject a known
  `AuthenticatedUser`.
- **e2e tests** issue real JWTs via `AuthService.issueTestJwt(...)` to
  avoid logging in through the full flow.
- **OAuth providers** are mocked at the `AbstractAuthProvider` level
  with stubbed `exchangeCode` / `fetchUserProfile`.

## 15. Constitution Reconciliation

| Principle                   | How auth respects it                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| I — Plugin-first            | OAuth providers and device-auth providers are plugins via the SDK contracts. |
| II — Capability-driven      | `oauth` and `device-auth-provider` capabilities resolve through facades.     |
| III — Source-of-truth repos | OAuth tokens are platform-side credentials, stored in DB.                    |
| IV — Trigger.dev            | Auth-sync runs as a Trigger.dev task.                                        |
| V — Forward-only migrations | All auth tables additive over time.                                          |
| VI — Tests                  | Every front door + every provider covered.                                   |
| VII — Secret hygiene        | OAuth tokens encrypted; JWT signed only; API keys hashed.                    |
| VIII — Plugin counts        | N/A.                                                                         |
| IX — Behaviour-first        | This spec describes observable behaviour.                                    |
| X — Backwards-compat        | New providers plug in without breaking JWT / API-key flows.                  |

## 16. References

- Source:
    - `apps/api/src/auth/` (controllers, services, guards, decorators)
    - `apps/api/src/auth/providers/` (OAuth abstraction)
    - `packages/agent/src/database/repositories/oauth-token.repository.ts`
- Related specs:
    - [`features/api-keys/spec`](../features/api-keys/spec.md)
    - [`features/directory-members/spec`](../features/directory-members/spec.md)
    - [`features/mcp-server/spec`](../features/mcp-server/spec.md)
    - [`plugin-sdk`](./plugin-sdk.md) (`oauth`, `device-auth-provider` capabilities)
- User docs: [`docs/api/authentication.md`](../../api/authentication.md)
