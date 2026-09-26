# Ever ID — adoption by Ever Teams and Ever Gauzy

**Epic**: [`APW-12-ever-id`](./spec.md) · **Phases**: P2 (Ever Teams) · P3 (Ever Gauzy)
**Status**: `Draft` · **Created**: 2026-09-17
**Verified against**: `ever-co/ever-gauzy` and `ever-co/ever-teams`, branch `develop`, read on 2026-09-17
through the GitHub contents API. Paths drift; re-open each one before its task starts.

> Work described here lands in **other repositories**. This file is the contract those pull requests
> implement; each repository keeps its own tests and migrations. Nothing here removes or renames an existing
> sign-in method, route, entity or flag in either product, and Ever Gauzy production changes last, behind
> default-off flags, with every existing sign-in kept.

---

## 1. Principles (binding for P2 and P3)

1. **Additive.** Ever ID is one more sign-in method. Email and password, magic code, Google, GitHub,
   Facebook, Twitter, Microsoft, LinkedIn, Auth0 and Keycloak stay exactly as they are. **ZITADEL is an
   addition, never a replacement** — each platform keeps its own authentication and its own user database, and
   profile data stays local (owner constraint, 2026-09-17; [`idp-options.md`](./idp-options.md) §7).
2. **Order.** Ever Works (P1) → Ever Teams (P2) → Ever Gauzy production (P3, last).
3. **Generic OpenID Connect only.** Each platform integrates against the standard discovery document, not a
   vendor library, so the identity provider stays replaceable ([`idp-options.md`](./idp-options.md)).
4. **Default-off, fail-closed flags.** A missing or malformed flag value means off.
5. **No token in a URL** on any Ever ID path. The existing social redirects that hand a result to the web app
   in the address are kept but **must not be extended**; the Ever ID path uses a one-time hand-off code
   redeemed by `POST` (§5.1).
6. **Explicit linking only** (§2). No platform links an Ever ID to an account because e-mail addresses match.
7. **Sign-out notices honoured** by every platform for the sessions or tokens it issued through Ever ID.
8. **Same numbers as Ever Works** ([`plan.md`](./plan.md) §4.3): S256 PKCE; 32-byte `state` and `nonce`;
   60 s clock skew; key cache 600 s with a 30 s unknown-key cooldown and 21,600 s maximum staleness; 5 s
   outbound timeout; connect requires `auth_time` ≤ 300 s and `email_verified`; logout tokens ≤ 300 s old
   with a 600 s `jti` replay window.

## 2. The account-linking model

Ever ID owns the **person** (one `sub` per issuer). Each platform owns **its own link table** keyed by
(issuer, subject) and decides which of its accounts that pair may enter. No platform reads another
platform's link table.

| Platform   | Where accounts live                                                      | Cardinality of a pair                                    | Link table                        | Account selection after Ever ID sign-in                                         |
| ---------- | ------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| Ever Works | one account per person                                                   | ≤ 1 account; ≤ 1 pair per account per issuer             | `external_identities` (plan §3.1) | the linked account                                                              |
| Ever Gauzy | one user per workspace (tenant); one e-mail can exist in many workspaces | ≤ 1 user **per workspace**; ≤ 1 pair per user per issuer | new `external_identity` (§4.1)    | the existing workspace picker, listing **only** workspaces whose user is linked |
| Ever Teams | none of its own — every Teams account is a Gauzy user                    | inherits Gauzy's                                         | Gauzy's `external_identity`       | Gauzy's picker result, as Teams uses today                                      |

```
                      Ever ID  (iss, sub = "u-81f…")
                 ┌──────────────┼───────────────────────────┐
                 ▼              ▼                           ▼
  Ever Works account     Gauzy user @ workspace A    Gauzy user @ workspace B     (Teams reads these)
  (1 row)                (1 row, tenant A)           (1 row, tenant B)
```

**Rules applied identically everywhere:**

1. A link is created only by a person who is **already signed in** to that platform account, after a fresh
   Ever ID authentication (`auth_time` ≤ 300 s), with `email_verified: true`, and after confirming a screen
   that shows both e-mail addresses.
2. Signing in with an unlinked Ever ID never selects an account by e-mail. Ever Works may offer account
   creation (spec FR-23); Ever Teams and Ever Gauzy do **not** create accounts from Ever ID in P2/P3 — the
   person signs in the usual way and connects (open question §8).
3. Unlinking keeps a working sign-in method (a password, another social account, or a verified e-mail that
   can receive a reset or magic code). On Gauzy the rule is evaluated per user row.
