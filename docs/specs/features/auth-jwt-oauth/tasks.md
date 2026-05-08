# Tasks: Auth (JWT, Sessions, OAuth, API Keys)

**Feature ID**: `auth-jwt-oauth`
**Status**: `Retrospective` — most tasks reflect the as-built state.
Outstanding follow-ups are flagged.

---

## Phase 1 — Module skeleton (DONE)

- [x] **T1**: `AuthModule` declared with `DatabaseModule`, `HttpModule`,
      `ActivityLogModule` imports; `controllers: [OAuthController,
  AuthController, ApiKeysController]`; exports `AuthService`,
      `ApiKeyService`, `AuthSessionGuard`, `AUTH_PROVIDER`,
      `AUTH_RUNTIME_INSTANCE`, `AuthSyncService`.
- [x] **T2**: `AUTH_PROVIDER` provided as `useExisting:
  AuthProviderService`; `AUTH_RUNTIME_INSTANCE` provided as a
      DataSource-injected factory.
- [x] **T3**: `@Public()` decorator + `IS_PUBLIC_KEY` reflector token
      defined under `auth/decorators/public.decorator.ts`.
- [x] **T4**: `@CurrentUser()` parameter decorator defined under
      `auth/decorators/user.decorator.ts`.

## Phase 2 — Email + password (DONE)

- [x] **T5**: `AuthController.register` → `assertCanRegister` →
      `signUpEmail` → `sendVerificationEmail` (best-effort). Verified
      by FR-10, FR-11, FR-32.
- [x] **T6**: `AuthController.login` → `signInEmail` → fire-and-forget
      `user.login` activity row with `ipAddress`/`userAgent`.
- [x] **T7**: `AuthService.sendVerificationEmail` /
      `verifyEmail` / `forgotPassword` / `getUserByPasswordResetToken` /
      `consumePasswordResetToken` — all five flows pinned by FR-11
      through FR-14.
- [x] **T8**: `AuthService.validateEmailVerificationToken` and
      `validatePasswordResetToken` return `{valid, message,
  email?, expiresAt?}` shape (no throwing); used by the web
      client to gate the reset/verify form before submit.
- [x] **T9**: `AuthController.resetPassword` runs the full chain
      `getUserByPasswordResetToken` → `setPassword` →
      `consumePasswordResetToken` → `signOutAll`.

## Phase 3 — Sessions / runtime (DONE)

- [x] **T10**: `AuthProviderService.signInEmail` /
      `signUpEmail` / `issueSession` / `signOut` / `signOutAll` /
      `setPassword` / `changePassword` covered by FR-23 → FR-29.
- [x] **T11**: `AuthProviderService.authenticate` checks bearer
      token in `auth_session` first, falls back to Better Auth
      cookie session, refuses on `isActive === false`.
- [x] **T12**: 7-day TTL for `auth_session.expiresAt` pinned in
      `createSessionRecord` (FR-25).
- [x] **T13**: `AuthSyncService.ensureCredentialAccount` /
      `getCredentialPasswordHash` / `syncCredentialPassword` round-trip
      between Better Auth credential rows and `users.password`.

## Phase 4 — OAuth (DONE)

- [x] **T14**: `OAuthController.getAuthUrl` returns `{url}` for
      `:providerId`; `authRedirect` exchanges code, calls
      `validateSocialUser`, issues a session, fire-and-forgets the
      activity log.
- [x] **T15**: `SocialAuthService.getAuthorizationUrl` builds the
      provider URL with `client_id`, `redirect_uri`, `response_type`,
      `scope`, optional `state`, and Google-only `access_type=offline` + `prompt=consent` (FR-18).
- [x] **T16**: `SocialAuthService.authenticate` exchanges the code
      (omits `grant_type` for GitHub) and calls
      `authService.validateSocialUser` with the merged payload.
- [x] **T17**: All four provider readers
      (`getGitHubUser`/`getGoogleUser`/`getFacebookUser`/
      `getLinkedInUser`) implement the per-provider displayName
      fallback chain and `emailVerified` rules from FR-21.
