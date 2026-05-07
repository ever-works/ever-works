# Implementation Plan: Auth (JWT, Sessions, OAuth, API Keys)

**Feature ID**: `auth-jwt-oauth`
**Status**: `Retrospective` (already shipped — this plan documents
the as-built design)

---

## 1. Architecture

The auth surface is one NestJS module (`AuthModule`) layered as:

```
HTTP layer
  AuthController             /api/auth/*   (14 endpoints)
  OAuthController            /api/oauth/*  (2 endpoints)
  ApiKeysController          /api/auth/api-keys/* (3 endpoints)

Guard
  AuthSessionGuard           applied per route via @UseGuards
                             OR globally; @Public() opts a route out

Application services
  AuthService                user lifecycle, profile, social-user
                             reconciliation, token issuance for
                             email-verification + password reset
  ApiKeyService              create/list/revoke/validate
  SocialAuthService          OAuth URL, code exchange, profile read,
                             validateSocialUser delegation

Auth-provider abstraction
  AuthProvider (abstract)    interface used by the controllers/guard
  AuthProviderService        concrete impl backed by Better Auth +
                             local auth_session table
  AuthSyncService            keeps Better Auth credential rows ↔
                             users.password in sync (both directions)
  createAuthRuntimeInstance  Better Auth instance factory, bound to
                             the TypeORM DataSource

Repositories (from @ever-works/agent/database)
  UserRepository             users table
  AuthAccountRepository      OAuth provider links (auth_account)
  ApiKeyRepository           ew_live_* keys

Events (from ../../events, consumed by mail-providers + activity-log)
  UserCreatedEvent           emitted on register / send-verification
  UserConfirmedEvent         emitted on verifyEmail / OAuth signup
  UserForgotPasswordEvent    emitted on forgotPassword
```

### Key collaborators

- **Better Auth runtime** (`@ever-works/agent` re-exports it).
  Owns the canonical credential table. Issues cookie sessions and
  bearer tokens. Provides the `password.hash` primitive used during
  reset.
- **TypeORM `auth_session`** — the platform's own session table.
  Used after OAuth callback and after email verification (where
  Better Auth has no native flow). 7-day TTL, fixed by
  `createSessionRecord`.
- **`@nestjs/event-emitter`** — emits `UserCreatedEvent` /
  `UserConfirmedEvent` / `UserForgotPasswordEvent` synchronously.
  Listeners (in `mail-providers` + `activity-log`) own delivery and
  must NOT throw out of the listener (see those specs).

### Why two session stores?

Better Auth owns email/password sign-in because it ships a hardened
implementation of the password-flow primitives we'd otherwise have
to reimplement. But OAuth-callback-issued sessions and
post-verification sessions need to be writable in a single
transaction with the platform's own user state, so they go in
`auth_session` and the guard checks both stores.

The bearer token shape on the wire is identical, so clients can't
tell which store backs their token — by design.

## 2. Data Model

### `users` (managed by `UserRepository`, declared in `@ever-works/agent/entities`)

The auth feature reads/writes:

| Column                       | Type      | Notes                                     |
| ---------------------------- | --------- | ----------------------------------------- |
| id                           | uuid PK   |                                            |
| email                        | text      | unique                                     |
| username                     | text      |                                            |
| password                     | text      | bcrypt hash, mirror of Better Auth         |
| avatar                       | text      | nullable                                   |
| registrationProvider         | text      | 'local' / 'github' / 'google' / etc.       |
| emailVerified                | boolean   | default false                              |
| emailVerificationToken       | text      | nullable; cleared on success               |
| emailVerificationExpires     | timestamp | nullable; cleared on success               |
| passwordResetToken           | text      | nullable; cleared atomically by `clearPasswordResetToken` |
| passwordResetExpires         | timestamp | nullable                                   |
| isActive                     | boolean   | suspended ⇒ false; guard refuses           |
| committerName                | text      | nullable; clearable via update-profile     |
| committerEmail               | text      | nullable; clearable                        |
| lastLoginAt                  | timestamp | updated on login                           |