4. Unique constraints decide races: (issuer, subject[, tenant]) and (user, issuer).
5. The existing e-mail-matching social flows (Gauzy's workspace sign-in by social e-mail, Teams'
   `GauzyAdapter` social path) are **not** used for `ever-id` and are not changed.

## 3. What ships today (the integration points)

### 3.1 Ever Gauzy

| Area                     | Path                                                                                                                                       | Relevant behaviour today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy registry        | `packages/auth/src/lib/internal.ts`                                                                                                        | `Strategies` (Auth0, Facebook, Fiverr, GitHub, Google, Keycloak, LinkedIn, Microsoft, Twitter), `Controllers` (no Keycloak controller), `AuthGuards` (Microsoft, Keycloak).                                                                                                                                                                                                                                                                                                                                      |
| Module                   | `packages/auth/src/lib/social-auth.module.ts`                                                                                              | Registers strategies, guards, controllers; `SocialAuthService` is replaced by core's `AuthService` via `registerAsync`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Base service             | `packages/auth/src/lib/social-auth.service.ts`                                                                                             | `validateOAuthLoginEmail` contract; `routeRedirect` builds the web redirect after a social callback; OAuth-app registry types.                                                                                                                                                                                                                                                                                                                                                                                   |
| Keycloak                 | `packages/auth/src/lib/keycloak/keycloak.strategy.ts`, `keycloak-auth-guard.ts`                                                            | `passport-keycloak-oauth2-oidc`, realm-specific config, `'disabled'` placeholders when unconfigured. **Dormant: no controller, so no route** — and it cannot be pointed at ZITADEL, because that library hard-codes `{authServerURL}/realms/{realm}/protocol/openid-connect/*` (`idp-options.md` §7.1). **Relocated, behaviour unchanged** into the `keycloak` provider plugin (§5.1 family) — every strategy, guard, export and `'disabled'` default keeps working, so nothing a self-hoster relies on changes. |
| Auth0                    | `packages/auth/src/lib/auth0/auth0.strategy.ts`, `auth0.controller.ts`                                                                     | `passport-auth0`; callback → `validateOAuthLoginEmail(user.emails)` → `routeRedirect`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Social pattern           | `packages/auth/src/lib/google/google.controller.ts`                                                                                        | `@UseGuards(FeatureFlagEnabledGuard, AuthGuard('google'))` + `@FeatureFlag(FeatureEnum.FEATURE_GOOGLE_LOGIN)`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Feature flags            | `packages/contracts/src/lib/feature.model.ts`, `packages/common/src/lib/guards/feature-flag-enabled.guard.ts`                              | `FEATURE_*_LOGIN` members; `featureEnabled()` returns **true unless** the variable is `'false'` (fail-open — Ever ID must not use it).                                                                                                                                                                                                                                                                                                                                                                           |
| Gauzy as OAuth server    | `packages/auth/src/lib/oauth-app/oauth-app.controller.ts`                                                                                  | `/integration/ever-gauzy/oauth/{authorize,token}` for third-party integrations: `oauth_clients` registry, exact redirect match, consent page. No ID token or discovery. **Unrelated to Ever ID and unchanged.**                                                                                                                                                                                                                                                                                                  |
| MCP authorization server | `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.ts`, `packages/auth/src/lib/mcp/server/oauth-authorization-server.ts`                       | OAuth 2.x server for MCP clients (PKCE, dynamic client registration, introspection, userinfo, JWKS); `/oauth2/login` authenticates with e-mail and password via `userAuthenticator`.                                                                                                                                                                                                                                                                                                                             |
| Core sign-in             | `packages/core/src/lib/auth/auth.controller.ts`, `auth.service.ts`                                                                         | `POST /auth/signin.email.social` → `signinWorkspacesByEmailSocial` (verifies a provider token, finds users **by e-mail**, returns workspaces); `POST /auth/signin.workspace`; `GET /auth/workspaces`; `POST /auth/switch-workspace`; `POST /auth/logout`. `verifyOAuthToken` supports Google, GitHub, Twitter, Facebook.                                                                                                                                                                                         |
| Social accounts          | `packages/core/src/lib/auth/social-account/social-account.entity.ts`                                                                       | `social_account`: `provider: ProviderEnum`, `providerAccountId`, `userId`, tenant columns. No issuer.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Token revocation         | `packages/core/src/lib/access-token/`, `packages/core/src/lib/refresh-token/` (used by `AuthService.logout`)                               | `AccessTokenService.revoke` / `RefreshTokenService.revoke` with metadata types `IAccessTokenMetadata` / `IRefreshTokenMetadata`.                                                                                                                                                                                                                                                                                                                                                                                 |
| Web sign-in UI           | `packages/ui-auth/src/lib/components/social-links/social-links.component.ts`, `workspace-selection/`, `auth.routes.ts`, `sign-in-success/` | Social buttons from app config; workspace picker; routes `login`, `oauth-authorize`, `logout`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Profile UI               | `packages/ui-core/shared/src/lib/user/edit-profile-form/edit-profile-form.component.ts`                                                    | The user's own profile form — host for a "Connected identities" section.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Migrations               | `packages/core/src/lib/database/migrations/`                                                                                               | Forward-only migrations for both ORMs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.2 Ever Teams

