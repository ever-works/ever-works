# Feature Specification: Auth (JWT, Sessions, OAuth, API Keys)

**Feature ID**: `auth-jwt-oauth`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The auth feature is the platform's identity surface. It backs four
authentication shapes:

1. **Email + password** sign-up / sign-in via the Better Auth runtime,
   mirrored into the platform's `User` table for FK-safe joins.
2. **Bearer session tokens** issued either by Better Auth or by the
   platform's own `auth_session` table (used after OAuth callbacks
   and after email-verification).
3. **OAuth social login** for GitHub, Google, Facebook, and LinkedIn.
   The platform exchanges the authorization code, fetches the social
   profile, upserts a `User` + `AuthAccount` record, and issues a
   session token.
4. **API keys** (`ew_live_*` prefix) for programmatic access. Stored
   as SHA-256 digests; validated on every request alongside the
   session-token path.

A single guard (`AuthSessionGuard`) handles all four shapes. Endpoints
that should be open are opted out with the `@Public()` decorator.

This feature deliberately does **not** include:

- The GitHub-App installation flow
  (covered by [`integrations-github-app`](../integrations-github-app/)).
- Plugin-scoped OAuth (Google Drive, Notion, etc.) — those live under
  `apps/api/src/plugins-capabilities/oauth/`.
- The transactional email delivery itself
  (covered by [`mail-providers`](../mail-providers/spec.md) — auth
  only **emits** `UserCreatedEvent` / `UserConfirmedEvent` /
  `UserForgotPasswordEvent`).

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I do not have an account, **when** I `POST /api/auth/register`
  with a unique email, valid username (≥3 chars), and password matching
  the policy regex, **then** Better Auth creates the credential, the
  platform mirrors the password hash into `users.password`, sets
  `registrationProvider='local'`, returns `{access_token, user}`, and
  emits `UserCreatedEvent` so the verification email goes out.
- **Given** my email is unverified, **when** I `POST /api/auth/login`
  with valid credentials, **then** Better Auth issues a session token,
  `AuthService` records a `user.login` activity row
  (`USER_LOGIN`, `summary='Signed in'`, `ipAddress`+`userAgent` from
  the request), and the response is `{access_token, user}`.
- **Given** I want to sign in with GitHub, **when** I `GET
  /api/oauth/github/url?state=<csrf>`, **then** the response is
  `{url}` where `url` is `https://github.com/login/oauth/authorize?…`
  with `client_id`, `redirect_uri`, `response_type=code`, `scope` (the
  full `GITHUB_SCOPES` set joined by space), and `state`.
- **Given** GitHub redirects back, **when** I `GET
  /api/oauth/github/callback?code=…`, **then** the platform exchanges
  the code via `POST https://github.com/login/oauth/access_token`
  WITHOUT a `grant_type` field (GitHub-specific quirk), fetches
  `/user` and `/user/emails`, picks the primary verified email via
  `resolveGitHubAccountEmail`, upserts the user, issues a session,
  and records `user.login.github` activity with
  `summary='Signed in via GitHub'`.
- **Given** I sign in with Google, **when** I hit
  `/api/oauth/google/url`, **then** the URL contains
  `access_type=offline` + `prompt=consent` so we receive a
  refresh-token on the first consent.
- **Given** I sign in with LinkedIn, **when** the userinfo response
  has `given_name=Jane`, `family_name=Doe` and `name` is missing,
  **then** `displayName` falls back to `'Jane Doe'`.
- **Given** I forgot my password, **when** I `POST
  /api/auth/forgot-password` with my email, **then** a 32-byte hex
  reset token is stored on `users.passwordResetToken` with a 1-hour
  expiry, and `UserForgotPasswordEvent` is emitted with the resolved
  callback URL (the body's `resetPasswordCallbackUrl + ?token=` if
  provided, else `${webAppUrl}/api/auth/reset-password?token=`).