### `auth_session` (managed via raw TypeORM repository)

| Column     | Type      | Notes                                  |
| ---------- | --------- | -------------------------------------- |
| id         | uuid PK   | randomUUID()                           |
| userId     | uuid FK   | → users.id                             |
| token      | text      | base64url, 32 chars                     |
| expiresAt  | timestamp | now + 7d on issuance                    |
| ipAddress  | text      | nullable                                |
| userAgent  | text      | nullable                                |

### `auth_account` (OAuth provider links — `AuthAccountRepository`)

| Column                  | Type      | Notes                              |
| ----------------------- | --------- | ---------------------------------- |
| userId                  | uuid FK   | → users.id                         |
| providerId              | text      | 'github' / 'google' / 'facebook' / 'linkedin' |
| accountId               | text      | provider's user id                 |
| username                | text      |                                    |
| email                   | text      |                                    |
| accessToken             | text      |                                    |
| refreshToken            | text      | nullable                           |
| tokenType               | text      | default 'Bearer'                   |
| accessTokenExpiresAt    | timestamp | nullable                           |
| scope                   | text      | nullable                           |
| metadata                | jsonb     | `{providerUserId, ...providerSpecific}` |

### `api_key` (managed by `ApiKeyRepository`)

| Column     | Type      | Notes                                          |
| ---------- | --------- | ---------------------------------------------- |
| id         | uuid PK   |                                                |
| userId     | uuid FK   |                                                |
| name       | text      | user-supplied label                            |
| hashedKey  | text      | sha256 of `ew_live_<32 hex bytes>`             |
| prefix     | text      | first 12 chars of the raw key (display-only)   |
| expiresAt  | timestamp | nullable; null = never expires                 |
| lastUsedAt | timestamp | nullable; updated fire-and-forget on validate  |
| createdAt  | timestamp |                                                |

## 3. Module wiring

`AuthModule` (`apps/api/src/auth/auth.module.ts`):

```ts
imports: [DatabaseModule, HttpModule, ActivityLogModule]
providers: [
  AuthService, ApiKeyService, AuthProviderService, AuthSyncService,
  SocialAuthService, AuthSessionGuard,
  ApiKeyRepository, UserRepository, AuthAccountRepository,
  { provide: AUTH_PROVIDER, useExisting: AuthProviderService },
  {
    provide: AUTH_RUNTIME_INSTANCE,
    inject: [DataSource],
    useFactory: (ds) => createAuthRuntimeInstance(ds),
  },
]
controllers: [OAuthController, AuthController, ApiKeysController]
exports: [
  AuthService, ApiKeyService, AuthSessionGuard,
  AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE, AuthSyncService,
]
```

Three deliberate choices:

1. **`AUTH_PROVIDER` is `useExisting: AuthProviderService`** — so
   anything that imports the abstract `AuthProvider` token gets the
   same instance, but consumers can be tested against the abstract
   class without pulling the Better Auth runtime tree.
2. **`AUTH_RUNTIME_INSTANCE` is built per-module via factory** — the
   runtime needs the DataSource to wire its TypeORM adapter. The
   factory builds it once per Nest container (singleton scope).
3. **`AuthSessionGuard` is provided as a value, not via
   `APP_GUARD`** — callers opt in per-controller. `apps/api/src/main.ts`
   does NOT register a global guard; controllers use
   `@UseGuards(AuthSessionGuard)` and individual routes use
   `@Public()` to opt out.

## 4. Sequence — register

```
Client → AuthController.register
  AuthService.assertCanRegister(email)              // 409 if exists
  authProvider.signUpEmail(name, email, pwd, hdrs)
    → Better Auth creates credential
    → AuthSyncService.getCredentialPasswordHash(userId)
      → mirror into users.password
    → if Better Auth issued token: return {access_token, user}
    → else: AuthProviderService.issueSession(userId)
       → create auth_session row, return {access_token, user}
  AuthService.sendVerificationEmail(userId, callbackUrl?)
    → 32-byte hex token, 24h expiry
    → emit UserCreatedEvent (mail-providers listens)
    → return {verificationToken, expiresAt}  ← echoed only in response;
                                              not used by the controller
  Client receives {access_token, user} ← token echo dropped
```