| Area           | Path                                                      | Relevant behaviour today                                                                                                                                                                       |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth.js config | `apps/web/auth.ts`                                        | `session: { strategy: 'jwt' }`; `signIn` and `jwt` callbacks send the provider's `access_token` to Gauzy (`signInCallback`, `jwtCallback`) and keep Gauzy tokens in `token.authCookie`.        |
| Adapter        | `apps/web/core/services/server/requests/o-auth.ts`        | `GauzyAdapter`: `createUser` registers a Gauzy user + tenant + organization + employee + team; `getUserByAccount` asks Gauzy by provider account; `linkAccount` → Gauzy `signup.link.account`. |
| Providers      | `apps/web/core/lib/utils/check-provider-env-vars.ts`      | Nine Auth.js providers; `filteredProviders` shows one only when advertised (`NEXT_PUBLIC_<X>_APP_NAME`) **and** configured (client ID).                                                        |
| Provider enum  | `apps/web/core/types/generics/enums/social-accounts.ts`   | `EProvider`: github, google, facebook, twitter.                                                                                                                                                |
| Gauzy requests | `apps/web/core/services/server/requests/auth.ts`          | `signWithSocialLoginsRequest` → `/auth/signin.email.social`; `/auth/signin.workspace`; `/auth/refresh-token`.                                                                                  |
| Buttons        | `apps/web/core/components/auth/social-logins-buttons.tsx` | Renders `mappedProviders` with icons; hidden in demo mode.                                                                                                                                     |
| Settings       | `apps/web/app/[locale]/(main)/settings/personal/page.tsx` | Personal settings — host for "Connected identities".                                                                                                                                           |

## 4. Ever Teams adoption (P2)

Teams accounts are Gauzy users, so P2 needs a **server-only, default-off** slice of Gauzy's API first. It
adds no Gauzy UI and has no effect unless a Teams user chooses Ever ID.

### 4.1 Gauzy API slice (in `ever-co/ever-gauzy`)

- **Flag.** `FEATURE_EVER_ID_API` in `FeatureEnum` and `IAuthenticationFlagFeatures`; in `flagFeatures`
  evaluated as `process.env.FEATURE_EVER_ID_API === 'true'` (**not** `featureEnabled`).
- **Entity.** New `packages/core/src/lib/auth/external-identity/` mirroring `social-account/` (entity,
  module, service, TypeORM and MikroORM repositories): `ExternalIdentity extends TenantBaseEntity`, table
  `external_identity`, columns `issuer varchar(512)`, `subject varchar(255)`, `userId`, `emailAtLink`,
  `linkedAt`, `lastLoginAt`; unique `(issuer, subject, tenantId)` and `(userId, issuer)`. One forward-only
  migration in `packages/core/src/lib/database/migrations/`. `ProviderEnum` and `social_account` untouched.
- **Verification.** New `external-identity/ever-id-token.service.ts`: generic discovery + JWKS validation with
  `jose`; configuration `EVER_ID_ISSUERS` (1–3 exact strings), `EVER_ID_GAUZY_AUDIENCE` (default `gauzy`),
  `EVER_ID_TRUSTED_CLIENT_IDS` (the Ever Teams and, in P3, Ever Gauzy client IDs; ≤ 5). Accepts access tokens
  only when `aud` ∋ the Gauzy audience and `azp` is trusted; never accepts an ID token issued to another client.