- **Given** I `POST /api/auth/reset-password` with a fresh token,
  **when** the token validates, **then** the platform sets the new
  password via the Better Auth context's `password.hash`, mirrors the
  hash into `users.password`, deletes the reset token via
  `clearPasswordResetToken` (atomic), and signs me out of every
  device via `signOutAll`.
- **Given** I `POST /api/auth/verify-email` with the token from the
  signup email, **when** the token is fresh (≤24h), **then**
  `users.emailVerified=true`, the verification token+expiry are
  cleared, `UserConfirmedEvent` is emitted, and a fresh session token
  is issued so the client can drop the email-verification gate.
- **Given** I have at most 9 active API keys, **when** I `POST
  /api/auth/api-keys` with `{name}` and an optional ISO `expiresAt`
  in the future, **then** the platform generates 32 bytes of entropy,
  prefixes with `ew_live_`, stores the SHA-256 digest, and returns
  the **raw key once** (`{id, name, key, prefix, expiresAt, createdAt}`).
- **Given** I own a key, **when** I send `Authorization: Bearer
  ew_live_…` (or `x-api-key: ew_live_…`), **then** `AuthSessionGuard`
  resolves the user via the SHA-256 digest, refuses if `isActive=false`
  or `expiresAt < now`, fires `apiKeyRepository.updateLastUsed(...)`
  fire-and-forget, and treats my request as fully authenticated.

### 2.2 Edge cases & failures

- **Given** I `POST /api/auth/register` with an email that already
  exists, **when** `assertCanRegister` runs, **then** it throws
  `ConflictException('User with this email already exists')` BEFORE
  hitting Better Auth — no orphan credential is created.
- **Given** the verification email send fails (mail provider down),
  **when** the registration handler logs the error, **then** the
  `register` response still resolves successfully — verification
  delivery never blocks signup. The handler uses
  `logger.warn('Failed to send verification email for user <id>: <msg>')`.
- **Given** my account was suspended (`users.isActive=false`),
  **when** I try to sign in, **then** `AuthProviderService.assertActiveUser`
  calls `signOutAll(userId)` (purges any lingering sessions) and
  throws `UnauthorizedException('User account is suspended')`. The
  same check runs on every authenticated request, so an admin
  flipping `isActive` mid-session terminates the user.
- **Given** my session token expired, **when** the guard reads it
  from the DB, **then** the row is deleted via
  `deleteSessionRecord(token)` and the request returns 401 — the
  client is forced to re-login. Session lifetime is 7 days from
  issuance (`expiresAt = now + 7 days` at `createSessionRecord`).
- **Given** I forgot my password but my email is not in the user
  table, **when** `forgotPassword` returns, **then** the response is
  `{message: 'If the email exists, a reset link has been sent'}`
  WITHOUT revealing whether the email exists. No event is emitted,
  no token is generated.
- **Given** I submit a reset token that expired, **when**
  `getUserByPasswordResetToken` checks `passwordResetExpires`,
  **then** it throws `BadRequestException('Reset token expired')`.
  Same shape for verification: `BadRequestException('Verification token expired')`.
- **Given** I submit a reset/verification token that is already
  consumed (token field is `null`), **when** the lookup runs, **then**
  it throws `BadRequestException('Invalid <reset|verification> token')`.
- **Given** two windows race to consume the same reset token, **when**
  both call `clearPasswordResetToken`, **then** only one returns
  `consumed=true`; the loser throws
  `BadRequestException('Invalid reset token')` because the token row
  was already cleared.
- **Given** I register with social-login but my OAuth provider does
  NOT mark the email verified (Facebook always returns
  `emailVerified=false`; Google explicitly returns
  `email_verified: false`), **when** I have NO existing
  `auth_account` link to that provider, **then**
  `validateSocialUser` throws
  `UnauthorizedException('Unable to link this social account because the provider email is not verified')`.
  An existing link bypasses this check.
- **Given** GitHub returns no email on `/user` and no primary
  verified email on `/user/emails`, **when** `resolveGitHubAccountEmail`
  returns `email=null`, **then**
  `getGitHubUser` throws
  `BadRequestException('No email found in GitHub profile')`.
  Same shape for Google/Facebook/LinkedIn.
