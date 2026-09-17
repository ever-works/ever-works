# Implementation Plan: Ever ID

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation
> detail; the spec owns behaviour. **Every path below was opened in the worktree before it was written
> down** — no path in this document is invented. Paths marked **new** do not exist yet.

**Epic ID**: `APW-12-ever-id`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md) · **Cross-platform**:
[`./cross-platform.md`](./cross-platform.md) · **Identity provider decision**: [`./idp-options.md`](./idp-options.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Contract names used (from [`../CONTRACTS.md`](../CONTRACTS.md))**: entity `ExternalIdentity` (table
`external_identities`) · capability `identity-provider` · routes `/api/auth/ever-id/*` · flag `ever-id` ·
consumed by APW-11: delegated scope `apps:read`, `@DelegatedRead` route metadata.
**Migration block**: `179212` + two-digit slot + `00000` (README §7 rule 6).
**Program audit resolutions applied** ([`../CONTRACTS.md`](../CONTRACTS.md) §0): R-1 (shared types in
`packages/contracts/src/apps/ever-id.ts`), R-2 (Activity rows keep a snake-case `actionType` family and a dotted
`action`, §5.6), R-19 (`authMethod` exists; this epic appends `'ever-id-delegated'` only, admitted solely on
`@DelegatedRead(scope)` routes, §5.3), R-22 (no suite under `apps/api/test/`; the API flow runs as a Jest integration
spec under `apps/api/src/auth/`, §10.3).

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer     | File                                                                                                                                                                                                                                                                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth API  | [`apps/api/src/auth/providers/auth-provider.abstract.ts`](../../../../../apps/api/src/auth/providers/auth-provider.abstract.ts)                                                                                                                                                                                                                                    | `AuthProvider` abstraction: `authenticate`, `signInEmail`, `signUpEmail`, `issueSession(userId, clientFingerprint?)`, `signOut`, `signOutAll`. Bound via `AUTH_PROVIDER`.                                                                                                                                                                                  |
| Auth API  | [`auth-provider.service.ts`](../../../../../apps/api/src/auth/providers/auth-provider.service.ts)                                                                                                                                                                                                                                                                  | Better Auth behind the abstraction. Sessions are random bearers stored as `tokenHash = sha256(token)` (module-private `hashSessionToken`); `createSessionRecord` sets `expiresAt = now + 7 days`; bearer lookups check expiry and `isActive`.                                                                                                              |
| Auth API  | [`auth-runtime.instance.ts`](../../../../../apps/api/src/auth/providers/auth-runtime.instance.ts)                                                                                                                                                                                                                                                                  | `betterAuth({...})` with `bearer()` + terms plugin only. `account.accountLinking.trustedProviders: ['google','github','linkedin']`. **Not an OpenID Connect provider**; no JWKS; no OAuth server.                                                                                                                                                          |
| Auth API  | [`config/social-auth.providers.ts`](../../../../../apps/api/src/auth/config/social-auth.providers.ts)                                                                                                                                                                                                                                                              | `SOCIAL_AUTH_PROVIDERS: Record<SocialAuthProviderId, …>` with hard-coded endpoints for four providers. The `Record` is keyed by `AuthProvider` minus `LOCAL`, so adding an enum member breaks it.                                                                                                                                                          |
| Auth API  | [`services/social-auth.service.ts`](../../../../../apps/api/src/auth/services/social-auth.service.ts)                                                                                                                                                                                                                                                              | Confidential-client code → token exchange, userinfo fetch, then `AuthService.validateSocialUser`.                                                                                                                                                                                                                                                          |
| Auth API  | [`services/auth.service.ts`](../../../../../apps/api/src/auth/services/auth.service.ts) `validateSocialUser`                                                                                                                                                                                                                                                       | Finds the user **by e-mail** (`findByEmailForSocialAuth`), creates one if absent, refuses to link an untrusted e-mail, upserts an `account` row with provider tokens.                                                                                                                                                                                      |
| Auth API  | [`services/oauth-state.service.ts`](../../../../../apps/api/src/auth/services/oauth-state.service.ts)                                                                                                                                                                                                                                                              | 32-byte `state`, HttpOnly `ew_oauth_state` cookie, `Max-Age=600`, constant-time compare, single use.                                                                                                                                                                                                                                                       |
| Auth API  | [`controllers/oauth.controller.ts`](../../../../../apps/api/src/auth/controllers/oauth.controller.ts)                                                                                                                                                                                                                                                              | `GET api/oauth/:providerId/url` and `/callback`; the callback calls `issueSession` and logs `USER_LOGIN` with `action: user.login.<provider>`.                                                                                                                                                                                                             |
| Auth API  | [`controllers/auth.controller.ts`](../../../../../apps/api/src/auth/controllers/auth.controller.ts)                                                                                                                                                                                                                                                                | `GET providers` → `{ emailPassword, magicLink, socialProviders }`; `logout`, `logout-all`; `@Throttle({ long: { limit, ttl } })` per route; magic link gated by `MAGIC_LINK_ENABLED`.                                                                                                                                                                      |
| Auth API  | [`guards/auth-session.guard.ts`](../../../../../apps/api/src/auth/guards/auth-session.guard.ts)                                                                                                                                                                                                                                                                    | `@Public()` → `ew_live_` / `ew_run_` machine credentials (never fall through) → `authProvider.authenticate`. Fleet-run tokens are restricted to an allow-listed route set and stash `request.fleetRunCredential`. Since AW-24 both branches stamp `authMethod` (`'api-key'` for `ew_live_` **and** `ew_run_`; `'session'` by copy on the provider branch). |
| Auth API  | [`guards/platform-admin.guard.ts`](../../../../../apps/api/src/auth/guards/platform-admin.guard.ts)                                                                                                                                                                                                                                                                | `IsPlatformAdminGuard`.                                                                                                                                                                                                                                                                                                                                    |
| Auth API  | [`types/auth.types.ts`](../../../../../apps/api/src/auth/types/auth.types.ts)                                                                                                                                                                                                                                                                                      | `AuthenticatedUser` with `authMethod?: 'session' \| 'api-key'` (added by AW-24 after authoring; `HumanActorGuard` in `apps/api/src/safety/guards/human-actor.guard.ts` admits only `'session'` and fails closed on a missing stamp), `TokenResponse { access_token, user }`.                                                                               |
| Auth API  | [`auth.module.ts`](../../../../../apps/api/src/auth/auth.module.ts)                                                                                                                                                                                                                                                                                                | Imports `DatabaseModule`, `HttpModule`, `ActivityLogModule`; registers the three controllers and services above.                                                                                                                                                                                                                                           |
| Terms     | [`apps/api/src/terms/terms-acceptance.service.ts`](../../../../../apps/api/src/terms/terms-acceptance.service.ts)                                                                                                                                                                                                                                                  | `record(...)` — what the register path uses to store accepted terms documents.                                                                                                                                                                                                                                                                             |
| Bootstrap | [`apps/api/src/main.ts`](../../../../../apps/api/src/main.ts)                                                                                                                                                                                                                                                                                                      | `json` + `urlencoded` body parsers (the back-channel logout body is form-encoded).                                                                                                                                                                                                                                                                         |
| Entity    | [`packages/agent/src/entities/auth-session.entity.ts`](../../../../../packages/agent/src/entities/auth-session.entity.ts)                                                                                                                                                                                                                                          | `session`: `id`, `userId`, nullable `token`, `tokenHash` (unique), `expiresAt`, `ipAddress`, `userAgent`, `tenantId`, timestamps.                                                                                                                                                                                                                          |
| Entity    | [`auth-account.entity.ts`](../../../../../packages/agent/src/entities/auth-account.entity.ts)                                                                                                                                                                                                                                                                      | `account`: unique `(providerId, accountId)` and `(userId, providerId)`; token columns. No issuer.                                                                                                                                                                                                                                                          |
| Entity    | [`auth-verification.entity.ts`](../../../../../packages/agent/src/entities/auth-verification.entity.ts)                                                                                                                                                                                                                                                            | `verification`: `identifier`, `value` (**unique**), `expiresAt`. Reused as the replay store (§3.3).                                                                                                                                                                                                                                                        |
| Entity    | [`user.entity.ts`](../../../../../packages/agent/src/entities/user.entity.ts)                                                                                                                                                                                                                                                                                      | `registrationProvider: string` (free string — `'ever-id'` needs no enum change).                                                                                                                                                                                                                                                                           |
| Activity  | [`activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) · [`activity-log.entity.ts`](../../../../../packages/agent/src/entities/activity-log.entity.ts)                                                                                                                                                                        | `ActivityActionType.USER_LOGIN`, `USER_SIGNUP`, `PROVIDER_CONNECTED`; `actionType` is `varchar(50)`, `action` `varchar(100)` — new members need no migration.                                                                                                                                                                                              |
| Registry  | [`_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts) · [`_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts) · [`_repository-inventory.ts`](../../../../../packages/agent/src/database/_repository-inventory.ts) · [`entities/index.ts`](../../../../../packages/agent/src/entities/index.ts) | Entity and repository registration lists guarded by drift specs.                                                                                                                                                                                                                                                                                           |
| Plugins   | [`packages/plugin/src/contracts/plugin-manifest.types.ts`](../../../../../packages/plugin/src/contracts/plugin-manifest.types.ts) · [`facade-capabilities.ts`](../../../../../packages/plugin/src/contracts/facade-capabilities.ts)                                                                                                                                | `PLUGIN_CATEGORIES` (no identity category) and `PLUGIN_CAPABILITIES` (`OAUTH`, `DEVICE_AUTH`, …; no identity provider).                                                                                                                                                                                                                                    |
| Plugins   | [`capabilities/oauth.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/oauth.interface.ts) · [`device-auth-provider.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/device-auth-provider.interface.ts)                                                                                                             | `IOAuthPlugin` (plugin connection OAuth, no ID token validation) and `IDeviceAuthProvider` (a plugin's own device login). **Neither fits relying-party sign-in**; both stay untouched.                                                                                                                                                                     |
| Plugins   | [`packages/plugin/src/settings/json-schema.types.ts`](../../../../../packages/plugin/src/settings/json-schema.types.ts) · [`packages/plugins/cloudflare-dns/src/settings.schema.ts`](../../../../../packages/plugins/cloudflare-dns/src/settings.schema.ts)                                                                                                        | `x-secret`, `x-envVar`, `x-scope: 'global' \| 'tenant' \| 'user' \| 'work'` — the pattern for admin-only secrets with env fallbacks.                                                                                                                                                                                                                       |
| Facades   | [`packages/agent/src/facades/oauth.facade.ts`](../../../../../packages/agent/src/facades/oauth.facade.ts) · [`facades.module.ts`](../../../../../packages/agent/src/facades/facades.module.ts)                                                                                                                                                                     | Capability resolution through `PluginRegistryService`; `FACADES` provider list.                                                                                                                                                                                                                                                                            |
| Web       | [`apps/web/src/lib/auth/cookies.ts`](../../../../../apps/web/src/lib/auth/cookies.ts)                                                                                                                                                                                                                                                                              | `everworks_auth_token` (encrypted, HttpOnly, `secure` from the public URL scheme, SameSite=Lax, 7 days); `oauth_state` and `redirect_url` cookies (10 min).                                                                                                                                                                                                |
| Web       | [`apps/web/src/app/api/auth/authorize/route.ts`](../../../../../apps/web/src/app/api/auth/authorize/route.ts) · [`lib/utils/url.ts`](../../../../../apps/web/src/lib/utils/url.ts)                                                                                                                                                                                 | The existing local-client browser hand-off. **Kept unchanged; must not be extended**, and described only generically here (Resolution R-14: existing, unfixed weaknesses are not reproduced in this public repository — the mechanism and its allow-list constant are recorded in the private operations repository).                                      |
| Web       | [`app/actions/auth.ts`](../../../../../apps/web/src/app/actions/auth.ts) `connectProvider` · [`app/api/oauth/oauth-callback-handler.ts`](../../../../../apps/web/src/app/api/oauth/oauth-callback-handler.ts) · [`callback-errors.ts`](../../../../../apps/web/src/app/api/oauth/callback-errors.ts)                                                               | Server action gets `{url, state}` from the API and mirrors `state` into a cookie; the callback compares, calls the API, sets the auth cookie and maps errors to `/auth/error?error=oauth_*`.                                                                                                                                                               |
| Web       | [`lib/auth/providers.ts`](../../../../../apps/web/src/lib/auth/providers.ts) · [`lib/api/auth.ts`](../../../../../apps/web/src/lib/api/auth.ts) · [`lib/api/enums.ts`](../../../../../apps/web/src/lib/api/enums.ts)                                                                                                                                               | Reads `/auth/providers`; typed API client; `OAuthProvider` enum (four members, left untouched).                                                                                                                                                                                                                                                            |
| Web       | [`components/auth/social-login.tsx`](../../../../../apps/web/src/components/auth/social-login.tsx) · [`(auth)/login/login-client.tsx`](<../../../../../apps/web/src/app/[locale]/(auth)/login/login-client.tsx>) · [`(auth)/register/register-form.tsx`](<../../../../../apps/web/src/app/[locale]/(auth)/register/register-form.tsx>)                             | `SocialLoginButtons` with a `disabled` consent gate used by registration.                                                                                                                                                                                                                                                                                  |
| Web       | [`components/settings/SecuritySettings.tsx`](../../../../../apps/web/src/components/settings/SecuritySettings.tsx) · [`settings/security/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/security/page.tsx>)                                                                                                                             | Security page: change password, two-factor and sessions placeholders; i18n `dashboard.settings.security`.                                                                                                                                                                                                                                                  |
| Web       | [`(auth)/auth/error/auth-error-content.tsx`](<../../../../../apps/web/src/app/[locale]/(auth)/auth/error/auth-error-content.tsx>)                                                                                                                                                                                                                                  | Maps `?error=` codes to `auth.error.*` copy.                                                                                                                                                                                                                                                                                                               |
| Web       | [`lib/feature-flags/work-kinds.ts`](../../../../../apps/web/src/lib/feature-flags/work-kinds.ts)                                                                                                                                                                                                                                                                   | Server-side PostHog flag evaluation, 1,500 ms cap, **fail-open**, module-level client singleton.                                                                                                                                                                                                                                                           |
| CLI       | [`apps/cli/src/commands/auth/oauth.service.ts`](../../../../../apps/cli/src/commands/auth/oauth.service.ts) · [`login.command.ts`](../../../../../apps/cli/src/commands/auth/login.command.ts)                                                                                                                                                                     | Loopback server on port 44663 receiving `sessionToken` from the web authorize route; `--manual` option.                                                                                                                                                                                                                                                    |
| Node      | [`apps/node/src/core/auth-client.ts`](../../../../../apps/node/src/core/auth-client.ts) · [`runtime.ts`](../../../../../apps/node/src/core/runtime.ts)                                                                                                                                                                                                             | `PlatformAuthClient.signIn(email, password)` → session token, protected from logs.                                                                                                                                                                                                                                                                         |
| Program   | [`../APW-11-app-launcher/plan.md`](../APW-11-app-launcher/plan.md) §2.4, §4.7                                                                                                                                                                                                                                                                                      | Delegated read: host obtains an Ever ID token (audience `ever-works`, scope `apps:read`); `GET /api/me/apps` asks this epic's facade to verify it; route metadata `@DelegatedRead('apps:read')`; `403 insufficientScope`.                                                                                                                                  |

### 1.2 The exact blockers

- **No OpenID Connect relying-party code exists.** The social flow is OAuth 2.0 plus a userinfo call; it has
  no ID token, key set or issuer handling to build on, so Ever ID gets its own code path.
- **Social sign-in resolves accounts by e-mail address** (`validateSocialUser`, Better Auth's
  `trustedProviders`), with its own verified-e-mail rules. Ever ID follows a different rule and must not enter
  that path (spec FR-20, FR-22).
- **Sessions do not record their origin.** Nothing can find "the sessions Ever ID opened" for a sign-out
  notice or a disconnect.
- **The guard cannot say how a request authenticated.** Connect and disconnect must refuse API keys and
  delegated tokens (spec S27), and a delegated token must be admissible on exactly one handler.
- **No identity capability exists** in the plugin contracts, so an identity provider cannot be added
  plugin-first today.
- **The web flag helper fails open** — correct for Work kinds, wrong for an authentication method.

### 1.3 What already exists and must be reused, not rebuilt

- **Session issuance** — `AuthProvider.issueSession` (one additive optional argument, §5.4).
- **Session hashing** — `hashSessionToken` (exported, not copied).
- **`state` cookie discipline** — `OAuthStateService`'s single-use, constant-time, 600-second pattern.
- **The web callback shape** — `connectProvider` + `handleOAuthCallback` + `getOAuthRouteErrorCode`.
- **Terms recording** — `TermsAcceptanceService.record` for sign-up.
- **Replay store** — the `verification` table's unique `value` index.
- **Platform admin gate** — `IsPlatformAdminGuard`. **Throttling** — the existing `@Throttle` decorator.
- **Admin-only secrets** — `x-secret` + `x-scope: 'global'` + `x-envVar` as in the Cloudflare DNS plugin.

---

## 2. Architecture

### 2.1 One plugin, one facade, one controller, one guard branch

```
            ┌───────────────────── Ever ID (external OpenID Connect provider) ─────────────────────┐
            │ discovery · authorize · token · JWKS · device authorization · end session            │
            └───────▲──────────────────────▲───────────────────────────────┬──────────────────────┘
                    │ browser redirect      │ server-to-server (5 s)        │ back-channel logout
   ┌────────────────┴─────┐      ┌──────────┴──────────────────────┐        │ (form POST)
   │ apps/web             │      │ packages/plugins/oidc-identity  │ NEW    │
   │ server action + route│      │  implements identity-provider   │        │
   │ ew_everid_txn cookie │      │  (openid-client + jose, ESM)    │        │
   └────────┬─────────────┘      └──────────▲──────────────────────┘        │
            │ server-to-server              │ resolved by                   │
            ▼                               │                               ▼
   ┌───────────────────────────────────────────────────────────────────────────────────────────┐
   │ apps/api  EverIdController  /api/auth/ever-id/*                                     NEW   │
   │   EverIdSignInService ─ EverIdLinkingService ─ EverIdSessionService ─ EverIdSealService    │
   │   EverIdReplayService (verification table)                                                │
   │                    │                                                                      │
   │                    └──► IdentityProviderFacadeService (packages/agent, admin tier only) NEW│
   │ AuthSessionGuard  + delegated branch → request.user.authMethod = 'ever-id-delegated'      │
   │                     admitted only on handlers with @DelegatedRead(scope)                  │
   └───────────────────────────────────────────────────────────────────────────────────────────┘
                    │ reads/writes
                    ▼
     external_identities (NEW) · session (+ externalIdentityId, externalSid) · verification · users
```

The whole behavioural change to existing code is: one optional argument on `issueSession`, one exported
helper, one additive `authMethod` value (`'ever-id-delegated'`; the field itself shipped with AW-24), one guard branch that admits a JWT bearer only where route metadata
allows it, one additive field on `GET /api/auth/providers`, and two nullable columns on `session`.

### 2.2 Request flow — browser sign-in

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as apps/web
    participant A as apps/api
    participant P as oidc-identity plugin
    participant E as Ever ID
    B->>W: click "Sign in with Ever ID" (server action startEverIdSignIn)
    W->>A: POST /api/auth/ever-id/authorize {returnTo}
    A->>P: buildAuthorizationRequest(redirectUri, scopes)
    P-->>A: {url, state, nonce, codeVerifier}
    A-->>W: {authorizationUrl, transaction = seal(txn, 600 s)}
    W->>B: Set-Cookie ew_everid_txn (HttpOnly, Lax, Path=/) + navigate
    B->>E: authorize (S256, state, nonce)
    E-->>B: 302 {redirect}?code&state&iss
    B->>W: GET /api/auth/ever-id/callback
    W->>A: POST /api/auth/ever-id/callback {code, state, iss, transaction} (+ bearer if signed in)
    A->>A: unseal, constant-time state compare, single-use (replay store)
    A->>P: exchangeAuthorizationCode(code, verifier, expectedNonce, receivedIss)
    P->>E: token endpoint (client_secret_basic)
    P-->>A: verified ID token claims
    A->>A: EverIdLinkingService.resolve(claims, intent)
    A-->>W: outcome (signedIn | confirmSignUp | confirmConnect | emailInUse | error code)
    W->>B: clear cookie; set auth cookie or pending cookie; redirect
```

### 2.3 Request flow — connect, sign-out notice, device sign-in, delegated read

- **Connect.** `POST /api/auth/ever-id/connect/authorize` (session-only) checks the current session's
  `createdAt` ≥ now − 12 h (lookup by `hashSessionToken(bearer)`), then seals a transaction with
  `intent: 'connect'`, `userId`, and asks the plugin for `prompt=login` + `max_age=300`. The callback requires
  the same user's bearer, `auth_time` ≤ 300 s + skew and `email_verified`, and answers `confirmConnect` with a
  sealed pending value (300 s). `POST /connect/confirm` (session-only) consumes it once and inserts the row.
- **Sign-out notice.** Ever ID posts `logout_token` to `POST /api/auth/ever-id/backchannel-logout`.
  `P.verifyLogoutToken` validates it; `EverIdReplayService` rejects a reused `jti`; `EverIdSessionService`
  deletes `session` rows by `externalSid`, or by `externalIdentityId` for a `sub`-only token.
- **Device sign-in.** The CLI or node reads `GET /api/auth/ever-id/client-config`, runs RFC 8628 directly
  against Ever ID with its own public client ID, then calls `POST /api/auth/ever-id/session` with
  `Authorization: Bearer <Ever ID access token>`. The API validates it (§4.4) and returns a `TokenResponse`.
- **Delegated read (APW-11).** `AuthSessionGuard` sees a three-segment bearer that is not an `ew_` credential,
  reads the handler's `@DelegatedRead` metadata, and only then calls `IdentityProviderFacadeService
.verifyAccessToken`. Without metadata the guard never calls the facade and answers the plain 401.

---

## 3. Data model

**Workspace backup (Resolution R-25).** `ExternalIdentity` joins `BACKUP_DROPPED_ENTITIES` beside the session tables; the two `session` columns are covered because `AuthSession` is already dropped ([tasks](./tasks.md) T46).

### 3.1 `external_identities` — new table (`ExternalIdentity`, Tier B)

| Column                   | Type                      | Notes                                                                                        |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                     | `uuid` PK                 |                                                                                              |
| `userId`                 | `uuid` NOT NULL           | `@ManyToOne(() => User, { onDelete: 'CASCADE' })` (spec FR-30)                               |
| `issuer`                 | `varchar(512)` NOT NULL   | exact `iss` string                                                                           |
| `subject`                | `varchar(255)` NOT NULL   | exact `sub`                                                                                  |
| `emailAtLink`            | `varchar(320)` NOT NULL   | display only; never used to resolve an account                                               |
| `emailVerifiedAtLink`    | `boolean` NOT NULL        | always `true` for rows this epic writes; kept for other issuers' future rules                |
| `linkedVia`              | `varchar(16)` NOT NULL    | `sign-up` \| `settings`                                                                      |
| `linkedAt`               | `PortableDateColumn`      |                                                                                              |
| `lastLoginAt`            | `PortableDateColumn` NULL |                                                                                              |
| `delegatedClients`       | `simple-json` NULL        | `Array<{ clientId: string; lastSeenAt: string }>`, ≤ 10 entries, oldest evicted (spec FR-48) |
| `tenantId`               | `uuid` NULL               | Tier B scope stamp (tenants-and-organizations spec §2.3); **no** `organizationId`            |
| `createdAt`, `updatedAt` | timestamps                |                                                                                              |

Indexes: `uq_external_identities_issuer_subject` UNIQUE `(issuer, subject)` (spec FR-21, S24 race is
decided by this index) · `uq_external_identities_user_issuer` UNIQUE `(userId, issuer)` ·
`idx_external_identities_user` `(userId)`.

Entity file **new** `packages/agent/src/entities/external-identity.entity.ts`; repository **new**
`packages/agent/src/database/repositories/external-identity.repository.ts` with `findByIssuerSubject`,
`listForUser`, `insertLink` (maps unique violations to `ExternalIdentityConflictError` with
`reason: 'subjectLinked' | 'userHasIssuer'`), `deleteForUser(id, userId)`, `touchLogin`,
`recordDelegatedClient`. Registration in all four places: `entities/index.ts`, `AGENT_ENTITY_NAMES`,
`ENTITIES`, `_repository-inventory.ts`.

### 3.2 `session` — two additive nullable columns

| Column               | Type                | Why                                                             |
| -------------------- | ------------------- | --------------------------------------------------------------- |
| `externalIdentityId` | `uuid NULL`, no FK  | sessions opened by an identity (disconnect, `sub`-only notices) |
| `externalSid`        | `varchar(255) NULL` | Ever ID `sid` (notices with `sid`)                              |

Indexes `idx_session_external_identity` and `idx_session_external_sid`. No FK: a session row must never
block deleting an identity; disconnect deletes the sessions explicitly first. Better Auth's own adapter
never writes these columns; nulls are the default for every other sign-in method (spec FR-35).

### 3.3 Replay store — the existing `verification` table

`EverIdReplayService.consumeOnce(kind, key, ttlSeconds)` inserts `{ id: uuid, identifier: 'ever-id:<kind>',
value: sha256('<kind>|' + key), expiresAt }`. A unique violation on `value` means "already used". Kinds:
`txn` (key `state`, 600 s), `pending` (key pending id, 600 s), `jti` (key `iss|jti`, 600 s). Each insert
first deletes at most 100 expired `ever-id:%` rows. **The cleanup is two statements, not one** — a `SELECT` of up
to 100 expired ids (`id`, ordered by `expiresAt`) followed by
`DELETE FROM verification WHERE id IN (:ids)` — because the platform wires **Postgres, SQLite, MySQL and
MariaDB** (`packages/agent/src/database/database.config.ts`), and MySQL/MariaDB reject both `LIMIT` inside an `IN`
subquery and a subquery over the table being deleted from; a single-statement form would work on two engines and
fail on the other two (the same class of portability bug `b5a7d6857` fixed elsewhere). The repository spec covers
all four engines, and a duplicate-key race between the select and the delete is harmless — the row is already
expired and the next insert re-selects. No new table.

### 3.4 Sealed values (never persisted)

`EverIdSealService` — AES-256-GCM, key = HKDF-SHA256(`config.auth.secret()`, salt `ever-id`, info
`ever-id-seal-v1`, 32 bytes), random 12-byte IV, base64url, `v: 1`, hard cap 3,072 bytes so the cookie fits
under 4 KB. Kinds and TTLs:

| Kind      | Payload                                                                                   | TTL   |
| --------- | ----------------------------------------------------------------------------------------- | ----- |
| `txn`     | `state`, `nonce`, `codeVerifier`, `intent: 'sign-in' \| 'connect'`, `userId?`, `returnTo` | 600 s |
| `signUp`  | `id`, `issuer`, `subject`, `email`, `name`, `sid?`                                        | 600 s |
| `connect` | `id`, `issuer`, `subject`, `email`, `userId`, `sid?`                                      | 300 s |

A wrong kind, version, expiry or authentication tag is one error: `transactionInvalid` (spec S17).

### 3.5 Shared types

**New** `packages/contracts/src/apps/ever-id.ts` (Resolution R-1), exported through APW-03's barrel
`packages/contracts/src/apps/index.ts` and therefore from the package root `@ever-works/contracts`:

```ts
export const EVER_ID_REGISTRATION_PROVIDER = 'ever-id';
export const EVER_ID_SCOPES = { APPS_READ: 'apps:read', SESSION_EXCHANGE: 'ever-works:session' } as const;
export const EVER_ID_DEFAULT_API_AUDIENCE = 'ever-works';
export const EVER_ID_LIMITS = {
	stateBytes: 32,
	nonceBytes: 32,
	codeVerifierLength: 64,
	transactionTtlSeconds: 600,
	signUpPendingTtlSeconds: 600,
	connectPendingTtlSeconds: 300,
	idTokenMaxAgeSeconds: 600,
	connectMaxAuthAgeSeconds: 300,
	connectMaxSessionAgeSeconds: 43_200,
	defaultClockSkewSeconds: 60,
	maxClockSkewSeconds: 120,
	jwksCacheSeconds: 600,
	jwksUnknownKidCooldownSeconds: 30,
	jwksMaxStaleSeconds: 21_600,
	discoveryCacheSeconds: 3_600,
	outboundTimeoutMs: 5_000,
	logoutTokenMaxAgeSeconds: 300,
	replayWindowSeconds: 600,
	exchangeTokenMaxAgeSeconds: 300,
	delegatedTokenMaxLifetimeSeconds: 3_600,
	allowedIssuersMax: 3,
	localClientsMax: 5,
	delegatedClientsMax: 10,
	delegatedClientsWindowDays: 30,
	availabilityCacheSeconds: 60,
	delegatedClientNamesMax: 10,
	devicePollMinIntervalSeconds: 5,
	devicePollSlowDownStepSeconds: 5,
	deviceCodeMaxLifetimeSeconds: 900
} as const;
export const EVER_ID_SIGNING_ALGS = ['RS256', 'ES256', 'EdDSA'] as const;
export type EverIdErrorCode =
	| 'everIdDisabled'
	| 'providerUnavailable'
	| 'transactionInvalid'
	| 'emailNotVerified'
	| 'emailInUse'
	| 'signUpNotAllowed'
	| 'subjectLinked'
	| 'userHasIssuer'
	| 'reauthRequired'
	| 'sessionRequired'
	| 'lastSignInMethod'
	| 'notConnected'
	| 'accountDisabled'
	| 'everIdSignedOut'
	| 'tokenInQuery'
	| 'insufficientScope';
export type EverIdCallbackOutcome =
	| { outcome: 'signedIn'; access_token: string; user: { id: string; email: string | null; username: string } }
	| { outcome: 'confirmSignUp'; pending: string; identity: { email: string; name: string | null } }
	| { outcome: 'confirmConnect'; pending: string; identity: { email: string }; accountEmail: string }
	| { outcome: 'emailInUse'; email: string; pending: string };
```

`emailInUse` returns the address only because the person just proved control of it at Ever ID with
`email_verified: true` — and it returns it **inside the sealed `pending` value** as well, so the
account-exists page reads the address from the pending cookie (never from the query string) with no second
source of truth. `pending` is sealed by `EverIdSealService` under the `signUp` kind for 600 s and consumed
once, exactly like `confirmSignUp`.

### 3.6 Migrations (Constitution V)

| File (**new**)                                                           | Slot | Up                                                               | Down               |
| ------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------- | ------------------ |
| `apps/api/src/migrations/1792120000000-CreateExternalIdentities.ts`      | 00   | create `external_identities` + 3 indexes                         | drop the table     |
| `apps/api/src/migrations/1792120100000-AddExternalIdentityToSessions.ts` | 01   | add `externalIdentityId`, `externalSid` + 2 indexes to `session` | drop exactly those |

Generated from `apps/api/` with `pnpm typeorm migration:generate`, re-stamped into the block, portable
column types (`PortableDateColumn`), no backfill (every existing session is correctly "not opened by Ever
ID"). Re-stamp before merge if `develop` has moved past the program's base migration.

---

## 4. Plugin: the `identity-provider` capability

### 4.1 Contract

**New** `packages/plugin/src/contracts/capabilities/identity-provider.interface.ts`, exported from
`capabilities/index.ts`; `PLUGIN_CAPABILITIES.IDENTITY_PROVIDER = 'identity-provider'` in
`facade-capabilities.ts`; category `'identity'` appended to `PLUGIN_CATEGORIES` in `plugin-manifest.types.ts`.

```ts
export interface IdentityProviderCheck {
	id:
		| 'discovery'
		| 'issuerMatch'
		| 'endpoints'
		| 'pkceS256'
		| 'signingAlg'
		| 'backchannelLogout'
		| 'deviceAuthorization';
	ok: boolean;
	detail?: string;
}
export interface VerifiedIdTokenClaims {
	issuer: string;
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
	authTime: number | null;
	sid: string | null;
}
export interface VerifiedAccessTokenClaims {
	issuer: string;
	subject: string;
	audience: string[];
	scopes: string[];
	authorizedParty: string | null;
	issuedAt: number;
	expiresAt: number;
	jti: string | null;
}
export interface VerifiedLogoutTokenClaims {
	issuer: string;
	subject: string | null;
	sid: string | null;
	jti: string;
}
export interface IIdentityProviderPlugin extends IPlugin {
	testConnection(): Promise<IdentityProviderCheck[]>;
	getPublicConfig(): Promise<{
		issuer: string;
		displayName: string;
		localClients: Array<{ kind: 'cli' | 'node'; clientId: string }>;
		apiAudience: string;
		signUpAllowed: boolean;
	}>;
	buildAuthorizationRequest(input: {
		redirectUri: string;
		prompt?: 'login';
		maxAgeSeconds?: number;
	}): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }>;
	exchangeAuthorizationCode(input: {
		code: string;
		redirectUri: string;
		codeVerifier: string;
		expectedNonce: string;
		receivedIssuer?: string;
		maxAuthAgeSeconds?: number;
	}): Promise<VerifiedIdTokenClaims>;
	verifyAccessToken(
		token: string,
		input: {
			requiredScopes: string[];
			maxLifetimeSeconds: number;
			maxAgeSeconds?: number;
			allowedAuthorizedParties?: string[];
		}
	): Promise<VerifiedAccessTokenClaims>;
	verifyLogoutToken(token: string): Promise<VerifiedLogoutTokenClaims>;
	buildEndSessionUrl(input: { postLogoutRedirectUri: string; state: string }): Promise<string | null>;
}
export function isIdentityProviderPlugin(p: IPlugin): p is IIdentityProviderPlugin;
```

Every `verify*`/`exchange*` method throws `IdentityTokenRejectedError { code }` with a closed code set
(`badSignature`, `badIssuer`, `badAudience`, `expired`, `notYetValid`, `tooOld`, `badNonce`, `badAlg`,
`missingScope`, `lifetimeTooLong`, `badAuthorizedParty`, `badLogoutEvent`, `nonceInLogoutToken`,
`providerUnavailable`) — never a message containing token material.

### 4.2 Plugin package — **new** `packages/plugins/oidc-identity/`

- `package.json` `everworks.plugin`: `id: 'oidc-identity'`, `name: 'OpenID Connect identity (Ever ID)'`,
  `category: 'identity'`, `capabilities: ['identity-provider']`, `builtIn: true`, `autoEnable: false`,
  `license: 'AGPL-3.0'`. Dependencies: `openid-client@^6`, `jose@^6` — **only in this package**. tsup ESM,
  Vitest (Constitution I).
- `src/settings.schema.ts`, every property `x-scope: 'global'`:

| Key                    | Type / limits                                                                           | `x-envVar`                   | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuerUrl`            | string, `https://` (or `http://localhost`/`127.0.0.1` when `NODE_ENV !== 'production'`) | `EVER_ID_ISSUER_URL`         | required                                                                                                                                                                                                                                                                                                                                                                                 |
| `clientId`             | string ≤ 255                                                                            | `EVER_ID_CLIENT_ID`          | required                                                                                                                                                                                                                                                                                                                                                                                 |
| `clientSecret`         | string, `x-secret: true`                                                                | `EVER_ID_CLIENT_SECRET`      | required; `client_secret_basic`                                                                                                                                                                                                                                                                                                                                                          |
| `allowedIssuers`       | string[] 1–3                                                                            | `EVER_ID_ALLOWED_ISSUERS`    | default `[issuerUrl]`                                                                                                                                                                                                                                                                                                                                                                    |
| `apiAudience`          | string ≤ 255                                                                            | `EVER_ID_API_AUDIENCE`       | default `ever-works` (APW-11 §2.4)                                                                                                                                                                                                                                                                                                                                                       |
| `localClients`         | `{ kind: 'cli' \| 'node'; clientId }[]` ≤ 5                                             | —                            | public clients allowed at `/session`                                                                                                                                                                                                                                                                                                                                                     |
| `delegatedClientNames` | `{ clientId: string ≤ 255; displayName: string ≤ 60 }[]` ≤ 10                           | —                            | the names the card shows (FR-48); an unnamed `clientId` falls back to the client id itself                                                                                                                                                                                                                                                                                               |
| `accountManagementUrl` | string, `https://`                                                                      | —                            | the **Manage in Ever ID ↗** target (FR-48); unset hides the link                                                                                                                                                                                                                                                                                                                         |
| `signUpAllowed`        | boolean                                                                                 | `EVER_ID_SIGN_UP_ALLOWED`    | default `true`                                                                                                                                                                                                                                                                                                                                                                           |
| `clockSkewSeconds`     | integer 0–120                                                                           | `EVER_ID_CLOCK_SKEW_SECONDS` | default `60`                                                                                                                                                                                                                                                                                                                                                                             |
| `displayName`          | string ≤ 40                                                                             | —                            | default `Ever ID`                                                                                                                                                                                                                                                                                                                                                                        |
| `availability`         | object, **platform-written, not user-writable**                                         | —                            | `{ unavailableSince?: string; discoveryRefreshedAt?: string; jwksRefreshedAt?: string; lastLogoutNoticeAt?: string }` (§9.2). Stored, so every replica reads the same state and a re-test on one replica clears the flag on all of them; read through a cache of at most `EVER_ID_LIMITS.availabilityCacheSeconds` (60 s), which is what makes FR-5's disable bound hold across replicas |