- **Endpoints** in `packages/core/src/lib/auth/auth.controller.ts`, each `@Public()` where stated, guarded by
  `FeatureFlagEnabledGuard` + `@FeatureFlag(FeatureEnum.FEATURE_EVER_ID_API)`, throttled:
  | Route | Auth | Behaviour | Limit |
  | ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
  | `POST /auth/signin.ever-id` | public; Ever ID access token in header | resolve users linked to the pair (never by e-mail) and return `IUserSigninWorkspaceResponse` via `createUserSigninWorkspaceResponse`; `404 EVER_ID_NOT_LINKED` otherwise | 20/min per IP |
  | `POST /auth/link.ever-id` | Gauzy JWT + Ever ID access token | `auth_time` ≤ 300 s, `email_verified`, link the current user in the current tenant; `409` on either unique conflict | 10/min per user |
  | `DELETE /auth/ever-id/link` | Gauzy JWT | unlink if another sign-in method remains; `409 LAST_SIGN_IN_METHOD` | 10/hour per user |
  | `POST /auth/ever-id/backchannel-logout` | public; form `logout_token` | validate (`aud` ∈ trusted clients); revoke access and refresh tokens whose metadata carries that `sid` (or every Ever-ID-issued token of the linked users for `sub`) | 60/min per IP |
- **Token metadata.** When `signin.workspace` completes a sign-in that started from `signin.ever-id`, the
  issued access and refresh tokens carry `{ everIdSid, externalIdentityId }` in `IAccessTokenMetadata` /
  `IRefreshTokenMetadata`, so a notice revokes exactly those.
- **Tests (tracked in `ever-co/ever-gauzy`; Jest `*.spec.ts` beside the source, local `jose` key pair as the fake
  provider):** `packages/core/src/lib/auth/external-identity/ever-id-token.service.spec.ts`,
  `packages/core/src/lib/auth/external-identity/external-identity.service.spec.ts`,
  `packages/core/src/lib/auth/external-identity/ever-id-backchannel-logout.spec.ts`,
  `packages/core/src/lib/auth/auth.controller.ever-id.spec.ts`,
  `packages/common/src/lib/guards/feature-flag-enabled.guard.spec.ts` — mapping in §7.

### 4.2 Ever Teams changes (in `ever-co/ever-teams`)

- `apps/web/core/lib/utils/check-provider-env-vars.ts`: a generic Auth.js OIDC provider
  `{ id: 'ever-id', name: 'Ever ID', type: 'oidc', issuer: EVER_ID_ISSUER, clientId: EVER_ID_CLIENT_ID,
clientSecret: EVER_ID_CLIENT_SECRET, checks: ['pkce', 'state', 'nonce'], authorization: { params: { scope:
'openid email profile apps:read' } } }`, filtered like the others (advertised by
  `NEXT_PUBLIC_EVER_ID_APP_NAME` **and** configured). The audience for Gauzy (and, for the App Launcher, Ever
  Works) is obtained as decided in [`idp-options.md`](./idp-options.md) §6 — a multi-audience token or a
  server-side token exchange per audience.
- `apps/web/core/types/generics/enums/social-accounts.ts`: `EProvider.EVER_ID = 'ever-id'`.
- `apps/web/core/services/server/requests/auth.ts`: `signInWithEverIdRequest(accessToken)` →
  `POST /auth/signin.ever-id` (token in the `Authorization` header); `linkEverIdRequest`, `unlinkEverIdRequest`.
- `apps/web/auth.ts`: in `signIn` and `jwt`, when `account.provider === 'ever-id'`, call
  `signInWithEverIdRequest` instead of `signWithSocialLoginsRequest`; keep Gauzy tokens in `authCookie` as
  today; keep Ever ID's access token only inside the encrypted Auth.js JWT, never in a URL or `localStorage`.
  `EVER_ID_NOT_LINKED` → `pages.error` with "Sign in the way you usually do, then connect Ever ID in
  Settings → Personal."
- `apps/web/core/services/server/requests/o-auth.ts` (`GauzyAdapter`): for `ever-id`, `getUserByAccount`
  resolves through `signin.ever-id`, and `linkAccount` and `createUser` **do nothing** — no account is created
  or linked implicitly.
- `apps/web/core/components/auth/social-logins-buttons.tsx`: Ever ID entry with its icon and the label
  `Sign in with Ever ID`.
- `apps/web/app/[locale]/(main)/settings/personal/page.tsx`: a "Connected identities" section; **Connect**
  starts `signIn('ever-id', …, { prompt: 'login', max_age: '300' })` with a short-lived intent cookie, and the
  callback calls `linkEverIdRequest` after the confirmation screen.
- App Launcher (APW-11 P2): a same-origin route, new `apps/web/app/api/auth/ever-id/token/route.ts`, returning the
  current Ever ID access token (≤ 900 s left, `Cache-Control: no-store`, body only) backs the component's
  `getAccessToken()`.
- Sign-out notices: the Ever Teams client's back-channel logout URI is Gauzy's
  `POST /auth/ever-id/backchannel-logout`; revoked Gauzy tokens make Teams' next API call fail and sign the
  person out, because Teams sessions are stateless cookies.