- [x] **T18**: `SOCIAL_AUTH_PROVIDERS` map declares GitHub / Google
      / Facebook / LinkedIn with their authorization URLs, token
      URLs, scopes, callback resolvers, and (Facebook only)
      `scopeSeparator: ','` (FR-33).
- [x] **T19**: `getSocialAuthProviderConfig` throws
      `BadRequestException('Unsupported OAuth provider: <id>')` for
      anything outside the four-provider set.
- [x] **T20**: `SocialAuthService.getConfiguredProviders` filters by
      `clientId() && clientSecret()` so half-configured providers
      stay hidden from `GET /api/auth/providers`.
- [x] **T21**: `AuthService.validateSocialUser` reconciles new vs.
      existing users with the trusted-email rules from FR-15
      (suspended user → 401; untrusted email + no existing link →
      401; new user with trusted email → emit `UserConfirmedEvent`).

## Phase 5 — API keys (DONE)

- [x] **T22**: `ApiKeyService.createKey` enforces the 10-key cap and
      future-expiresAt validation, generates 32 bytes of entropy,
      prefixes with `ew_live_`, stores SHA-256 digest + 12-char
      prefix, returns the raw key once (FR-8).
- [x] **T23**: `ApiKeyService.validateKey` SHA-256 lookup,
      `null`-return on miss/expiry, fire-and-forget `updateLastUsed`
      with `.catch(() => {})` (FR-9).
- [x] **T24**: `ApiKeyService.listKeys` / `revokeKey` →
      repository-level `findByUserId` / `deleteByIdAndUserId`.
      Controller throws `NotFoundException` on revoke-miss.
- [x] **T25**: `AuthSessionGuard` extracts the API key from
      `x-api-key` OR `Authorization: Bearer …` (only when value
      starts with `ew_live_`), validates, hydrates `request.user`
      with `iss='ever-works'`/`aud='ever-works'` (FR-31).

## Phase 6 — Tests (PARTIAL)