Failures along the email-send path are caught and logged at `warn`,
the `register` response still resolves. This is documented behavior
(NFR-5).

## 5. Sequence — OAuth callback

```
Client → /api/oauth/github/url?state=<csrf>
  OAuthController.getAuthUrl
    → SocialAuthService.getAuthorizationUrl('github', undefined, state)
      → resolve provider config, build URLSearchParams,
        join scopes by ' ', append state
    → return {url}

(redirect to GitHub, user consents, GitHub redirects back)

Client → /api/oauth/github/callback?code=<code>
  OAuthController.authRedirect
    → SocialAuthService.authenticate('github', code)
      → exchangeCodeForTokens (no grant_type for GitHub)
      → getGitHubUser(accessToken)
        → fetch /user
        → resolveGitHubAccountEmail (handles primary verified email
          when /user.email is null)
      → authService.validateSocialUser({...})
        → upsert User
        → if new + trusted email: emit UserConfirmedEvent
        → upsert AuthAccount row
        → return user
    → authProvider.issueSession(user.id)
      → create auth_session row, return {access_token, user}
    → activityLog.log({user.login.github, ...}).catch(() => {})
    → return {access_token, user}
```

## 6. Sequence — bearer-token authenticated request

```
Client → any guarded route, headers carry "Authorization: Bearer <token>"
  AuthSessionGuard.canActivate
    isPublic? → true → allow
    extractApiKey(req)?
      yes → ApiKeyService.validateKey(key)
        → sha256(key), look up by hashedKey
        → expired or null? throw 401
        → user inactive? throw 401
        → fire-and-forget updateLastUsed
        → request.user = AuthenticatedUser{iss:'ever-works'}
      no → authProvider.authenticate(headers)
        bearer in auth_session? yes
          → expired? delete row + return null → throw 401
          → assertActiveUser → mapAuthenticatedUserFromUser
            (iss:'auth-runtime')
        else: auth.api.getSession(headers) (Better Auth cookie)
          → user.isActive === false?
            → signOutAll(userId) + throw 401
          → mapAuthenticatedUser (iss:'auth-runtime')
        else: throw 401
  Controller method runs with request.user populated
```

## 7. Configuration / environment variables

| Var                         | Used by                          |
| --------------------------- | -------------------------------- |
| `BCRYPT_ROUNDS`             | `authConstants.bcryptSaltRounds` |
| `WEB_APP_URL`               | `config.webAppUrl()` — default callbacks |
| `AUTH_SECRET`               | Better Auth runtime              |
| `GITHUB_CLIENT_ID`          | `config.github.clientId()`       |
| `GITHUB_CLIENT_SECRET`      | `config.github.clientSecret()`   |
| `GITHUB_CALLBACK_URL`       | `config.github.callbackUrl()`    |
| `GOOGLE_CLIENT_ID`          | `config.google.clientId()`       |
| `GOOGLE_CLIENT_SECRET`      | `config.google.clientSecret()`   |
| `GOOGLE_CONNECT_CALLBACK_URL` / `GOOGLE_CALLBACK_URL` | alias semantics — see `config/constants.spec.ts` |
| `FACEBOOK_CLIENT_ID`        | `config.facebook.clientId()`     |
| `FACEBOOK_CLIENT_SECRET`    | `config.facebook.clientSecret()` |
| `FACEBOOK_CALLBACK_URL`     | `config.facebook.callbackUrl()`  |
| `LINKEDIN_CLIENT_ID`        | `config.linkedin.clientId()`     |
| `LINKEDIN_CLIENT_SECRET`    | `config.linkedin.clientSecret()` |
| `LINKEDIN_CALLBACK_URL`     | `config.linkedin.callbackUrl()`  |

`SocialAuthService.getConfiguredProviders` advertises only the
providers whose `clientId()` AND `clientSecret()` both return
truthy values, so a half-configured provider is invisible to the
frontend.