- **Tests (tracked in `ever-co/ever-teams`):** Jest (`apps/web/jest.config.ts`, `*.test.ts(x)` beside the source) —
  `apps/web/core/lib/utils/check-provider-env-vars.test.ts`, `apps/web/core/services/server/requests/o-auth.test.ts`,
  `apps/web/core/services/server/requests/auth.test.ts`, `apps/web/auth.test.ts`,
  `apps/web/app/[locale]/(main)/settings/personal/page.test.tsx`, `apps/web/app/api/auth/ever-id/token/route.test.ts`;
  Cypress (`apps/web/cypress.config.ts`) — `apps/web/cypress/e2e/ever-id-sign-in.cy.ts`,
  `apps/web/cypress/e2e/ever-id-connect.cy.ts`, `apps/web/cypress/e2e/ever-id-backchannel-logout.cy.ts`, with a local
  fake provider `apps/web/cypress/support/mock-ever-id-provider.mjs` beside the existing
  `apps/web/cypress/support/mock-gauzy-server.mjs` — mapping in §7.

### 4.3 P2 rollout

1. Teams development and stage against Gauzy development and stage with `FEATURE_EVER_ID_API=true`.
2. **Owner approval**, then `FEATURE_EVER_ID_API=true` on Gauzy production — the first Gauzy production
   change: server-side only, no UI, trusted client list containing only the Ever Teams client.
3. Teams production with `NEXT_PUBLIC_EVER_ID_APP_NAME` set. Existing Teams sign-ins verified unchanged.

## 5. Ever Gauzy adoption (P3 — production last)

### 5.1 API sign-in for Gauzy's own web app

- **Gauzy side is a plugin, not core (owner constraint, 2026-09-17 — `idp-options.md` §7.5).** New
  **`packages/plugins/<name>`** (the `@gauzy/plugin-*` convention) exporting a NestJS module — permitted
  because `PluginMetadata extends ModuleMetadata` — that carries `ever-id.strategy.ts`
  (`PassportStrategy` over the generic `openid-client` Passport strategy with `usePKCE: 'S256'`, `state` and
  `nonce`; configuration `EVER_ID_ISSUER`, `EVER_ID_GAUZY_CLIENT_ID`, `EVER_ID_GAUZY_CLIENT_SECRET`, callback
  `${API_BASE_URL}/api/auth/ever-id/callback`), its own guard, `ever-id.controller.ts` and `index.ts`. It is
  registered by **one import plus one array entry in `apps/api/src/plugins.ts`** (the same registration point
  ~38 existing plugins use) — and **not** by editing `packages/auth/src/lib/internal.ts`,
  `packages/core/src/lib/auth/auth.module.ts` or `packages/config`. The Keycloak and Auth0 strategies are not
  modified and not reused for Ever ID — they stay vendor-specific options for self-hosters, and the Keycloak
  scaffolding is **relocated into the `keycloak` provider plugin with its behaviour unchanged** (family below):
  same exports, same `'disabled'` defaults, core keeps re-exporting them through the plugin, and no route,
  configuration key or default is removed.
- **Two core touches to avoid, decided here** (either would be a ZITADEL edit in core code):
  (a) do **not** add `FEATURE_EVER_ID_LOGIN` to `packages/contracts/src/lib/feature.model.ts` — the plugin
  evaluates its own `EVER_ID_ENABLED === 'true'` inside its module and fails closed, which is stricter than the
  core flag helper (fail-open, `cross-platform.md` §3.1); (b) do **not** append to the core `AuthGuards` /
  `Strategies` arrays — the plugin's controller uses its own guard. Listing the plugin in `plugins.ts` is
  registration, not vendor logic; if the owner wants even that out of the app file, the fallback is a
  `GAUZY_PLUGINS`-style environment-addressed load, which is a change to the plugin loader and needs its own
  decision.
- **The provider-plugin family (owner decision, 2026-09-17).** Ever ID's own IdP is **ZITADEL**; the other
  providers are **optional per-installation plugins for self-hosters**, not alternatives Ever ID switches to:
    - `zitadel` — the Ever ID provider (this epic).
    - `keycloak` — **moved from core to a plugin** (blast radius in [`idp-options.md`](./idp-options.md) §7.3).
    - `supertokens` — **new, requested by the owner**, "not to replace anything": so a self-hoster can run Ever
      Gauzy with SuperTokens exactly as they can with Keycloak today.
    - `auth0` — already works today (`packages/auth/src/lib/auth0/`); it moves to the same shape when its plugin
      is extracted, and is not required for Ever ID.
      Each plugin is independent, enabled by its own configuration, and **fails closed when unconfigured** — the
      existing Keycloak strategy's `'disabled'` placeholders are the precedent. None of them is a dependency of
      Ever ID, and Ever ID is not a dependency of any of them.