- **Given** I request an OAuth URL for a provider that is not
  configured (missing `clientId` env var), **when**
  `getAuthorizationUrl` resolves the client id, **then** it throws
  `BadRequestException('<provider> client id is not configured')`.
- **Given** I hit a callback for a provider whose `clientSecret`
  is missing, **when** `exchangeCodeForTokens` reads it, **then**
  the call throws `BadRequestException('<provider> client secret is not configured')`
  BEFORE making any HTTP request.
- **Given** the OAuth provider returns a token response without
  `access_token`, **when** `readString` checks the field, **then**
  it throws `BadRequestException('Missing access_token from OAuth provider response')`.
- **Given** I use a social provider that the platform does not
  support (`/api/oauth/twitter/url`), **when**
  `getSocialAuthProviderConfig` runs, **then** it throws
  `BadRequestException('Unsupported OAuth provider: twitter')`.
- **Given** I want to log out, **when** I `POST /api/auth/logout`
  with a Bearer token, **then** `AuthProviderService.signOut`
  detects the token, deletes only that session row, and the call
  resolves with `{message: 'Logged out successfully'}`. Other
  devices for the same user remain signed in.
- **Given** I want to terminate every device, **when** I `POST
  /api/auth/logout-all`, **then** `auth_session` rows for `userId`
  are bulk-deleted via TypeORM `repository.delete({userId})`.
- **Given** I update my profile with `committerName: null`, **when**
  `updateUserProfile` runs, **then** the field is cleared in the
  database (the explicit-`null` semantics are preserved — `undefined`
  leaves the field untouched).
- **Given** I update my profile and my `username` field is `null`
  in the body, **when** `updateUserProfile` runs, **then** the
  username field is NOT cleared — `null`/`undefined` are both
  treated as "leave alone" for `username`/`avatar` (only `committer*`
  fields support explicit clearing).
- **Given** I `GET /api/auth/profile/fresh`, **when** my GitHub OAuth
  link's access token has expired OR lacks the `repo` scope, **then**
  the GitHub provider does NOT appear in `oauthTokens` — the same
  endpoint returns connected providers filtered by
  `isAccessTokenExpired` + (for GitHub) `hasRequiredScopes(['repo'])`.
- **Given** the user already has 10 API keys, **when** they POST a
  new one, **then** `createKey` throws
  `BadRequestException('Maximum of 10 API keys allowed per user')`
  before any entropy is generated.
- **Given** the user submits `expiresAt` that is in the past, **when**
  `createKey` validates it, **then** it throws
  `BadRequestException('Expiration date must be in the future')`.
- **Given** an attacker tries `Authorization: Bearer not-an-api-key`,
  **when** `extractApiKey` checks the prefix, **then** the bearer
  token is treated as a session token (NOT an API key) — the
  `ew_live_` prefix is the gate.
- **Given** a request supplies BOTH `x-api-key` and
  `Authorization: Bearer …`, **when** `extractApiKey` runs, **then**
  the `x-api-key` header wins (checked first). The session-token
  fallback is only reached when neither header carries an
  `ew_live_`-prefixed value.

## 3. Functional Requirements

- **FR-1**: The auth surface MUST expose three controllers:
  `AuthController` at `/api/auth`, `OAuthController` at `/api/oauth`,
  `ApiKeysController` at `/api/auth/api-keys`. All three are wired
  in `AuthModule` via `controllers: [OAuthController, AuthController, ApiKeysController]`.
- **FR-2**: `AuthController` MUST expose 14 endpoints:
  `GET providers` (public), `POST register` (public), `POST login`
  (public), `POST logout` (guarded), `POST logout-all` (guarded),
  `GET profile` (guarded, JWT-only), `GET profile/fresh` (guarded,
  fresh DB read), `POST update-password` (guarded), `PUT profile`
  (guarded), `POST send-verification` (guarded), `POST verify-email`
  (public), `POST forgot-password` (public),
  `POST reset-password` (public), `GET validate-email-token` (public),
  `GET validate-reset-token` (public).