## 8. Test surfaces

| File                                                           | Tests | Notes |
| -------------------------------------------------------------- | ----- | ----- |
| `apps/api/src/auth/services/auth.service.spec.ts`              | 45    | All public methods incl. social-user reconciliation, profile field stripping, github repo-scope gating, expired-token filtering, atomic-clear race semantics |
| `apps/api/src/auth/services/social-auth.service.spec.ts`       | 37    | All four providers (GitHub/Google/Facebook/LinkedIn), URL building, code exchange (incl. GitHub no-grant_type), error paths |
| `apps/api/src/auth/services/api-key.service.spec.ts`           | 15    | 10-key cap, expiresAt-in-past rejection, sha256 hashing, expiry, fire-and-forget updateLastUsed |
| `apps/api/src/auth/utils/github-email.utils.spec.ts`           | (in tree) | Primary-email resolution from `/user/emails` |

Open follow-ups (T15–T18 in `tasks.md`):

- `auth.controller.spec.ts` — currently only the service is covered.
  The controller's activity-log emission shape, error swallowing, and
  the verification/reset response envelopes need a Jest controller suite.
- `oauth.controller.spec.ts` — similar; the activity-log shape on the
  callback is not currently pinned.
- `api-keys.controller.spec.ts` — guarded controller with three thin
  endpoints; one suite would cover the NotFoundException path.
- `auth-session.guard.spec.ts` — the guard's three-mode logic is
  the most security-sensitive surface and currently has no unit tests.
- `auth-provider.service.spec.ts` — Better Auth runtime needs to be
  mocked at module scope.
- E2E (`apps/web/e2e/auth.spec.ts` already exists) — verify it covers
  every scenario in §2 of `spec.md`. The OAuth callback path is
  notoriously hard to e2e-test without a stub server; consider a
  Playwright route-mock layer.

## 9. Migration / backwards compat

This plan is retrospective — the surface ships in production. Any
change that:

- Changes the response envelope of `register` / `login` / OAuth
  callback (currently `{access_token, user}`) is a **breaking change**
  for the web client and CLI.
- Removes the `verificationToken` / `resetToken` fields from response
  bodies needs a coordinated frontend update (the dev-mode UI reads
  them).
- Reduces the API-key character set or key length invalidates every
  in-flight key.
- Changes session TTL (currently 7 days) silently logs everyone out
  faster than they expect.

Treat the spec's FRs as the contract. New auth shapes (MFA,
plugin-scoped OAuth tokens, GitHub-App user-tokens) belong in their
own feature folders.

## 10. Risks

- **R-1**: Better Auth and the platform's `users` table can drift
  if `AuthSyncService` fails partway through a password change.
  Mitigation: the sync runs *after* the Better Auth update, so a
  failure leaves Better Auth as the source of truth and the next
  successful login resyncs `users.password`.
- **R-2**: OAuth `state` is unverified (OQ-2). Risk of session
  fixation via malicious callback. Realistic exploit window is
  narrow (the attacker needs the user to visit a crafted callback
  URL on the same browser they're authenticated to ever-works.com)
  but the fix is small. Schedule a dedicated PR.
- **R-3**: API-key validation is O(1) by SHA-256 lookup, but the
  fire-and-forget `updateLastUsed` writes on every request. For a
  hot key under load this is a per-request UPDATE on
  `api_key.lastUsedAt`. If contention shows up in profiling,
  debounce to once-per-minute via in-memory cache.
- **R-4**: `signOutAll` does not clear the Better Auth cookie
  session (OQ-5). A user who was authenticated via cookie can keep
  their session alive after a "log out everywhere" call, until the
  cookie expires. Treat as known limitation pending a runtime call
  into Better Auth's session-purge API.
- **R-5**: API keys grant the same surface as a session token —
  there is no per-key scope. A leaked key compromises the entire
  account. Mitigation: the per-user 10-key cap + per-key
  `expiresAt` + revoke endpoint give the user tooling to recover;
  but the platform should consider per-key scopes if it ever ships
  long-lived integration tokens.