- Controller: `GET /auth/ever-id?handoff_challenge=<S256 of a browser verifier>` and
  `GET /auth/ever-id/callback`, both `@UseGuards(FeatureFlagEnabledGuard, AuthGuard('ever-id'))` +
  `@FeatureFlag(FeatureEnum.FEATURE_EVER_ID_LOGIN)` (new, evaluated `=== 'true'`).
- **Hand-off without tokens in the address.** The callback stores a 32-byte one-time code for 60 s in the
  cache (`CACHE_MANAGER`, the store `storeOAuthAppPendingRequest` already uses), bound to the
  `handoff_challenge` and the verified pair, and redirects to `#/auth/ever-id?handoff=<code>`.
  `routeRedirect` is **not** used. The browser posts `{ handoff, verifier }` to
  `POST /auth/signin.ever-id.handoff`, which returns `IUserSigninWorkspaceResponse` for linked users only; the
  existing workspace selection and `POST /auth/signin.workspace` finish the sign-in. Storing and redeeming the code
  (single use, 60 s, S256 verifier check) lives in new `packages/core/src/lib/auth/external-identity/ever-id-handoff.service.ts`.
- Connect and disconnect for Gauzy's own users reuse §4.1's `link.ever-id` and `ever-id/link` routes, now also
  enabled by `FEATURE_EVER_ID_LOGIN`.

### 5.2 Gauzy web UI

- `packages/ui-auth/src/lib/components/social-links/social-links.component.ts` (+ template): an Ever ID link
  when app config exposes `FEATURE_EVER_ID_LOGIN`; it generates the verifier (kept in `sessionStorage` for
  60 s) before navigating.
- New `packages/ui-auth/src/lib/components/ever-id-complete/` on a new `auth/ever-id` route in
  `auth.routes.ts`: redeems the hand-off, then routes to `workspace-selection`.
- `packages/ui-core/shared/src/lib/user/edit-profile-form/edit-profile-form.component.ts`: a "Connected
  identities" section (connect, disconnect, last used), copy identical to Ever Works spec §6.
- **Tests (tracked in `ever-co/ever-gauzy`):** Jest — `packages/auth/src/lib/ever-id/ever-id.strategy.spec.ts`,
  `packages/auth/src/lib/ever-id/ever-id.controller.spec.ts`,
  `packages/core/src/lib/auth/external-identity/ever-id-handoff.service.spec.ts`, extended
  `packages/ui-auth/src/lib/components/social-links/social-links.component.spec.ts`,
  `packages/ui-auth/src/lib/components/ever-id-complete/ever-id-complete.component.spec.ts`; Playwright —
  `apps/gauzy-e2e/tests/ever-id-sign-in.spec.ts` (beside the existing `apps/gauzy-e2e/tests/login.smoke.spec.ts`).

### 5.3 MCP authorization server (last within P3)

- `packages/auth/src/lib/mcp/server/oauth-authorization-server.ts`: optional `federatedLogin` configuration
  adding `GET /oauth2/login/ever-id` and its callback beside the e-mail/password `loginEndpoint`; on success the
  pair resolves a Gauzy user through `external_identity` (a workspace choice page when there are several) and
  the pending authorization request continues exactly as after `userAuthenticator` succeeds.
- `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.ts`: wires it from `MCP_AUTH_EVER_ID_ENABLED` (default
  `false`) and the Gauzy client settings. The e-mail/password login stays the default.
- **Tests (tracked in `ever-co/ever-gauzy`):** `packages/auth/src/lib/mcp/server/oauth-authorization-server.ever-id.spec.ts`
  and `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.spec.ts` (Jest, `apps/mcp-auth/jest.config.ts`).

### 5.4 P3 rollout

Gauzy development → stage → **owner approval** → production with `FEATURE_EVER_ID_LOGIN=true` for the web
app, then `MCP_AUTH_EVER_ID_ENABLED=true`. Before each production step: backups verified per the operations
runbook, existing e-mail/password, magic code and every configured social sign-in exercised end to end, and a
rollback that is only a flag flip (the migration is additive and stays).

## 6. Flags and configuration