- [x] **T26**: `auth.service.spec.ts` — 45 tests covering every
      method in §2 of `spec.md`. PR
      [#486](https://github.com/ever-works/ever-works/pull/486).
- [x] **T27**: `social-auth.service.spec.ts` — 37 tests covering all
      four providers, all happy + error paths. PR
      [#488](https://github.com/ever-works/ever-works/pull/488).
- [x] **T28**: `api-key.service.spec.ts` — 15 tests including
      10-key cap, sha256 hashing, expiry semantics, fire-and-forget
      updateLastUsed swallow. PR
      [#486](https://github.com/ever-works/ever-works/pull/486).
- [x] **T29**: `github-email.utils.spec.ts` — primary-email
      resolution from `/user/emails`.
- [ ] **T30 (follow-up)**: `auth.controller.spec.ts` — controller-level
      Jest suite covering all 14 endpoints. Pin: activity-log fire-and-forget
      shape on login, the `Failed to send verification email` warn
      log on register-side mail failure, the `verifyEmail` →
      `issueSession` chain, the reset-password 4-step
      (`getUserByPasswordResetToken` → `setPassword` →
      `consumePasswordResetToken` → `signOutAll`) ordering, and the
      `validateEmail*Token` non-throwing return shape.
- [ ] **T31 (follow-up)**: `oauth.controller.spec.ts` — controller-level
      Jest suite for the 2 endpoints. Pin: `getAuthUrl` calls
      `socialAuthService.getAuthorizationUrl(providerId, undefined,
  state)` with the explicit `undefined` for `callbackUrl`;
      `authRedirect` issues a session BEFORE logging the activity row;
      the activity-log payload contains
      `action='user.login.<providerId>'`,
      `summary='Signed in via <displayName>'`,
      `metadata={provider: providerId}`, and `ipAddress`/`userAgent`
      from `req.ip || req.headers['x-forwarded-for']` /
      `req.headers['user-agent']`; activity-log rejection is
      swallowed via `.catch(() => {})`.
- [ ] **T32 (follow-up)**: `api-keys.controller.spec.ts` —
      `revoke` returns `{message: 'API key revoked successfully'}` on
      success and throws `NotFoundException('API key not found')` on
      `deleteByIdAndUserId === false`.
- [ ] **T33 (follow-up)**: `auth-session.guard.spec.ts` — the
      most security-sensitive surface in the platform without a unit
      suite. Pin every branch: - `@Public()` short-circuits to `true`. - `x-api-key` header with `ew_live_*` prefix → `validateKey` →
      `findById` → hydrate `request.user`. - `Authorization: Bearer ew_live_*` → same path. - `x-api-key` AND `Bearer` both set → `x-api-key` wins. - Bearer token without `ew_live_` prefix → fall through to
      `authProvider.authenticate`. - API-key path: invalid key → 401 (`'Invalid or expired API key'`). - API-key path: user inactive → 401 (`'User account is inactive'`). - API-key path: `iss='ever-works'`, `aud='ever-works'`,
      `iat=floor(now/1000)`. - Session-token path: `iss='auth-runtime'`,
      `aud='ever-works-users'`. - Both paths fail → `UnauthorizedException` (no message). - `ModuleRef.get(...)` lazy resolution: first call hydrates
      `apiKeyService` + `userRepository`, second call reuses them
      (asserted via `mock.calls.length`).
- [ ] **T34 (follow-up)**: `auth-provider.service.spec.ts` —
      Better Auth runtime mocked at module scope. Pin: bearer-token
      path (`auth_session` lookup, expiry-deletes-the-row, hydrate
      via `assertActiveUser`), Better Auth cookie path (suspended
      user → `signOutAll` + 401), `signInEmail`'s
      `ensureCredentialAccount` call BEFORE `auth.api.signInEmail`,
      the password-mirror update with `registrationProvider='local'` + `lastLoginAt`, and the `'Failed to establish authenticated
  session'` 401 when Better Auth returns no token.
- [ ] **T35 (follow-up)**: `auth-sync.service.spec.ts` — pin
      `ensureCredentialAccount` upsert shape, `getCredentialPasswordHash`
      null-on-missing, and `syncCredentialPassword` field write.
- [ ] **T36 (follow-up)**: `apps/web/e2e/auth.spec.ts` — audit
      against §2.1 / §2.2 of `spec.md`. Confirm every scenario has a
      matching playwright case; add what's missing (notably the
      OAuth callback flow with route-mocked GitHub).

## Phase 7 — Hardening (FOLLOW-UPS / out-of-scope deltas)

- [ ] **T37 (OQ-2)**: Verify OAuth `state` on callback. Persist a
      short-TTL Redis key on URL request keyed by `state`; verify
      and delete on callback; throw `BadRequestException('Invalid
  OAuth state')` on miss.
- [ ] **T38 (OQ-3)**: Gate the `verificationToken` /
      `resetToken` echo behind `NODE_ENV !== 'production'`. The
      shape becomes `{message, expiresAt}` in prod, drop-in compatible
      with the web client (which already prefers the email link).
- [ ] **T39 (OQ-1)**: Document the `iss` split between
      `'ever-works'` (API key) and `'auth-runtime'` (session) in the
      `AuthenticatedUser` JSDoc and `auth/types/auth.types.ts`.
- [ ] **T40 (OQ-5)**: Investigate whether `signOutAll` should also
      call into Better Auth's session-purge API to terminate
      cookie-bound sessions. Likely a 5-line change; needs runtime
      familiarity to confirm the right API.
- [ ] **T41**: Per-key scopes for API keys (read-only / write /
      admin). Out of scope for this spec; track in
      `apps/api/src/auth/services/api-key.service.ts` as a future
      schema migration.

## Outstanding bugs / hazards observed during write-up

- **OBS-1 (T36)**: The OAuth callback path silently issues a session
  even when the `state` query param is unset. Combined with OQ-2
  this is exploitable; fix per T37.
- **OBS-2 (FR-11(f) / OQ-3)**: `sendVerificationEmail` echoes the
  raw verification token in the API response. Same for
  `forgotPassword`. Convenient in dev, hazardous in prod logs.
- **OBS-3 (T34)**: `AuthProviderService.signOutAll` does not call
  Better Auth's runtime session-purge API; cookie sessions can
  outlive a "log out everywhere" call until cookie expiry.
- **OBS-4 (R-3)**: `updateLastUsed` writes on every API-key request.
  Under load this becomes a hot row; debounce if profiling shows
  contention.