`delegatedClientsWindowDays: 30` in `EVER_ID_LIMITS` bounds the card's list: the API filters
`external_identities.delegatedClients` to entries seen within that window when it builds `ExternalIdentityDto`,
so the filter runs in the API and never in the web.

- `src/oidc-identity.plugin.ts` implements §4.1 with `openid-client` (`discovery`, `buildAuthorizationUrl`
  with `code_challenge_method=S256`, `authorizationCodeGrant` with `pkceCodeVerifier`, `expectedNonce`,
  `expectedState` (checked again after the API's own constant-time compare) and `maxAge`) and `jose` (`createRemoteJWKSet` wrapped in
  `src/jwks-cache.ts` enforcing §4.3's numbers for access and logout tokens).
- `src/scopes.ts`: sign-in scopes `openid email profile`; the plugin never requests `offline_access`
  (spec FR-38).

### 4.3 Validation parameters (single source: `EVER_ID_LIMITS`)

| Check                    | Rule                                                                                                                                                 | Spec          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Algorithms               | header `alg` ∈ `EVER_ID_SIGNING_ALGS`; `none` and `HS*` rejected before key lookup                                                                   | FR-11         |
| Issuer                   | discovery `issuer` === `issuerUrl`; token `iss` === discovery issuer and ∈ `allowedIssuers`                                                          | FR-11, 12, 14 |
| ID token audience        | `aud` ∋ `clientId`; `aud.length > 1` ⇒ `azp === clientId`                                                                                            | FR-11         |
| ID token times           | `exp > now − skew`; `iat ≤ now + skew`; `iat ≥ now − 600`; connect: `auth_time ≥ now − 300 − skew`                                                   | FR-11, 25     |
| Access token (delegated) | `aud` ∋ `apiAudience`; scope ∋ `apps:read`; `exp − iat ≤ 3,600`; `exp > now − skew`                                                                  | FR-45         |
| Access token (exchange)  | `aud` ∋ `apiAudience`; scope ∋ `ever-works:session`; `azp` ∈ `localClients[].clientId`; `iat ≥ now − 300`; `jti` unused 600 s                        | FR-40         |
| Logout token             | `events` has `http://schemas.openid.net/event/backchannel-logout`; no `nonce`; `sid` or `sub`; `iat` within skew and ≥ now − 300; `jti` unused 600 s | FR-33         |
| Keys                     | cache 600 s; unknown `kid` → refetch, cooldown 30 s; stale use ≤ 21,600 s since last good fetch                                                      | FR-13         |
| Discovery                | cache 3,600 s; issuer drift → plugin reports unavailable until `testConnection` passes                                                               | FR-14         |
| Outbound                 | 5,000 ms timeout; token endpoint no retry; discovery/JWKS one retry after 1,000 ms                                                                   | FR-15         |

### 4.4 Facade — **new** `packages/agent/src/facades/identity-provider.facade.ts`

`IdentityProviderFacadeService` with `isAvailable()`, `getPublicConfig()`, and pass-throughs for every §4.1
method. Resolution reads **only platform-level enablement and settings**: the work → user → admin cascade
collapses to the admin tier by design, because sign-in runs before any user or Work exists (documented
under gate II in §12). No plugin ID appears outside the plugin; the facade asks `PluginRegistryService` for
the capability, like `OAuthFacadeService`. Registered in `FACADES` in `facades.module.ts` and exported
from `facades/index.ts`. Errors: `IdentityProviderUnavailableError` (not enabled, not configured, discovery
failing) → API `404 everIdDisabled` or `503 providerUnavailable` (§5.2).

---

## 5. API

### 5.1 Endpoints — **new** `apps/api/src/auth/controllers/ever-id.controller.ts` (`@Controller('api/auth/ever-id')`)

| Method + path                        | Auth                                            | Throttle (`long`)   | Request → response                                                            | Spec         |
| ------------------------------------ | ----------------------------------------------- | ------------------- | ----------------------------------------------------------------------------- | ------------ |
| `GET /api/auth/providers` (existing) | public                                          | existing            | + `everId: { enabled: boolean; displayName: string }`                         | FR-6         |
| `POST /authorize`                    | public                                          | 20 / 60 s / IP      | `{ returnTo? }` → `{ authorizationUrl, transaction }`                         | FR-8–10      |
| `POST /callback`                     | public; bearer read when `txn.intent = connect` | 20 / 60 s / IP      | `{ code, state, iss?, transaction }` → `EverIdCallbackOutcome`                | FR-11–25     |
| `POST /sign-up/confirm`              | public                                          | 10 / 60 s / IP      | `{ pending, terms: TermsAcceptanceClaimDto[] }` → `TokenResponse`             | FR-23        |
| `POST /connect/authorize`            | session only                                    | 10 / 60 s / user    | `{}` → `{ authorizationUrl, transaction }` · `403 reauthRequired`             | FR-25        |
| `POST /connect/confirm`              | session only                                    | 10 / 60 s / user    | `{ pending }` → `ExternalIdentityDto` · `409 subjectLinked \| userHasIssuer`  | FR-25–27     |
| `GET /identities`                    | session only                                    | default             | → `{ items: ExternalIdentityDto[], canDisconnect, disconnectBlockedReason? }` | FR-28, 48    |
| `DELETE /identities/:id`             | session only                                    | 10 / 3,600 s / user | → `204` · `409 lastSignInMethod` · `404`                                      | FR-28, 29    |
| `GET /logout-url`                    | session                                         | 10 / 60 s / user    | → `{ url }` when the current session has `externalIdentityId`, else `404`     | FR-36        |
| `POST /backchannel-logout`           | public, form-encoded                            | 60 / 60 s / IP      | `logout_token` → `200` (`Cache-Control: no-store`) · `400`                    | FR-33–35     |
| `POST /session`                      | public, Bearer Ever ID token                    | 10 / 60 s / IP      | → `TokenResponse` · `401` · `403 notConnected`                                | FR-39–40     |
| `GET /client-config`                 | public                                          | 30 / 60 s / IP      | → `{ issuer, localClients, scopes }` (no secrets)                             | FR-39        |
| `POST /admin/test`                   | `IsPlatformAdminGuard`                          | 10 / 60 s / user    | → `IdentityProviderCheck[]`                                                   | FR-3         |
| `GET /admin/health`                  | `IsPlatformAdminGuard`                          | default             | → `{ discoveryRefreshedAt, jwksRefreshedAt, lastLogoutNoticeAt }`             | §6.7 of spec |

`ExternalIdentityDto`: `{ id, displayName, email, linkedAt, linkedVia, lastLoginAt, delegatedClients }`. The
issuer and subject are never returned to the browser. DTOs **new** in `apps/api/src/auth/dto/ever-id.dto.ts`
(class-validator: `returnTo` ≤ 2,048 chars and must start with `/` but not `//`; `pending`/`transaction`
≤ 4,096 chars).

**Terms at sign-up use the existing contract, not a new one.** `terms` is `TermsAcceptanceClaimDto[]`
(`{ documentId, version, sha256, locale }`, the shape `apps/api/src/auth/dto/auth.dto.ts` already uses for
register), validated by the same `assertClaimsArePublished`, recorded through
`TermsAcceptanceService.record(userId, claims, { method, ip, userAgent })` with a new, named
`AcceptanceMethod` value for this path (`ever-id-signup`; the existing values are untouched). The
create-account page gets the required documents from the same source the register page uses — the published
terms the API exposes — and the web never invents a `documentId`.

**Sign-up ordering (replaces "one transaction").** `TermsAcceptanceService.record` writes through Better Auth's
adapter and `UserRepository.create` is a plain repository save, so the two cannot share a transaction. The
order is therefore explicit and compensatable: (1) verify the pending value and its single-use replay row;
(2) **pre-check** `(issuer, subject)` and take the link row first where the unique index allows, so a pair
already linked elsewhere fails before any account exists; (3) create the user
(`registrationProvider: EVER_ID_REGISTRATION_PROVIDER`, `emailVerified: true`, random bcrypt password as
`validateSocialUser` does); (4) record terms **best-effort**, exactly as register does — a terms failure is
logged and does not orphan the account; (5) `issueSession(..., origin)`. If step 2's insert fails after the
pre-check (the S24 race), the just-created user is **compensated** by deleting it before the error is returned,
and the spec asserts that no orphan user, `account` row or session survives the race.

**Query-token refusal (FR-17):** **new** `apps/api/src/auth/guards/no-token-in-query.guard.ts`, applied
controller-wide and to APW-11's delegated handler through `@DelegatedRead`, refuses any query key in
`access_token`, `id_token`, `logout_token`, `token`, `sessionToken`, `code_verifier` with `400 tokenInQuery`
before the handler runs and before any logging interceptor records the URL.
**It must run before authentication, or FR-17's `400` never happens for an unauthenticated caller:**
`AuthSessionGuard` is a global `APP_GUARD` registered first and answers `401` before any controller-level guard
runs, so a request carrying a query token and no `Authorization` header would get `401` instead of the `400` the
spec and APW-11 T25 assert. The check therefore lives in `AuthSessionGuard` itself — as the first thing it does
for handlers carrying the `NO_TOKEN_IN_QUERY` metadata (`@DelegatedRead` sets it) and for every path under
`/api/auth/ever-id/*` — and the standalone guard remains as the controller-level belt for handlers that opt in
without the session guard. The predicate is shared by both, so the two cannot drift.

### 5.2 Error contract

| Situation                                                 | Status | Body `code`                                                |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| Plugin not enabled/configured (sign-in family)            | 404    | `everIdDisabled`                                           |
| Discovery/JWKS/token endpoint unavailable or > 5 s        | 503    | `providerUnavailable`                                      |
| Bad/expired/replayed transaction or pending value         | 400    | `transactionInvalid`                                       |
| ID token rejected                                         | 401    | `transactionInvalid` (detail code logged server-side only) |
| `email_verified` not true                                 | 422    | `emailNotVerified`                                         |
| Sign-up disabled                                          | 403    | `signUpNotAllowed`                                         |
| Pair linked to another user / user already has issuer     | 409    | `subjectLinked` / `userHasIssuer`                          |
| Session older than 12 h or `auth_time` too old            | 403    | `reauthRequired`                                           |
| API key, fleet token or delegated token on session-only   | 403    | `sessionRequired`                                          |
| Disconnect would lock out                                 | 409    | `lastSignInMethod`                                         |
| Exchange for an unconnected pair                          | 403    | `notConnected`                                             |
| User inactive                                             | 403    | `accountDisabled`                                          |
| A session ended by a sign-out notice, on the next request | 401    | `everIdSignedOut` (the S6 notice; §5.4's marker)           |
| Token in query                                            | 400    | `tokenInQuery`                                             |
| Delegated token lacks scope on a `@DelegatedRead` handler | 403    | `insufficientScope` (APW-11 §4.5)                          |

### 5.3 Guard changes

- **Resolution R-19.** `AuthenticatedUser.authMethod?: 'session' | 'api-key'` already exists (AW-24) in
  `apps/api/src/auth/types/auth.types.ts`, and `AuthSessionGuard` already stamps both existing branches (machine
  credentials as `'api-key'`, the provider branch as `'session'`), asserted in `auth-session.guard.spec.ts`. This epic
  appends exactly one value, `'ever-id-delegated'`, to that union and changes no existing stamp (re-verified on
  `ee45946e5`). A delegated principal is admitted only on handlers carrying `@DelegatedRead(scope)`. AW-24's
  `HumanActorGuard` (`apps/api/src/safety/guards/human-actor.guard.ts`) admits only `'session'`, so it refuses a
  delegated token on every human-only route with no change to that guard.
- **New** `apps/api/src/auth/decorators/delegated-read.decorator.ts`: `DelegatedRead(scope)` sets
  `DELEGATED_READ_SCOPE` metadata and applies `NoTokenInQueryGuard`. APW-11 applies it to its list handler.
- In `AuthSessionGuard.canActivate`, **after** the machine-credential branch and **before**
  `authProvider.authenticate`: if the handler has `DELEGATED_READ_SCOPE` metadata and the bearer matches
  `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/` (Better Auth bearers never contain a dot), resolve
  `IdentityProviderFacadeService` lazily via `moduleRef` (same reason as `ApiKeyService`), verify, map
  `sub` through `ExternalIdentityRepository`, check `isActive`, set `authMethod: 'ever-id-delegated'`,
  stash `request.everIdDelegation = { subject, clientId, scopes }`, record the client (§3.1), and continue.
  Missing scope → `403 insufficientScope`; any other failure → the existing `UnauthorizedException()`.
  Without metadata the branch is skipped, so a JWT bearer falls through to the provider and 401s exactly as
  today (spec FR-46).
- **New** `apps/api/src/auth/guards/session-only.guard.ts`: after `AuthSessionGuard`, refuses when
  `authMethod !== 'session'` with `403 sessionRequired` (spec S27). Same predicate and fail-closed reading as AW-24's
  `HumanActorGuard` (`@HumanOnly()`), which stays separate because its copy, rail-refusal record and `403` body are
  specific to safety settings.

### 5.4 Sessions

- `AuthProvider.issueSession(userId, clientFingerprint?, origin?: { externalIdentityId: string;
externalSid?: string | null })` — optional third argument; `AuthProviderService.createSessionRecord`
  writes the two columns. Existing callers are unchanged.
- `hashSessionToken` becomes an export of `auth-provider.service.ts`.
- **New** `apps/api/src/auth/services/ever-id-session.service.ts`: `currentSession(headers)` (by hash),
  `endBySid(sid)`, `endByIdentity(identityId, exceptSessionId?)` — plain `DELETE` on `session`, returning the
  count for Activity. `signOutAll` already deletes every session of a user (spec FR-37 is a test, not code).
- **The S6 notice needs a signal, because a deleted session looks exactly like an expired one.** Before a
  back-channel notice deletes the rows for `sid` (or for `sub`), the service writes a short-lived marker keyed by
  the row's `tokenHash` — one `verification` row per ended session, `identifier` `ever-id:signedOut`,
  `value` `sha256('signedOut|' + tokenHash)`, TTL 300 s, reusing the existing table and its unique index rather
  than adding one. `AuthSessionGuard`'s provider branch, when `authenticate` fails for a bearer whose hash has a
  live marker, answers `401` with `code: 'everIdSignedOut'` (a new member of the closed error-code union) instead
  of the generic unauthorized body; the web maps that code to `auth.everId.signedOutByProvider` and shows the
  notice on the next page load. The marker is single-purpose, contains no token, and expires. Sessions ended by
  a `sub`-only notice get the same marker; a session that simply expired does not, so the two stay
  distinguishable.

### 5.5 Linking rules — **new** `apps/api/src/auth/services/ever-id-linking.service.ts`

`resolve(claims, txn, bearerUser?)` implements spec §5.3's decision tree exactly and never calls
`UserRepository.findByEmailForSocialAuth` except for the S3 existence check, which returns a boolean and
never an ID to the caller. `confirmSignUp` runs in one transaction: `UserRepository.create`
(`registrationProvider: EVER_ID_REGISTRATION_PROVIDER`, `emailVerified: true`, random bcrypt password as
`validateSocialUser` does), `TermsAcceptanceService.record`, `ExternalIdentityRepository.insertLink`, then
`issueSession(..., origin)`. `canDisconnect(userId)` returns `true` when any of: an `account` row with
`providerId = 'credential'` and a password; another `account` row for a social provider; `users.emailVerified`.

### 5.6 Activity

Additive `ActivityActionType` members `IDENTITY_LINKED = 'identity_linked'`, `IDENTITY_UNLINKED =
'identity_unlinked'`, `USER_LOGOUT = 'user_logout'`, `DELEGATED_ACCESS = 'delegated_access'`,
`IDENTITY_PROVIDER_CONFIG_CHANGED = 'identity_provider_config_changed'` (each value ≤ 50 characters). Rows (spec FR-49), all through `ActivityLogService.log(...).catch(() => {})`:

| `actionType`                       | `action`                          | `metadata` (never tokens, codes, subject)                          | `status`  | `summary` (English; the key is §8's)                              |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- |
| `USER_LOGIN`                       | `user.login.ever-id`              | `{ provider: 'ever-id', identityId, displayName }`                 | COMPLETED | `Signed in with Ever ID` / `signedInWithEverId`                   |
| `USER_SIGNUP`                      | `user.signup.ever-id`             | `{ identityId, displayName }`                                      | COMPLETED | `Created an account with Ever ID` / `signedUpWithEverId`          |
| `USER_LOGIN`                       | `user.login.ever-id.device`       | `{ identityId, clientKind, displayName }`                          | COMPLETED | `Signed in from a terminal with Ever ID` / `signedInFromTerminal` |
| `IDENTITY_LINKED`                  | `auth.ever_id.linked`             | `{ identityId, emailsDiffer: boolean, displayName }`               | COMPLETED | `Connected Ever ID` / `everIdConnected`                           |
| `IDENTITY_UNLINKED`                | `auth.ever_id.unlinked`           | `{ identityId, sessionsEnded, displayName }`                       | COMPLETED | `Disconnected Ever ID` / `everIdDisconnected`                     |
| `USER_LOGOUT`                      | `auth.ever_id.backchannel_logout` | `{ identityId, sessionsEnded, by: 'sid' \| 'sub' }`                | COMPLETED | `Signed out of Ever ID elsewhere` / `signedOutElsewhere`          |
| `DELEGATED_ACCESS`                 | `auth.ever_id.delegated_read`     | `{ identityId, clientId, clientName }` — first per client per 24 h | COMPLETED | `{clientName} read your App Works` / `delegatedRead`              |
| `IDENTITY_PROVIDER_CONFIG_CHANGED` | `auth.ever_id.config_changed`     | `{ fields: string[] }`                                             | COMPLETED | `Ever ID configuration changed` / `configChanged`                 |

**Every row carries `summary` and `status`** because `CreateActivityLogDto` requires both and the web renders the
`summary` it receives rather than deriving one. `displayName` is the identity's display name where the row is about
an identity (FR-49) — never the subject, the issuer or an e-mail the person did not link. Failures use the same
action with `status: FAILED` and a `reason` in metadata: a refused upstream-style outcome
(`auth.ever_id.sign_in_refused` → FAILED), an invalid or replayed notice (`…backchannel_logout` → FAILED), and a
rejected delegated token (`…delegated_read` → FAILED). Per Resolution R-34 every member gets a Live Feed kind in
`packages/agent/src/activity-log/feed-kind.ts` and a `NEVER_PUBLISH` entry in
`packages/agent/src/shared-views/publishable-activity.ts` (App Works rows carry App Work identifiers, so they are
never published to shared views), with the corresponding spec lines updated in T15.

---

## 6. Web

### 6.1 Where it hangs

| File                                                                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/auth/providers.ts`                                                       | read `everId` from `/auth/providers`; default `{ enabled: false }` when absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **new** `apps/web/src/lib/feature-flags/ever-id.ts`                                        | `isEverIdFlagOn(distinctId)` — §6.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **new** `apps/web/src/lib/feature-flags/posthog-client.ts`                                 | the singleton extracted from `work-kinds.ts` (behaviour of `work-kinds.ts` unchanged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/app/actions/auth.ts`                                                         | **new** `startEverIdSignIn(returnTo?)`, `startEverIdConnect()`, `confirmEverIdSignUp(acceptedTerms)`, `confirmEverIdConnect()`, `disconnectEverId(id)`, `getEverIdLogoutUrl()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **new** `apps/web/src/lib/auth/ever-id-cookies.ts`                                         | `ew_everid_txn` (600 s) and `ew_everid_pending` (600 s): HttpOnly, SameSite=Lax, `secure` from the public URL scheme like `cookies.ts`, Path `/`, cleared on every callback and confirm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **new** `apps/web/src/app/api/auth/ever-id/callback/route.ts`                              | the redirect URI; mirrors `handleOAuthCallback`, maps outcomes and codes (§6.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **new** `apps/web/src/components/auth/ever-id-button.tsx`                                  | full-width button above `SocialLoginButtons`, accepts the same `disabled`/`disabledReason` consent gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `(auth)/login/login-client.tsx`, `(auth)/register/register-form.tsx`, their `page.tsx`     | render the button when `everId.enabled && flag`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **new** `apps/web/src/app/[locale]/(auth)/auth/ever-id/create-account/page.tsx` + client   | spec §6.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **new** `apps/web/src/app/[locale]/(auth)/auth/ever-id/account-exists/page.tsx`            | spec S3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **new** `apps/web/src/app/[locale]/(dashboard)/settings/security/connect-ever-id/page.tsx` | spec §6.4 confirmation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **new** `apps/web/src/components/settings/ConnectedIdentitiesCard.tsx`                     | spec §6.3; rendered in `SecuritySettings.tsx` below change-password                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `(auth)/auth/error/auth-error-content.tsx`                                                 | add `ever_id_*` codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `logout()` in `app/actions/auth.ts` and the sign-out dialog that calls it                  | "Also sign out of Ever ID" — the **new** `apps/web/src/components/auth/EverIdSignOutDialog.tsx`, reached from `DashboardSidebar.tsx`'s `handleLogout` (line 127) and `CommandPalette.tsx` (line 192), which today call `logout()` directly. The checkbox appears only when `GET /logout-url` answers `200` for the current session (a `404` means the session was not opened with Ever ID); unticked, the dialog behaves exactly as the menu item does today. Ticked, it follows the URL from that route and stores its `state` in `ew_everid_logout_state`; the end-session call returns to `apps/web/src/app/api/auth/ever-id/logout-return/route.ts`, which validates the state, clears the cookies and shows the S7 copy. |

### 6.2 Redirect URI and return path

Redirect URI = `${WEB_URL}/api/auth/ever-id/callback` built by the API from configuration (FR-10).
`returnTo` is validated on the web tier with the same relative-path rule `isValidRedirectUrl` applies and
again by the API DTO; an absolute URL falls back to `ROUTES.DASHBOARD`. The local-client hand-off route and
`addSessionTokenToUrl` are **not** called anywhere on this path.

### 6.3 Callback outcomes

| API result       | Web action                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signedIn`       | `setAuthCookies(access_token)`; redirect via `getRedirectUrl`                                                                                                                 |
| `confirmSignUp`  | set `ew_everid_pending`; redirect `/auth/ever-id/create-account`                                                                                                              |
| `confirmConnect` | set `ew_everid_pending`; redirect `/settings/security/connect-ever-id`                                                                                                        |
| `emailInUse`     | redirect `/auth/ever-id/account-exists` (set `ew_everid_pending` from the `pending` value of the outcome — the address is read from that sealed cookie, never from the query) |
| error `code`     | redirect `/auth/error?error=ever_id_<snake_code>`; connect-intent errors redirect to Settings with a toast                                                                    |

### 6.4 The `ever-id` flag — fail-closed

`isEverIdFlagOn`: if `POSTHOG_API_KEY` is unset → `true` (configuration alone decides, spec FR-1); otherwise
`posthog.isFeatureEnabled('ever-id', distinctId)` with a 1,500 ms cap, and **only a strict `true` is on** —
errors, timeouts and `undefined` are off. Pages without a signed-in person (sign-in, registration) evaluate
the constant distinct ID `anonymous`, so a staff-only rollout exposes Ever ID through **Settings → Connect**
first and the sign-in button only once the flag is on for `anonymous`. The flag is a UI rollout control; the
API kill switch is the plugin's enablement (§9.2).

**Deliberate difference from APW-01's Work-kind flags (stated, not accidental).** APW-01 T20 makes the Work-kind
flags fail **closed** — a missing PostHog key means off. Ever ID reads a missing `POSTHOG_API_KEY` as
_configuration alone decides_ (on), because an authentication method must not be switched off by an absent
analytics key (spec FR-1). The two helpers therefore stay separate — `ever-id.ts` does not import
`work-kinds.ts`'s policy, only the extracted client singleton — and T21's spec pins both behaviours so a later
"unification" cannot silently change either.

---

## 7. Local clients

- **CLI.** `login.command.ts` gains `--ever-id`. **New** `apps/cli/src/commands/auth/ever-id-device.service.ts`:
  `GET /api/auth/ever-id/client-config` → discovery at `issuer` → `POST device_authorization_endpoint`
  (`client_id` = the `cli` client, scope `openid email ever-works:session`, resource/audience per
  [`idp-options.md`](./idp-options.md)) → print `verification_uri` and `user_code` only → poll the token
  endpoint honouring `interval` (≥ 5 s), `slow_down` (+5 s), `authorization_pending`, `expired_token` (stop,
  ≤ 900 s) → `POST /api/auth/ever-id/session` with the access token in `Authorization` → store the session
  exactly where `oauthLogin` stores it. The access token is dropped from memory after the exchange and is never
  printed; errors pass through the same control-character sanitiser `oauth.service.ts` uses.
  **The device-authorization request, exactly** (the earlier "resource/audience per `idp-options.md`" named a
  parameter that file does not define): `client_id` = the `cli`/`node` public client from `client-config`;
  `scope` = `openid email ever-works:session`; and the audience is carried as the **`audience` parameter only
  when the provider accepts it** — the request table below is the single source, and the `audience` row is
  **conditional on D5**: with D5 answered as _token exchange_ (its recommended default) the device request sends
  no `audience` and the CLI exchanges the resulting token for an `ever-works`-audience token; with D5 answered
  as _multi-audience tokens_ it sends `audience=ever-works` directly. Until D5 is answered, the CLI sends
  `scope` only and the API accepts the resulting token through the same §4.3 exchange rules, so neither answer
  requires a code change in the client — only the presence of one parameter.

    | Device-authorization request parameter | Value                                                    | Depends on |
    | -------------------------------------- | -------------------------------------------------------- | ---------- |
    | `client_id`                            | the `cli` (or `node`) public client id                   | —          |
    | `scope`                                | `openid email ever-works:session`                        | —          |
    | `audience`                             | `ever-works`, **sent only when the provider accepts it** | D5         |
    | `resource`                             | not sent (no RFC 8707 resource indicator is assumed)     | —          |

- **Node.** `PlatformAuthClient.signInWithEverId({ onPrompt })` in `apps/node/src/core/auth-client.ts` with
  the same algorithm, `logger.protect(accessToken)` before anything else, and a `runtime.ts` option beside the
  e-mail/password path.
- Both keep their existing flows unchanged (spec FR-43).

---

## 8. i18n

All keys under [`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json) and added to all 21
locale files in the same PR. Leaf names are camelCase with no literal dot; read the listing as paths through
nested objects.

```
auth.everId.signIn                         "Sign in with Ever ID"
auth.everId.signUp                         "Sign up with Ever ID"
auth.everId.redirecting                    "Opening Ever ID…"
auth.everId.consentRequired                "Accept the terms above to continue."
auth.everId.createAccount.title            "Create your Ever Works account"
auth.everId.createAccount.signedInAs       "Signed in to Ever ID as {name} · {email}"
auth.everId.createAccount.submit           "Create account"
auth.everId.createAccount.cancel           "Cancel"
auth.everId.accountExists.title            "You already have an Ever Works account"
auth.everId.accountExists.body             "An Ever Works account already uses {email}. Sign in to it the way you usually do, then connect Ever ID in Settings → Security."
auth.everId.accountExists.forgotPassword   "Forgot password?"
auth.everId.accountExists.goToSignIn       "Go to sign in"
auth.everId.signedOutByProvider            "You were signed out of Ever ID."
auth.everId.signedOutBoth                  "You're signed out of Ever Works and Ever ID."
auth.everId.alsoSignOut                    "Also sign out of Ever ID"
auth.error.everId.emailNotVerified         "Verify your e-mail address with Ever ID first, then try again."
auth.error.everId.subjectLinked            "This Ever ID is already connected to a different Ever Works account. Disconnect it there first."
auth.error.everId.userHasIssuer            "This account already has an Ever ID connected. Disconnect it first."
auth.error.everId.reauthRequired           "For your security, sign in again before connecting Ever ID."
auth.error.everId.providerUnavailable      "Ever ID isn't responding. Try again in a minute, or sign in another way."
auth.error.everId.transactionInvalid       "That sign-in expired or was already used. Start again."
auth.error.everId.signUpNotAllowed         "New accounts can't be created with Ever ID here. Ask an administrator for an invitation."
auth.error.everId.rateLimited              "Too many attempts. Try again in {seconds} seconds."
dashboard.settings.security.connectedIdentities.title          "Connected identities"
dashboard.settings.security.connectedIdentities.subtitle       "Sign in to Ever Works with an identity you already use."
dashboard.settings.security.connectedIdentities.connectedLine  "{email} · connected {date}"
dashboard.settings.security.connectedIdentities.lastUsed       "Last used to sign in {ago}"
dashboard.settings.security.connectedIdentities.notConnected   "Not connected"
dashboard.settings.security.connectedIdentities.connect        "Connect Ever ID"
dashboard.settings.security.connectedIdentities.disconnect     "Disconnect"
dashboard.settings.security.connectedIdentities.cannotDisconnect "Add another way to sign in first — Ever ID is the only one this account has."
dashboard.settings.security.connectedIdentities.setPassword    "Set a password"
dashboard.settings.security.connectedIdentities.turnedOff      "Signing in with Ever ID is turned off on this installation."
dashboard.settings.security.connectedIdentities.appsTitle      "Apps that can see your App Works"
dashboard.settings.security.connectedIdentities.appLastUsed    "{app} — last used {ago}"
dashboard.settings.security.connectedIdentities.manageInEverId "Manage in Ever ID"
dashboard.settings.security.connectedIdentities.confirmTitle   "Connect Ever ID to this account?"
dashboard.settings.security.connectedIdentities.emailsDiffer   "These e-mail addresses are different. Connect only if both are yours."
dashboard.settings.security.connectedIdentities.confirmBody    "You'll be able to sign in to this account with Ever ID."
dashboard.settings.security.connectedIdentities.confirm        "Connect"
dashboard.settings.security.connectedIdentities.disconnectBody "Disconnect Ever ID? You won't be able to sign in with it any more, and other devices signed in with Ever ID will be signed out. This device stays signed in."
dashboard.settings.security.connectedIdentities.keep           "Keep it"
dashboard.settings.security.connectedIdentities.connectedToast "Ever ID connected."
dashboard.settings.security.connectedIdentities.disconnectedToast "Ever ID disconnected."
```

**The list above is complete**, and the four groups below were missing from it (audit, 2026-09-17) — they are
required by the spec copy and by tasks that test them, so they belong here rather than being invented in a
component:

```
# Sign-out dialog (spec §6.5) — the dialog T26 creates
dashboard.signOut.title                      "Sign out of Ever Works?"
dashboard.signOut.alsoSignOutEverId          "Also sign out of Ever ID"
dashboard.signOut.cancel                     "Cancel"
dashboard.signOut.confirm                    "Sign out"
# Registration consent (spec §6.2) — the checkbox on both the register page and the create-account screen
auth.everId.termsCheckbox                    "I agree to the Terms of Service and Privacy Policy"
# The pending-cookie expiry copy T25 tests
auth.everId.pendingExpired                   "That took too long. Start again."
# Account-exists / disabled states
auth.error.everId.accountDisabled            "This account is disabled. Contact an administrator."
auth.error.everId.everIdDisabled             "Signing in with Ever ID isn't available here."
auth.error.everId.sessionRequired            "Sign in with your password to do that."
auth.error.everId.notConnected               "Connect Ever ID in Settings → Security first."
auth.error.everId.lastSignInMethod           "Add another way to sign in first — Ever ID is the only one this account has."
auth.error.everId.tokenInQuery               "That link isn't valid. Start again from the app."
auth.error.everId.insufficientScope          "That app doesn't have permission to see this."
auth.error.everId.signedOutByProvider        "You were signed out of Ever ID."
# S7 return route
auth.everId.signedOutBoth                    "You're signed out of Ever Works and Ever ID."
# Administrator surface (spec §6.7) — one label per FR-3 check id, plus Health
dashboard.settings.admin.everId.title        "Ever ID"
dashboard.settings.admin.everId.testConnection "Test connection"
dashboard.settings.admin.everId.check.discovery          "Discovery document"
dashboard.settings.admin.everId.check.issuerMatch        "Issuer matches"
dashboard.settings.admin.everId.check.endpoints          "Endpoints reachable"
dashboard.settings.admin.everId.check.pkceS256           "S256 code challenge supported"
dashboard.settings.admin.everId.check.signingAlg         "Signing algorithm"
dashboard.settings.admin.everId.check.backchannelLogout  "Back-channel logout"
dashboard.settings.admin.everId.check.deviceAuthorization "Device authorization"
dashboard.settings.admin.everId.checkOk                  "Works"
dashboard.settings.admin.everId.checkFailed              "Not supported"
dashboard.settings.admin.everId.health.title             "Health"
dashboard.settings.admin.everId.health.discovery         "Last discovery refresh {ago}"
dashboard.settings.admin.everId.health.jwks              "Last key refresh {ago}"
dashboard.settings.admin.everId.health.logoutNotice      "Last sign-out notice {ago}"
dashboard.settings.admin.everId.secretSet                "•••••• (set)"
```

The CLI and node strings live in their own sources (they are not web-localised today). A lint-style unit
test asserts no new key's English value contains "SSO" or "single sign-on" (spec copy rule).

---

## 9. Telemetry and failure modes

### 9.1 Events (PostHog through the existing monitoring package — counters and IDs only)

| Event                                   | Properties                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `ever_id.sign_in.started`               | `{ intent: 'sign-in' \| 'connect' }`                                        |
| `ever_id.sign_in.completed`             | `{ outcome, durationMs }` — `outcome` is the callback outcome or error code |
| `ever_id.sign_up.confirmed`             | `{}`                                                                        |
| `ever_id.identity.linked` / `.unlinked` | `{ emailsDiffer?, sessionsEnded? }`                                         |
| `ever_id.backchannel.received`          | `{ result: 'ended' \| 'unknown' \| 'invalid', sessionsEnded }`              |
| `ever_id.device.exchanged`              | `{ clientKind, result }`                                                    |
| `ever_id.delegated.read`                | `{ result: 'ok' \| 'insufficientScope' \| 'rejected' }` (sampled 1 in 10)   |
| `ever_id.provider.unavailable`          | `{ stage: 'discovery' \| 'jwks' \| 'token' }`                               |
| `ever_id.provider.recovered`            | `{ unavailableForSeconds, by: 'test-connection' \| 'scheduled' }`           |

No event carries an e-mail, subject, issuer URL, client secret, token, code or `state`.

### 9.2 Failure modes and the chosen behaviour

| Failure                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ever ID down at sign-in                                    | `503 providerUnavailable`, S16 copy, other methods untouched                                                                                                                                                                                                                                                                                                                       | An external dependency must never block password or social sign-in.                                                                                                              |
| Ever ID down during a sign-out notice                      | Not applicable — the notice arrives _from_ Ever ID; keys come from cache (≤ 21,600 s)                                                                                                                                                                                                                                                                                              | Honouring logouts must not depend on a fresh key fetch.                                                                                                                          |
| JWKS stale beyond 21,600 s                                 | Every validation fails closed; delegated reads 401; sessions already open keep working                                                                                                                                                                                                                                                                                             | Bounded trust in unrefreshable keys.                                                                                                                                             |
| Admin disables the plugin                                  | Sign-in family 404; `/identities`, `DELETE`, `/backchannel-logout` keep working                                                                                                                                                                                                                                                                                                    | People can always leave; logouts are always honoured (spec FR-5).                                                                                                                |
| Only Ever ID remains and the plugin is disabled            | The account e-mail is verified (sign-up requires it), so password reset still works                                                                                                                                                                                                                                                                                                | FR-28 guarantees a path; documented in the admin help text.                                                                                                                      |
| Flag bypassed by calling the API directly                  | Allowed: the API gates on configuration, the flag gates UI rollout                                                                                                                                                                                                                                                                                                                 | The flag is not a security boundary; the plugin toggle is the kill switch.                                                                                                       |
| Two replicas validate the same `jti` concurrently          | The unique index on `verification.value` lets exactly one insert win                                                                                                                                                                                                                                                                                                               | Cross-replica replay protection without a new store.                                                                                                                             |
| Unique violation on `(issuer, subject)` at sign-up/connect | `409 subjectLinked`; the pending value is consumed                                                                                                                                                                                                                                                                                                                                 | Decides the S24 race in the database.                                                                                                                                            |
| Sealed cookie over 4 KB                                    | Impossible by construction (payload capped at 3,072 bytes; `returnTo` ≤ 2,048)                                                                                                                                                                                                                                                                                                     | A silently dropped cookie would look like S17 forever.                                                                                                                           |
| Issuer changes at the provider                             | Discovery refresh marks the plugin unavailable until an admin re-tests; allow-list permits 2–3 issuers during a planned move                                                                                                                                                                                                                                                       | Mix-up and silent retargeting defence; supports a provider migration (idp-options §5).                                                                                           |
| Availability differs per replica                           | Impossible by construction: `unavailableSince` and the three health timestamps live in the plugin's **persisted settings** (`availability`, §4.2), read through a cache of at most `EVER_ID_LIMITS.availabilityCacheSeconds`, so a re-test on one replica clears the flag on every replica within 60 s (FR-5) and `GET /admin/health` returns the same three timestamps everywhere | Plugin availability today is per-process registry state (`packages/agent/src/facades/oauth.facade.ts`); sign-in must not behave differently depending on which replica answered. |

---

## 10. Test plan

Per Constitution VI. None of these files exists yet.

### 10.1 Plugin (Vitest, `packages/plugins/oidc-identity/src/__tests__/`)

- `authorization-request.spec.ts` — S256, 32-byte `state`/`nonce`, 64-char verifier, exact redirect URI, `prompt=login` + `max_age=300` for connect.
- `id-token.spec.ts` — a local key pair and an in-memory discovery document: every FR-11 rejection (issuer, audience, `azp`, `none`, `HS256`, `exp`, `iat` future/old, nonce, empty `sub`), skew edges at ±60 s.
- `jwks-cache.spec.ts` — 600 s cache, unknown `kid` refetch with 30 s cooldown, stale use up to 21,600 s then fail closed, rotation and removal.
- `access-token.spec.ts` — delegated and exchange rules of §4.3 including `lifetimeTooLong` and `badAuthorizedParty`.
- `logout-token.spec.ts` — event claim, `nonce` present, missing `sid`/`sub`, `iat` age.
- `test-connection.spec.ts` — each `IdentityProviderCheck`, 5 s timeout, secret never in output.

### 10.2 Agent package (Jest)

- `packages/agent/src/entities/__tests__/external-identity.entity.spec.ts` — index names, Tier B columns.
- `packages/agent/src/database/repositories/__tests__/external-identity.repository.spec.ts` — both uniqueness conflicts mapped to reasons, delegated client list capped at 10.
- `packages/agent/src/facades/__tests__/identity-provider.facade.spec.ts` — admin-tier-only resolution, unavailable errors.

### 10.3 API (Jest, `apps/api`)

- `apps/api/src/auth/controllers/ever-id.controller.spec.ts` — every row of §5.1 and §5.2, throttle metadata, `tokenInQuery`.
- `apps/api/src/auth/services/ever-id-linking.service.spec.ts` — the §5.3 spec decision tree as a table test; S3 never returns an ID; `canDisconnect` truth table.
- `apps/api/src/auth/services/ever-id-seal.service.spec.ts` — tamper, wrong kind, expiry, size cap.
- `apps/api/src/auth/services/ever-id-replay.service.spec.ts` — single use, expired cleanup ≤ 100 rows.
- `apps/api/src/auth/services/ever-id-session.service.spec.ts` — `sid`, `sub`, except-current, password sessions untouched.
- `apps/api/src/auth/guards/auth-session.guard.delegated.spec.ts` — metadata gate, dot-regex discriminator, 401 without metadata, 403 missing scope, `authMethod` on all branches; a delegated principal on a `@HumanOnly()` handler is refused by the unchanged `HumanActorGuard` (R-19).
- `apps/api/src/auth/services/ever-id-activity.spec.ts` — drives the eight FR-49 rows through the services with a capturing `ActivityLogService`; the set of `action` values equals §5.6's table and no serialised row contains a planted token, code, subject or `state` (ACC-12-37).
- `apps/api/src/auth/services/ever-id-telemetry.spec.ts` — every §9.1 event payload built by the services carries no e-mail, subject, issuer URL, token, code or `state`.
- `apps/api/src/auth/ever-id.flow.integration.spec.ts` — **replaces the former `apps/api/test/ever-id.e2e-spec.ts` (Resolution R-22)**. A Nest testing module with `TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', entities: ENTITIES, synchronize: true })` (precedent `apps/api/src/ingest/github/github-check-intake.autoresume.integration.spec.ts`), the real `EverIdController`, services and `AuthSessionGuard`, the fake provider of §10.4 and `supertest`: a connected identity signs in and Activity holds `user.login.ever-id` (ACC-12-13); sign-up confirm with terms creates the account, the connection and a session (ACC-12-14); `POST /session` with a freshly minted exchange token returns a `TokenResponse` in the body in < 5 s and no captured log line contains the token (ACC-12-28); a test controller carrying `@DelegatedRead('apps:read')` returns the person's App Works for an `apps:read` token (ACC-12-33).

### 10.4 Playwright (`apps/web/e2e/`)

A **new** `packages/plugins/oidc-identity/src/testing/fake-oidc-provider.ts` — published only through a
`./testing` subpath export, never from the main entry, so the API integration spec and Playwright share one fake —
starts a local HTTP server on a free port with discovery, JWKS (ES256 via `node:crypto`), authorize
(auto-approve a configured user), token (PKCE checked), device authorization, end-session, and helpers to
rotate keys, mint access tokens and post a signed back-channel logout token.

| File                                 | Golden path                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `ever-id-sign-in.spec.ts`            | connected user signs in (S1); replayed callback (S17); `returnTo` to another site falls back |
| `ever-id-sign-up.spec.ts`            | S2 with terms; S3; S11                                                                       |
| `ever-id-connect.spec.ts`            | S4 incl. differing e-mails; S12; S13; S15 (session aged in DB); disconnect S5; S14           |
| `ever-id-backchannel-logout.spec.ts` | S6: two Ever ID sessions end, password session survives; replayed `jti` 400                  |
| `ever-id-disabled.spec.ts`           | S18 and ACC-12-01/04; existing auth specs unchanged                                          |
| `ever-id-a11y.spec.ts`               | axe over button, both confirmation screens, card and dialogs                                 |

Existing specs that must pass untouched: `auth.spec.ts`, `auth-providers-list.spec.ts`,
`auth-clock-tolerance.spec.ts`, `device-auth.spec.ts`.

### 10.5 Web unit (Vitest) and clients

`ever-id-button.unit.spec.tsx`, `ConnectedIdentitiesCard.unit.spec.tsx`, `ever-id.flag.unit.spec.ts`
(fail-closed truth table), `callback/route.unit.spec.ts` (outcome mapping, cookie cleared on every path),
`apps/web/src/lib/auth/ever-id-copy.unit.spec.ts` (every §8 key in all 21 locales, no dotted leaf, no "SSO").
CLI: `apps/cli/src/commands/auth/ever-id-device.service.spec.ts` (interval, `slow_down`, expiry, no token
printed) and `apps/cli/src/commands/auth/__tests__/login.command.browser-flow.spec.ts` — a characterisation spec
written **before** `login.command.ts` changes, pinning that `login` without `--ever-id` still runs the loopback
browser hand-off of `oauth.service.ts` (port 44663, `sessionToken` accepted, `--manual` unchanged) and never calls the
device service (ACC-12-32). Node: extend `apps/node/src/core/auth-client.spec.ts` (`protect` before use).

### 10.6 Other repositories (tracked there, gate ACC-12-40)

Test files for [`cross-platform.md`](./cross-platform.md) §7 live in `ever-co/ever-teams` (Jest `*.test.ts(x)` beside
the source; Cypress in `apps/web/cypress/e2e/`) and `ever-co/ever-gauzy` (Jest `*.spec.ts` beside the source;
Playwright in `apps/gauzy-e2e/tests/`). Each XP id's file is named in cross-platform §7; each repository uses its own
local fake OpenID Connect provider (this monorepo's `./testing` export is not a dependency of either).

---

## 11. Phasing

### P0 — Decision gate (no code in this repository)

Owner decisions in [`idp-options.md`](./idp-options.md) §6; the identity provider stood up with three
environments in the private operations repository; clients registered (web confidential client per
environment, `cli` and `node` public clients with device grant, audience `ever-works`, scopes `apps:read`
and `ever-works:session`, back-channel logout URI).

### P1 — Ever Works relying party (spec FR-1…FR-53)

Contracts, plugin, facade, entity + migrations, controller, guard branch, linking, sessions, sign-out
notices, delegated read verification, CLI/node device sign-in, web button, screens and card, i18n, flag,
Activity, telemetry, tests. **Ships value alone**: Ever Works accepts Ever ID; APW-11 P2 can verify tokens.
Rollout: dev → stage → production with the plugin disabled, then enabled for staff through the flag, then
general.

### P2 — Ever Teams (spec FR-54…FR-58; [`cross-platform.md`](./cross-platform.md) §4)

Work lands in `ever-co/ever-teams` and, server-side only and default-off, in `ever-co/ever-gauzy`'s API.

### P3 — Ever Gauzy (cross-platform.md §5)

Gauzy web sign-in, workspace picker, MCP authorization server login, production flag last.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** The identity provider integration is a plugin package with its own settings
      schema; the OIDC libraries are dependencies of that package only.
- [x] **II — Capability-driven.** Callers ask `IdentityProviderFacadeService` for `identity-provider`; no
      plugin ID in core. **Declared deviation:** the settings cascade collapses to the admin tier because
      sign-in precedes any user or Work; per-user identity providers would be a security defect.
- [x] **III — Source-of-truth repositories.** Identity metadata is platform metadata, not Work content.
- [x] **IV — Job runtime.** No background job is needed: sign-out notices are synchronous deletes bounded
      at 5 s; key refresh is lazy with caching; replay cleanup is opportunistic.
- [x] **V — Forward-only migrations.** Two additive migrations in block `179212`, `down()` drops only
      what `up()` created, no backfill.
- [x] **VI — Tests first.** Six plugin specs, three agent specs, nine API specs plus one integration spec, six
      Playwright specs, five web unit specs, CLI and node specs (§10); nothing under `apps/api/test/` (R-22); the
      other repositories' tests are named in cross-platform §7.
- [x] **VII — Secrets.** Client secret `x-secret`; no Ever ID token stored; tokens only in headers or form
      bodies; query tokens refused before logging; Activity and telemetry carry no token, code or subject.
- [x] **VIII — Plugin counts.** `docs/plugin-system/built-in-plugins.md` gains the new plugin (tasks T33).
- [x] **IX — Behaviour-first spec.** Every identifier lives here, not in `spec.md`.
- [x] **X — Backwards compatibility.** One optional field on `/auth/providers`, one optional argument on
      `issueSession`, one more value in the existing `AuthenticatedUser.authMethod` union, two nullable columns; every existing route
      and response unchanged.
- [x] **Program rule #1 — additive.** The local-client hand-off, the social providers and their e-mail
      linking are untouched.
- [x] **Program rule #10 — public-repository hygiene.** No hostnames, addresses or infrastructure detail; the
      provider's placement lives in the private operations repository.
- [x] **Program audit resolutions.** R-1 (§3.5), R-2 (§5.6), R-19 (§2.1, §5.3), R-22 (§10.3).

### Known gaps carried forward, not silently absorbed

- The existing social providers keep their e-mail-based account resolution; this epic does not change them
  (additive rule).
- The flag is not an API boundary (§9.2); the plugin toggle is.
- Delegated reads use the first-party consent default of spec §9 until the owner decides.
- A provider migration changes `sub` values unless the new provider imports users with preserved IDs;
  [`idp-options.md`](./idp-options.md) §5 makes that a selection criterion.

---

## 13. Security and permissions (added 2026-09-17)

Every route this epic adds, with who may call it, the guard that enforces it, and the validating DTO. The
**human-only** column is [CONTRACTS](../CONTRACTS.md) §4's rule (Resolution R-32) — API keys, Fleet run tokens
and Ever ID delegated tokens are refused with `403` and the unchanged non-human-actor body.

| Route                                | Auth                                                  | Human-only | Throttle            | Validating DTO                          | Secret fields                          |
| ------------------------------------ | ----------------------------------------------------- | ---------- | ------------------- | --------------------------------------- | -------------------------------------- |
| `GET /api/auth/providers` (existing) | public                                                | no         | existing            | —                                       | none                                   |
| `POST /authorize`                    | public                                                | no         | 20 / 60 s / IP      | `EverIdAuthorizeDto`                    | none                                   |
| `POST /callback`                     | public (+ bearer read for connect)                    | no         | 20 / 60 s / IP      | `EverIdCallbackDto`                     | `transaction`, `pending` sealed        |
| `POST /sign-up/confirm`              | public                                                | no         | 10 / 60 s / IP      | `EverIdSignUpConfirmDto` (terms claims) | `pending` sealed                       |
| `POST /connect/authorize`            | session only (`SessionOnlyGuard`)                     | **yes**    | 10 / 60 s / user    | `EverIdAuthorizeDto`                    | none                                   |
| `POST /connect/confirm`              | session only                                          | **yes**    | 10 / 60 s / user    | `EverIdConfirmDto`                      | `pending` sealed                       |
| `GET /identities`                    | session only                                          | no         | default             | —                                       | none                                   |
| `DELETE /identities/:id`             | session only                                          | **yes**    | 10 / 3,600 s / user | `EverIdDeleteIdentityDto`               | none                                   |
| `GET /logout-url`                    | session                                               | no         | 10 / 60 s / user    | —                                       | none                                   |
| `POST /backchannel-logout`           | public, form-encoded                                  | no         | 60 / 60 s / IP      | `LogoutTokenForm`                       | `logout_token` in the body only        |
| `POST /session`                      | public, bearer Ever ID token                          | no         | 10 / 60 s / IP      | `EverIdSessionExchangeDto`              | token in the header only               |
| `GET /client-config`                 | public                                                | no         | 30 / 60 s / IP      | —                                       | none (by contract)                     |
| `POST /admin/test`                   | `IsPlatformAdminGuard`                                | **yes**    | 10 / 60 s / user    | —                                       | reads `clientSecret`, returns no value |
| `GET /admin/health`                  | `IsPlatformAdminGuard`                                | no         | default             | —                                       | none                                   |
| Plugin settings save (`ever-id`)     | platform admin via the existing plugin-settings route | **yes**    | existing            | `OidcIdentitySettingsSchema`            | `clientSecret` (`x-secret`)            |

**New public endpoints and why**: `/authorize`, `/callback`, `/sign-up/confirm`, `/session`,
`/client-config` and `/backchannel-logout` must work before any session exists (that is what sign-in and the
provider's notice are). Each is throttled, validates a DTO, carries no scope, and returns no secret;
`/client-config` is the only one a third party may read freely, and it exposes exactly the issuer, the public
client ids and the scope names. **New scopes/roles**: no new platform role; the only new scope is the
provider-side `apps:read` (delegated read, R-19) and `ever-works:session` (terminal exchange). **No new
`@Public` route exists beyond the table above.** The delegated branch is admitted only on handlers carrying
`@DelegatedRead(scope)` and is refused by the unchanged `HumanActorGuard` everywhere else.

## 14. Risks and mitigations (added 2026-09-17)

| Risk                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                                           | Threat row |
| ----------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| The provider is a new single dependency for every platform's sign-in    | medium     | high   | It is an **addition**: every existing method keeps working, the plugin fails closed, and an unavailable provider answers `503` with copy rather than blocking password or social sign-in (spec §9.2) | T-24, B-7  |
| Issuer mix-up or a silent retargeting of the provider                   | low        | high   | Exact issuer match against discovery, a 1–3 issuer allow-list, and issuer drift marking the plugin unavailable (FR-14)                                                                               | T-24       |
| A delegated token is replayed or over-scoped                            | low        | high   | Single-use `jti` replay store, ≤ 3,600 s lifetime, audience and scope checks, `@DelegatedRead` only where declared (R-19)                                                                            | T-24, T-25 |
| Sign-up creates an orphan account when the link insert loses the race   | medium     | medium | Explicit ordering with compensation, plus the unique index deciding the race (spec S24, T15)                                                                                                         | —          |
| The provider's configuration drifts between replicas                    | medium     | medium | Availability and health timestamps are persisted and read through a ≤ 60 s cache (§4.2, §9.2)                                                                                                        | —          |
| A secret or token leaks into a log, Activity row or telemetry payload   | medium     | high   | Field allow-lists, `x-secret`, no token in any URL, redaction covered by T20/T32/T45 tests (ACC-12-37)                                                                                               | T-32, T-33 |
| The Keycloak relocation breaks a self-hoster's configuration            | low        | medium | Relocation only, behaviour unchanged, same exports and defaults, existing tests unchanged (R-28, `cross-platform.md` §5.1)                                                                           | —          |
| Sign-out notices are missed while the platform is briefly unavailable   | low        | medium | The notice endpoint depends on cached keys (≤ 21,600 s), not on a fresh fetch, so it keeps working through an outage (spec §9.2)                                                                     | B-7        |
| A member's GitHub or provider connection is used beyond their authority | low        | high   | Background work uses the owner's connection, member-initiated work the member's own, and a platform credential is never substituted (CONTRACTS §11)                                                  | T-35       |