| Platform   | Name                                                                                                                                         | Default | Fail mode | Meaning                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- | ------------------------------------------------ |
| Ever Works | `ever-id` (rollout flag) + plugin enablement                                                                                                 | off     | closed    | UI rollout / API kill switch (plan §6.4, §9.2)   |
| Ever Gauzy | `FEATURE_EVER_ID_API`                                                                                                                        | off     | closed    | token-accepting API used by Ever Teams           |
| Ever Gauzy | `FEATURE_EVER_ID_LOGIN`                                                                                                                      | off     | closed    | Gauzy's own button, hand-off and profile section |
| Ever Gauzy | `MCP_AUTH_EVER_ID_ENABLED`                                                                                                                   | `false` | closed    | federated login on the MCP authorization server  |
| Ever Gauzy | `EVER_ID_ISSUERS`, `EVER_ID_GAUZY_AUDIENCE`, `EVER_ID_TRUSTED_CLIENT_IDS`, `EVER_ID_GAUZY_CLIENT_ID`, `EVER_ID_GAUZY_CLIENT_SECRET` (secret) | unset   | closed    | verification and client settings                 |
| Ever Teams | `NEXT_PUBLIC_EVER_ID_APP_NAME`, `EVER_ID_ISSUER`, `EVER_ID_CLIENT_ID`, `EVER_ID_CLIENT_SECRET` (secret)                                      | unset   | hidden    | provider advertised only when all are set        |

## 7. Acceptance per platform (gates spec ACC-12-40)

Each id's tests are **tracked in the named repository**, not in the Ever Works monorepo; paths are relative to that
repository's root on `develop` (layout read on 2026-09-17: Ever Teams — Jest `*.test.ts(x)` beside the source and
Cypress in `apps/web/cypress/e2e/`; Ever Gauzy — Jest `*.spec.ts` beside the source and Playwright in
`apps/gauzy-e2e/tests/`). Files marked "existing" already exist there; every other file is new in that task.

**Ever Teams (P2)**

- [ ] **XP-T-01** A Teams user linked to an Ever ID signs in with it and lands in the same workspace and team they reach with their usual method.
      _Tests (tracked in `ever-co/ever-teams`):_ `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (linked user → usual
      workspace and team); `apps/web/auth.test.ts` (`signIn`/`jwt` call `signInWithEverIdRequest` for provider
      `ever-id` and keep Gauzy tokens in `authCookie`). _Tracked in `ever-co/ever-gauzy`:_
      `packages/core/src/lib/auth/auth.controller.ever-id.spec.ts` (`POST /auth/signin.ever-id` returns the linked
      workspaces). Task T35, T36.
- [ ] **XP-T-02** An unlinked Ever ID signs nobody in, creates no Gauzy user, tenant or social account, and shows the connect guidance.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/core/src/lib/auth/auth.controller.ever-id.spec.ts` (unlinked
      pair → `404 EVER_ID_NOT_LINKED`, zero user/tenant/`social_account` inserts, never looked up by e-mail).
      _Tracked in `ever-co/ever-teams`:_ `apps/web/core/services/server/requests/o-auth.test.ts` (`GauzyAdapter`
      `createUser` and `linkAccount` are no-ops for `ever-id`); `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (the
      connect guidance renders). Task T35, T36.
- [ ] **XP-T-03** Connecting requires a signed-in Teams session, `auth_time` ≤ 300 s and a confirmation; a pair linked elsewhere in the same workspace answers 409.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/core/src/lib/auth/external-identity/external-identity.service.spec.ts`
      (`auth_time` 301 s refused; unique `(issuer, subject, tenantId)` and `(userId, issuer)` → 409; no link without
      `email_verified`). _Tracked in `ever-co/ever-teams`:_ `apps/web/app/[locale]/(main)/settings/personal/page.test.tsx`
      (Connect requires confirmation) and `apps/web/cypress/e2e/ever-id-connect.cy.ts`. Task T35, T36.
- [ ] **XP-T-04** A sign-out notice from Ever ID revokes the Gauzy tokens that sign-in issued; the Teams session ends on its next API call; password sessions are untouched.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/core/src/lib/auth/external-identity/ever-id-backchannel-logout.spec.ts`
      (revokes only tokens whose metadata carries the `everIdSid`, or every Ever-ID-issued token for `sub`; tokens from
      a password sign-in untouched; reused `jti` → 400). _Tracked in `ever-co/ever-teams`:_
      `apps/web/cypress/e2e/ever-id-backchannel-logout.cy.ts` (the next API call signs the person out). Task T35, T36.
- [ ] **XP-T-05** No Ever ID or Gauzy token appears in any address, log line or `localStorage` entry.
      _Tests (tracked in `ever-co/ever-teams`):_ `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (every visited URL,
      console entry and `localStorage` value scanned for the minted tokens, with a planted control);
      `apps/web/app/api/auth/ever-id/token/route.test.ts` (token only in the body, `Cache-Control: no-store`, ≤ 900 s
      left). Task T36, T37.