- **FR-3**: `OAuthController` MUST expose 2 endpoints:
  `GET /api/oauth/:providerId/url?state=…` returning `{url}` and
  `GET /api/oauth/:providerId/callback?code=…` returning the
  Better-Auth-style `{access_token, user}` envelope. Both are
  `@Public()`.
- **FR-4**: `ApiKeysController` MUST expose 3 guarded endpoints:
  `POST /` (create), `GET /` (list user's keys), `DELETE /:id`
  (revoke). Revoke MUST `throw NotFoundException('API key not found')`
  when `deleteByIdAndUserId(...)` returns `false`.
- **FR-5**: Email/password flows MUST run through the Better Auth
  runtime instance (`createAuthRuntimeInstance(dataSource)`) for
  credential creation, password hashing, and session issuance, and
  MUST mirror the password hash + `lastLoginAt` + `registrationProvider`
  back into `users` via `UserRepository.update` so cross-table joins
  see a single source of truth.
- **FR-6**: `AuthSessionGuard.canActivate` MUST:
  (a) short-circuit `true` when the route is `@Public()`;
  (b) check `x-api-key` and `Authorization: Bearer …` for an
  `ew_live_`-prefixed value, validate via `ApiKeyService.validateKey`,
  hydrate `request.user` from `UserRepository.findById`, and reject
  with 401 if the key is invalid/expired or the user is inactive;
  (c) fall back to `authProvider.authenticate(headers)` for session
  tokens / Better Auth cookies;
  (d) throw `UnauthorizedException` when both shapes fail.
- **FR-7**: `AuthSessionGuard` MUST resolve `ApiKeyService` and
  `UserRepository` lazily via `ModuleRef.get(..., {strict:false})` to
  avoid circular DI between the guard module and `AuthModule`.
- **FR-8**: `ApiKeyService.createKey` MUST:
  (a) reject when `countByUserId(userId) >= 10`;
  (b) reject when `expiresAt <= now`;
  (c) generate 32 bytes of entropy, prefix with `ew_live_`, hash
  with SHA-256, store the digest plus a 12-char prefix
  (`'ew_live_' + 4 hex chars`) for human display;
  (d) return the raw key in the response payload **once**, never
  again.
- **FR-9**: `ApiKeyService.validateKey` MUST:
  (a) hash the supplied raw key with SHA-256;
  (b) return `null` if no match, return `null` if `expiresAt < now`;
  (c) fire-and-forget `updateLastUsed(id)` (the `.catch(() => {})`
  swallow ensures a DB hiccup never causes a 401 cascade).
- **FR-10**: `AuthService.assertCanRegister(email)` MUST throw
  `ConflictException('User with this email already exists')` when
  `userRepository.findByEmail(email)` returns a row.
- **FR-11**: `AuthService.sendVerificationEmail(userId, callbackUrl?)`
  MUST:
  (a) reject `BadRequestException('User not found')` when no user;
  (b) reject `BadRequestException('Email already verified')` when
  `user.emailVerified === true`;
  (c) generate 32 hex bytes, persist with `expires = now + 24h`;
  (d) when `callbackUrl` is provided AND does NOT already contain
  `token=`, append `?token=<token>`; otherwise default to
  `${webAppUrl}/api/auth/verify-email?token=<token>`;
  (e) emit `UserCreatedEvent(user, verificationToken, callbackUrl)`;
  (f) return `{message, verificationToken, expiresAt}` (the token is
  echoed in the response — pinned for backwards compat with the
  current dev-mode UI; production deployments should rely on the
  email).
- **FR-12**: `AuthService.verifyEmail(token)` MUST: lookup by
  `emailVerificationToken`, reject expired tokens, set
  `emailVerified=true` + null both token fields, refetch the user,
  emit `UserConfirmedEvent(updatedUser, '${webAppUrl}/works/new')`,
  and return the updated user. The controller (`POST verify-email`)
  then issues a session via `authProvider.issueSession(user.id)`.
- **FR-13**: `AuthService.forgotPassword(dto)` MUST silently no-op
  on unknown email (return the generic message without emitting an
  event), and on known email persist a fresh 32-hex-byte token with
  a 1-hour expiry and emit
  `UserForgotPasswordEvent(user, resetToken, callbackUrl, '1 hour')`.
  Callback resolution mirrors FR-11 — append `?token=` only if the
  body's URL doesn't already include `token=`, otherwise default to
  `${webAppUrl}/api/auth/reset-password?token=`.
- **FR-14**: `AuthService.consumePasswordResetToken(token)` MUST
  call `userRepository.clearPasswordResetToken(user.id, token)` and
  raise `BadRequestException('Invalid reset token')` when the
  atomic clear returns `false` (someone else consumed it first).
- **FR-15**: `AuthService.validateSocialUser(socialUser)` MUST:
  (a) treat `emailVerified !== false` as "trusted email" (so
  `undefined` and `true` both qualify, `false` does not);
  (b) when no user exists, create with random hashed password
  (`bcrypt.hash(randomBytes(16).hex, authConstants.bcryptSaltRounds)`)
  and emit `UserConfirmedEvent` ONLY when the email is trusted;
  (c) when the user exists, refuse to link if email is untrusted AND
  no existing `AuthAccount` row for that provider exists;
  (d) update `lastLoginAt`, `registrationProvider`, optionally
  `username` (preserving non-empty existing value), and `avatar`;
  (e) upsert `AuthAccount` with `accessToken`/`refreshToken ?? null`/
  `tokenType ?? 'Bearer'`/`accessTokenExpiresAt ?? null`/`scope ?? null`
  and `metadata = {providerUserId, ...incoming.metadata}`.
- **FR-16**: `AuthService.getUserProfile(userId)` MUST strip
  `password`, `emailVerificationToken`, `emailVerificationExpires`,
  `passwordResetToken`, `passwordResetExpires` from the returned
  payload AND attach `oauthTokens: ProviderAccount[]` (filtered to
  non-expired tokens; for GitHub specifically, only those with the
  `repo` scope).
- **FR-17**: `AuthService.updateUserProfile(userId, dto)` MUST
  update `username`/`avatar` only when the value is non-null/non-undefined,
  but MUST treat explicit `null` (not `undefined`) on `committerName`/
  `committerEmail` as a clear instruction (stored as `null` in the
  database). Empty-string committer values are also treated as clear
  via the `value || null` coalesce.
- **FR-18**: `SocialAuthService.getAuthorizationUrl(providerId,
  callbackUrl?, state?)` MUST: resolve the provider config (or throw
  for unsupported providers); use `callbackUrl` if provided else
  `provider.callbackUrl()`; build URLSearchParams with `client_id`,
  `redirect_uri`, `response_type='code'`, `scope` joined by
  `provider.scopeSeparator || ' '`; append `state` when provided;
  append `access_type=offline` + `prompt=consent` for Google ONLY.
- **FR-19**: `SocialAuthService.authenticate(providerId, code,
  callbackUrl?)` MUST exchange the code (omitting `grant_type` for
  GitHub, sending `grant_type=authorization_code` for everyone else),
  fetch the provider's user-info, then call
  `authService.validateSocialUser({...socialUser, provider:
  provider.id, accessToken, refreshToken, tokenType, scope,
  expiresAt})`.
- **FR-20**: `SocialAuthService.exchangeCodeForTokens` MUST send the
  request as `application/x-www-form-urlencoded` with `Accept:
  application/json`. The response body's `expires_in` (number) MUST
  be converted to `expiresAt = new Date(Date.now() + expires_in *
  1000)`; missing/non-numeric values yield `expiresAt=null`.
- **FR-21**: `SocialAuthService.getSocialUser` MUST dispatch on
  `providerId` to one of `getGitHubUser`/`getGoogleUser`/
  `getFacebookUser`/`getLinkedInUser`. Each reader MUST:
  - Set `displayName` from a provider-specific fallback chain
    (GitHub: `data.name || data.login || email-localpart`;
    Google: `data.name || email-localpart`;
    Facebook: `data.name || email-localpart`;
    LinkedIn: `data.name || '<given> <family>' || email-localpart`).
  - Set `emailVerified` per provider:
    GitHub uses `resolveGitHubAccountEmail`'s verified flag,
    Google `data.email_verified !== false` (default-true),
    LinkedIn `data.email_verified !== false`,
    Facebook **always** `false`.
  - Throw `BadRequestException('No email found in <Provider> profile')`
    when the email is missing.
- **FR-22**: `SocialAuthService.getConfiguredProviders()` MUST
  return an array of provider IDs whose `clientId()` AND
  `clientSecret()` env-readers both return truthy strings.
  `GET /api/auth/providers` returns `{emailPassword: true,
  socialProviders: [...]}` to the client.
- **FR-23**: `AuthProviderService.signInEmail` MUST:
  (a) when the user already has a local password, run
  `authSyncService.ensureCredentialAccount(userId, passwordHash)` so
  Better Auth's credential table stays in sync;
  (b) call `auth.api.signInEmail({headers, body: {email, password,
  rememberMe: true}})`;
  (c) re-fetch the user via `assertActiveUser`, mirror the new
  password hash + `lastLoginAt` + `registrationProvider='local'`
  into `users`;
  (d) throw `UnauthorizedException('Failed to establish authenticated session')`
  when Better Auth returns no `token`.
- **FR-24**: `AuthProviderService.signUpEmail` MUST mirror the
  password hash + `registrationProvider='local'` + `isActive=true`
  into `users`. When Better Auth issues a token in the response,
  return `{access_token, user}`; otherwise fall through to
  `issueSession(result.user.id)` (which writes a row to the
  platform's `auth_session` table).
- **FR-25**: `AuthProviderService.issueSession(userId)` MUST create
  a row in `auth_session` with:
  - `id = randomUUID()`;
  - `token = randomBytes(24).toString('base64url')` (32 chars,
    URL-safe);
  - `expiresAt = now + 7 days`;
  - `ipAddress: null`, `userAgent: null` (callers can populate
    later via the activity-log path).
- **FR-26**: `AuthProviderService.changePassword` MUST require an
  authenticated user (Bearer token OR Better Auth session), fetch
  the current credential password hash, refuse with
  `UnauthorizedException('Password login is not configured for this account')`
  when no hash exists (e.g. user signed up via OAuth only), and
  refuse with `UnauthorizedException('Current password is incorrect')`
  on `bcrypt.compare` mismatch.
- **FR-27**: `AuthProviderService.setPassword(userId, newPassword)`
  MUST hash via the Better Auth runtime context's `password.hash`,
  sync via `authSyncService.syncCredentialPassword`, and mirror the
  hash into `users.password`. The reset-password controller calls
  this then `signOutAll(user.id)` to terminate every active
  session.
- **FR-28**: `AuthProviderService.signOut(headers)` MUST detect a
  bearer token via `getBearerToken` and, when present, delete only
  that session row from `auth_session`. When the token is absent
  (cookie-based Better Auth), it MUST call `auth.api.signOut`. Both
  shapes resolve cleanly.
- **FR-29**: `AuthProviderService.signOutAll(userId)` MUST
  bulk-delete every `auth_session` row for `userId` via the TypeORM
  repository (`delete({userId})`). Better Auth's own session table
  is NOT touched here — it expires on its own schedule (by design,
  per the runtime instance config).
- **FR-30**: `AuthProviderService.authenticate(headers)` MUST first
  check for a bearer token in `auth_session`; if found and unexpired,
  hydrate the user. If expired, delete the row and return `null`.
  Falling back to Better Auth's cookie session, the method MUST
  reject (`UnauthorizedException('User account is suspended')`) and
  call `signOutAll` when the runtime user has `isActive === false`.
- **FR-31**: `mapAuthenticatedUser` (Better Auth path) MUST set
  `iss='auth-runtime'`, `aud='ever-works-users'`, `iat=floor(now/1000)`.
  `mapAuthenticatedUserFromUser` (bearer-token path) MUST use the
  same `iss`/`aud`. The API-key path in the guard uses
  `iss='ever-works'`, `aud='ever-works'`. These three values are
  pinned because downstream code (e.g. logging/analytics) keys off
  them.
- **FR-32**: The `RegisterDto` MUST require `username` (string,
  `MinLength(3)`), `email` (`@IsEmail()`), and `password` (string,
  `MinLength(6)`, regex `^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$`).
  `UpdatePasswordDto`/`ResetPasswordDto` MUST require the same regex
  on `newPassword` with `MinLength(8)`.
  `LoginDto` MUST require `email` (`@IsEmail`) and `password`
  (`@IsString @IsNotEmpty`).
- **FR-33**: The four supported social providers MUST be exactly
  GitHub, Google, Facebook, LinkedIn — pinned in
  `SOCIAL_AUTH_PROVIDERS` with their authorization URLs, token URLs,
  scopes, and (Facebook only) `scopeSeparator: ','`. Adding a fifth
  provider requires a code change to that map.
- **FR-34**: GitHub's scope set is sourced from
  `auth/config/github-scopes.config.ts` (`GITHUB_SCOPES`) — the same
  scope set used by the GitHub-App onboarding, so OAuth and the App
  flow grant the same repo+org+gist surface. Changing it changes
  both call sites.
- **FR-35**: Login MUST emit a `user.login` activity log row with
  `actionType=USER_LOGIN`, `status=COMPLETED`, the resolved
  `ipAddress` (`req.ip || req.headers['x-forwarded-for']`) and
  `userAgent` (`req.headers['user-agent']`), and the activity-log
  call MUST be fire-and-forget (`.catch(() => {})`) so an audit
  failure does NOT 500 the login. Same shape for OAuth callback,
  with `action='user.login.<providerId>'` and
  `summary='Signed in via <displayName>'`.

## 4. Non-Functional Requirements

- **NFR-1 (security)**: Password storage uses bcrypt at the
  `authConstants.bcryptSaltRounds` cost (sourced from `BCRYPT_ROUNDS`
  env var; default 10). The Better Auth runtime owns the canonical
  hash; the platform's `users.password` is a synchronized mirror so
  app-level joins/queries don't need a cross-table fetch.
- **NFR-2 (security)**: API keys are stored ONLY as SHA-256 digests.
  The raw key is returned exactly once at creation time. The 12-char
  `prefix` is the only fragment kept for human display in the keys
  list.
- **NFR-3 (security)**: All token-bearing fields are random:
  - Verification tokens / reset tokens: `randomBytes(32).hex` (64
    chars).
  - API keys: `randomBytes(32).hex` after the `ew_live_` prefix.
  - Session tokens: `randomBytes(24).base64url` (32 chars).
  All three use Node's crypto module — no `Math.random()`.
- **NFR-4 (privacy)**: `getUserProfile` MUST never return the
  password hash, the verification/reset tokens, or their expiry
  fields. The exclusion is implemented as a destructuring strip
  (`const { password, …, ...userProfile } = user`) so adding a new
  sensitive field requires updating that list.
- **NFR-5 (resilience)**: Failure to deliver the verification email
  MUST NOT block registration. Failure to write an activity-log row
  MUST NOT block login or OAuth callback. Failure to update
  `lastUsedAt` for an API key MUST NOT 401 the request.
- **NFR-6 (observability)**: Each path emits a single warn/info log
  line on failure with enough context to pin the user
  (`'Failed to send verification email for user <id>: <err>'`). The
  registration controller logs at `warn`. The activity-log
  fire-and-forget paths swallow silently — by design, the
  activity-log service itself owns its own error logging.
- **NFR-7 (compatibility)**: The auth surface presents two response
  envelopes (`{access_token, user}` for register/login/oauth, and
  `{message, …}` for password resets / logout). Existing clients
  pin both shapes — changing either is a breaking change.
- **NFR-8 (testability)**: All four services are covered by
  Jest unit tests:
  - `auth.service.spec.ts` — 45 tests
    ([#486](https://github.com/ever-works/ever-works/pull/486)).
  - `social-auth.service.spec.ts` — 37 tests
    ([#488](https://github.com/ever-works/ever-works/pull/488)).
  - `api-key.service.spec.ts` — 15 tests
    ([#486](https://github.com/ever-works/ever-works/pull/486)).
  - `github-email.utils.spec.ts` — primary-email resolution from
    `/user/emails`.

## 5. Out of Scope

- **Plugin-scoped OAuth** (Notion, Google Drive, Slack, etc.). Those
  flows live under `apps/api/src/plugins-capabilities/oauth/` and
  store tokens against `Plugin` entities, not the user-level
  `AuthAccount` table.
- **GitHub-App installation flow** (PRs, repo dispatch, webhooks).
  See [`integrations-github-app`](../integrations-github-app/) when
  that spec is authored.
- **MFA / TOTP** — not implemented yet. Better Auth supports it via
  a plugin; out of scope until the platform decides on a UX.
- **Session refresh-token rotation** — Better Auth handles its own
  rotation for cookie-based sessions; the platform's bearer-token
  sessions are fixed-7-day with no refresh, by design (clients
  re-login on expiry).
- **OAuth state-validation / CSRF** — the `state` query param is
  currently passed through to the OAuth provider but the callback
  handler does NOT verify it against a stored value. This is a
  documented follow-up (OQ-2 below).
- **Rate-limiting** — handled by `@nestjs/throttler` at the
  application level, not by this feature; the named tiers
  (short/medium/long) are pinned by `config/throttler.config.spec.ts`.

## 6. Open Questions / Follow-ups

- **OQ-1**: `AuthSessionGuard` issues an API-key-shaped
  `AuthenticatedUser` with `iss='ever-works'`/`aud='ever-works'` while
  the session-token paths use `iss='auth-runtime'`/
  `aud='ever-works-users'`. Downstream code reads `iss` to decide
  whether to apply session-only behaviors (e.g. require fresh login
  for sensitive ops). The split is load-bearing — but it's also
  undocumented outside this spec. Decide whether to consolidate to a
  single `iss='ever-works'` value and gate sensitive ops on a
  separate flag (`grant: 'api-key' | 'session'`). Out of scope for
  this spec; document the split clearly so refactors don't silently
  break it.
- **OQ-2**: OAuth `state` param is passed through to the provider
  but never verified on callback. A determined attacker who tricks a
  user into clicking a crafted callback URL could associate the
  attacker's social account with the victim's session (CSRF). The
  fix is to write `state` to a short-TTL Redis key on URL request
  and verify-and-delete on callback. Tracked here; implementation
  belongs in a separate change so that `validateSocialUser` does not
  need to grow a stateful side-channel for this spec.
- **OQ-3**: `AuthService.sendVerificationEmail` echoes the
  `verificationToken` in the response body. Same for `forgotPassword`
  (`resetToken`). This is convenient in dev (no need to read the
  inbox) but a token leak in prod logs / referer headers /
  third-party JS. The "Remove this in production" comment in the
  source acknowledges the hazard. Decision: gate the echo behind a
  `NODE_ENV !== 'production'` check in a follow-up — won't change
  the API shape (the field becomes `undefined`).
- **OQ-4**: When a user has only an OAuth provider and zero local
  credentials, calling `POST /api/auth/update-password` returns 401
  with `'Password login is not configured for this account'`. Better
  UX would be to explain "set a password first" with a separate
  endpoint. Not blocking.
- **OQ-5**: `signOutAll` deletes only the platform's `auth_session`
  rows. If the user authenticated via Better Auth's cookie session
  and is also subscribed to that session via the runtime, the cookie
  session is NOT terminated by `signOutAll`. Today that's only
  reachable via the same browser, so the Set-Cookie expiration on
  next response handles it — but a determined client with a stale
  cookie could keep the session alive past `signOutAll`. Verify
  whether Better Auth's `auth.api.deleteSessions` should also be
  called.
