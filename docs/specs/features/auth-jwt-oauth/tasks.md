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
- [x] **T30 (follow-up)**: `auth.controller.spec.ts` — 28 tests across
      all 14 endpoints. Pinned: activity-log fire-and-forget shape on
      login (`req.ip` → `x-forwarded-for` fallback, `.catch(() => {})`
      swallow), `Failed to send verification email` warn log on
      register-side mail failure with non-Error → `String()` coercion,
      `verifyEmail` → `issueSession` chain (no session issue when
      verify rejects), reset-password 4-step ordering pinned via
      shared `order: string[]` array (`getUserByPasswordResetToken` →
      `setPassword` → `consumePasswordResetToken` → `signOutAll`),
      `validateEmail*Token` non-throwing return shape, `register`
      `assertCanRegister` → `signUpEmail` → `sendVerificationEmail`
      ordering, `sendVerification` deliberate omission of callback URL
      (unlike `register`). PR
      [#597](https://github.com/ever-works/ever-works/pull/597).
- [x] **T31 (follow-up)**: `oauth.controller.spec.ts` — 9 tests across
      the 2 endpoints. Pinned: `getAuthUrl` calls
      `socialAuthService.getAuthorizationUrl(providerId, undefined,
      state)` with explicit `undefined` for `callbackUrl`;
      `authRedirect` runs `socialAuth.authenticate` →
      `authProvider.issueSession` → `activityLogService.log` order;
      activity-log payload contains `action='user.login.<providerId>'`,
      `summary='Signed in via <displayName>'`,
      `metadata={provider: providerId}`, `ipAddress`/`userAgent`
      derivation from `req.ip || req.headers['x-forwarded-for']` /
      `req.headers['user-agent']`; activity-log rejection is swallowed
      via `.catch(() => {})`; activity-log emission registered AFTER
      `issueSession` resolves so it does NOT fire on session-store
      failure. PR [#597](https://github.com/ever-works/ever-works/pull/597).
- [x] **T32 (follow-up)**: `api-keys.controller.spec.ts` — 10 tests
      pinning all 3 endpoints. `revoke` returns `{message: 'API key
      revoked successfully'}` on `true`, throws `NotFoundException('API
      key not found')` on `false`, propagates non-NotFound errors
      verbatim. The critical `revokeKey(keyId, userId)` positional
      invariant — NOT `(userId, keyId)` — pinned via dedicated test so
      a future refactor cannot accidentally let any user revoke any
      key by swapping args. PR
      [#597](https://github.com/ever-works/ever-works/pull/597).
- [x] **T33 (follow-up)**: `auth-session.guard.spec.ts` — 19 tests
      pinning every branch of the four-mode guard surface: `@Public()`
      short-circuit; `x-api-key` header with `ew_live_*` prefix
      (rejects array headers, falls through on non-string /
      non-prefixed values); `Authorization: Bearer ew_live_*` (falls
      through on non-`ew_live_` Bearer tokens, falls through on
      lowercase `bearer` because scheme matching is case-sensitive);
      precedence (`x-api-key` wins over `Authorization` when both
      set); successful API-key path constructs the documented
      `AuthenticatedUser` envelope w/ `iss:'ever-works'`/`aud:'ever-works'`/`iat=now`,
      falsy-`avatar` coerced to `null`, truthy-`avatar` preserved
      verbatim; `UnauthorizedException('Invalid or expired API key')`
      on null `validateKey`, `UnauthorizedException('User account is
      inactive')` for missing-user AND inactive-user; lazy
      `ModuleRef.get(ApiKeyService, {strict:false})` +
      `ModuleRef.get(UserRepository, {strict:false})` resolution that
      fires only on the FIRST API-key request and is cached on the
      guard instance for subsequent requests; AuthProvider fallback
      (returns true + attaches provider user with the original `cookie`
      header propagated through `toHeaders()`, throws on `null`
      provider user, propagates errors verbatim, treats missing
      `request.headers` as empty without crashing). PR
      [#597](https://github.com/ever-works/ever-works/pull/597).
- [x] **T34 (follow-up)**: `auth-provider.service.spec.ts` — 39 tests.
      Pinned: bearer-token path (`auth_session` lookup, expiry deletes
      the row, hydrate via `assertActiveUser`); Better Auth cookie
      path (suspended user → `signOutAll` + 401, `isActive: undefined`
      treated as active, only strict-`false` trips suspended); falsy
      avatar / image coerced to `null`; `registrationProvider`
      fallback to `'local'`; `signInEmail` ordering
      (`ensureCredentialAccount` BEFORE `auth.api.signInEmail` via
      shared `order: string[]` array, password mirror skipped on
      social-only / non-existent users), post-sign-in update writes
      `password` + `lastLoginAt` + `registrationProvider:'local'`,
      `'Failed to establish authenticated session'` 401 when Better
      Auth returns no token, suspended user via `assertActiveUser`
      AFTER Better Auth call; `signUpEmail` token-vs-no-token branches
      (token → direct envelope; no token → falls through to
      `issueSession`), post-sign-up update sets `isActive: true` +
      `registrationProvider: 'local'`; `issueSession` 7-day TTL
      (within 60s of `now + 7 * 24 * 60 * 60 * 1000`),
      `ipAddress`/`userAgent` initialised to null, fresh token per
      call; `changePassword` no-credential rejection, bcrypt
      mismatch, success path writes new hash to BOTH stores; `setPassword`
      hashes via runtime `password.hash` then writes both stores;
      `signOut` bearer-vs-cookie branching (deletes session row when
      bearer present, delegates to Better Auth otherwise);
      `signOutAll` deletes every session row for the user;
      `getBearerToken` private branches via `authenticate`
      (case-insensitive `bearer`/`Bearer` scheme matching, non-bearer
      schemes fall through, empty token after split → null,
      missing-Authorization → null). 4 tests on
      `request-headers.spec.ts` cover the `toHeaders` helper used by
      every controller call site (Headers passthrough w/ defensive
      copy, plain-object → Headers conversion, undefined → empty
      Headers, falsy values skipped via `!value` guard, string-array
      values joined w/ `", "`, lowercase normalisation by Headers
      API). PR-pending.
- [x] **T35 (follow-up)**: `auth-sync.service.spec.ts` — 12 tests.
      Pinned: `findCredentialAccount` query shape `{ userId, providerId:
      'credential' }`; `ensureCredentialAccount` short-circuits
      WITHOUT writing when an existing row is present; new-row create
      uses `userId` for BOTH `userId` AND `accountId` fields with a
      fresh `randomUUID()` per call; `syncCredentialPassword` falls
      through to `ensureCredentialAccount` when no row exists, calls
      `repository.update(id, { password })` ONLY (no other columns
      touched) when one does; `getCredentialPasswordHash` returns the
      hash on hit, null on missing row, null on null/empty-string
      password (the `account?.password || null` collapse). PR-pending.
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