- [ ] **XP-T-06** With `FEATURE_EVER_ID_API` unset, every new Gauzy route answers not found and every existing Teams sign-in test passes unchanged.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/core/src/lib/auth/auth.controller.ever-id.spec.ts` (the
      four routes 404 with the flag unset, `'false'`, `'TRUE'` and `'1'`); `packages/common/src/lib/guards/feature-flag-enabled.guard.spec.ts`
      (strict `'true'` for `FEATURE_EVER_ID_API`, existing `FEATURE_*_LOGIN` flags keep their current evaluation).
      _Tracked in `ever-co/ever-teams`:_ existing `apps/web/core/hooks/auth/use-authentication-passcode.test.tsx`,
      `apps/web/app/api/auth/register/route.test.ts` and `apps/web/core/lib/utils/check-provider-env-vars.test.ts`
      (Ever ID hidden unless advertised and configured). Task T35, T36.

**Ever Gauzy (P3)**

- [ ] **XP-G-01** Gauzy web sign-in with Ever ID lists only workspaces whose user is linked to the pair.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `apps/gauzy-e2e/tests/ever-id-sign-in.spec.ts` (two linked workspaces
      listed, a third workspace with the same e-mail but no link absent);
      `packages/ui-auth/src/lib/components/ever-id-complete/ever-id-complete.component.spec.ts` (redeems the hand-off,
      routes to workspace selection). Task T40.
- [ ] **XP-G-02** The hand-off code is single-use, expires after 60 s, and fails without the matching verifier.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/core/src/lib/auth/external-identity/ever-id-handoff.service.spec.ts`
      (second redemption refused; 61 s refused; wrong verifier refused). Task T39.
- [ ] **XP-G-03** The callback address never contains a JWT, refresh token or user ID.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/auth/src/lib/ever-id/ever-id.controller.spec.ts` (the
      callback redirect is `#/auth/ever-id?handoff=<32-byte code>` only; asserted against a JWT pattern, the issued
      refresh token and the user id); `packages/auth/src/lib/ever-id/ever-id.strategy.spec.ts` (S256, `state`,
      `nonce`). Task T39.
- [ ] **XP-G-04** With `FEATURE_EVER_ID_LOGIN` unset, no Ever ID link renders and `GET /auth/ever-id` answers not found.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/auth/src/lib/ever-id/ever-id.controller.spec.ts` (404 with
      the flag unset); existing `packages/ui-auth/src/lib/components/social-links/social-links.component.spec.ts`,
      extended (no Ever ID link unless the app config exposes the flag). Task T39, T40.
- [ ] **XP-G-05** The MCP authorization server's e-mail/password login is unchanged; with the flag on, federated login completes a pending PKCE authorization.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/auth/src/lib/mcp/server/oauth-authorization-server.ever-id.spec.ts`
      (e-mail/password login with the flag off and on; federated login resumes the pending PKCE request);
      `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.spec.ts` (`MCP_AUTH_EVER_ID_ENABLED` unset → no federated route).
      Task T41.
- [ ] **XP-G-06** Every existing Gauzy sign-in method passes its end-to-end suite on stage before the production flag is set.
      _Tests (tracked in `ever-co/ever-gauzy`):_ existing `apps/gauzy-e2e/tests/login.smoke.spec.ts` and
      `apps/gauzy-e2e/tests/bdd/features/login.feature` run against stage, plus the social sign-ins configured there;
      the run links are recorded in the private operations change log as `apw12-gauzy-stage-signin-regression`.
      Task T42.

## 8. Open questions

- **Account creation from Ever ID in Teams and Gauzy.** Default: not in P2/P3. Revisit once linking is proven.
- **Multi-audience tokens vs token exchange** for Teams → Gauzy and Teams → Ever Works — decided with the
  identity provider ([`idp-options.md`](./idp-options.md) §6).
- **Ever Rec and other Ever apps.** Not covered; the same model applies when they adopt.
- **Gauzy self-hosters** who already use the Keycloak or Auth0 strategies: document that Ever ID's generic
  strategy can point at their own provider, without changing theirs. Ever ID's own provider is **ZITADEL**
  (`idp-options.md` §6) — a self-hoster's Keycloak realm is neither required nor touched.
