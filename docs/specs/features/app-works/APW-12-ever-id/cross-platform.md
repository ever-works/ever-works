# Ever ID — adoption by Ever Teams and Ever Gauzy

**Epic**: [`APW-12-ever-id`](./spec.md) · **Applies to**: Ever Teams and Ever Gauzy (the phases this epic calls P2 and P3)
**Status**: `Draft` · **Created**: 2026-09-17 · **Revised**: 2026-10-01 (Gauzy placement: one plugin, environment-only
flags; schedule; linking rule 2)
**Verified against**: `ever-co/ever-gauzy` `develop` at `84a527d85` and `ever-co/ever-teams` `develop` at `e6ebffadb`,
read on 2026-10-01 through the GitHub contents API. Paths drift; re-open each one before its task starts.

> **Schedule.** Ever Teams and Ever Gauzy adopt Ever ID directly after Ever Works, side by side on their development
> and stage environments; Teams needs only the Gauzy plugin's token route (§4.1) to start. Turning Ever ID on for
> Ever Gauzy in production — which also serves Ever Teams Cloud, because both use the same Gauzy API and database —
> stays a separate change: default off, server-side first, backups verified, supervised by the owner, and last.

> Work described here lands in **other repositories**. This file is the contract those pull requests
> implement; each repository keeps its own tests and migrations. Nothing here removes or renames an existing
> sign-in method, route, entity or flag in either product, and Ever Gauzy production changes last, behind
> default-off flags, with every existing sign-in kept.

---

## 1. Principles (binding for P2 and P3)

1. **Additive.** Ever ID is one more sign-in method. Email and password, magic code, Google, GitHub,
   Facebook, Twitter, Microsoft, LinkedIn, Auth0 and Keycloak keep working as they do today (Keycloak moves into its
   own plugin, §5.1, and becomes usable once it is configured). **ZITADEL is an addition, never a replacement** —
   each platform keeps its own authentication and its own user database, and profile data stays local (owner
   constraint, 2026-09-17; [`idp-options.md`](./idp-options.md) §7).
2. **Order.** Ever Works first; Ever Teams and Ever Gauzy next, together on development and stage; Ever Gauzy
   production (shared with Ever Teams Cloud) last.
3. **Generic OpenID Connect only.** Each platform integrates against the standard discovery document, not a
   vendor library, so the identity provider stays replaceable ([`idp-options.md`](./idp-options.md)). Gauzy gets a
   small shared OpenID Connect library (§4.1) that no provider owns.
4. **Default-off, fail-closed flags, read from the environment only.** A missing or malformed value of a switch that
   turns something on means off. Gauzy's flags are environment variables read once at boot and compared strictly with
   `'true'`; none is added to `FeatureEnum`, `IAuthenticationFlagFeatures` or `packages/contracts`. The one setting that
   defaults to on is a safety feature of an already loaded plugin: sign-out notices
   (`ZITADEL_BACKCHANNEL_LOGOUT_ENABLED`), which only a strict `'false'` turns off.
5. **No token in a URL** on any Ever ID path. The existing social redirects that hand a result to the web app
   in the address are kept but **must not be extended**; the Ever ID path uses a one-time hand-off key
   redeemed by `POST` (§5.1).
6. **No silent linking.** No platform links an Ever ID to an account because e-mail addresses match (§2); the one
   narrow exception on Ever's own hosted Gauzy and Teams still requires a code sent to that mailbox.
7. **Sign-out notices honoured** by every platform for the sessions or tokens it issued through Ever ID.
8. **Same numbers as Ever Works** ([`plan.md`](./plan.md) §4.3): S256 PKCE; 32-byte `state` and `nonce`;
   60 s clock skew; key cache 600 s with a 30 s unknown-key cooldown and 21,600 s maximum staleness; 5 s
   outbound timeout; connect requires `auth_time` ≤ 300 s and `email_verified`; logout tokens ≤ 300 s old
   with a 600 s `jti` replay window.

## 2. The account-linking model

Ever ID owns the **person** (one `sub` per issuer). Each platform owns **its own link table** keyed by
(issuer, subject) and decides which of its accounts that pair may enter. No platform reads another
platform's link table.

| Platform   | Where accounts live                                                      | Cardinality of a pair                                  | Link table                                            | Account selection after Ever ID sign-in                                         |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Ever Works | one account per person                                                   | ≤ 1 account; ≤ 1 pair per account per issuer           | `external_identities` ([`plan.md`](./plan.md) §3.1)   | the linked account                                                              |
| Ever Gauzy | one user per workspace (tenant); one e-mail can exist in many workspaces | ≤ 1 link per user row; one pair may reach several rows | `zitadel_account`, owned by the Gauzy plugin (§4.1)   | the existing workspace picker, listing **only** workspaces whose user is linked |
| Ever Teams | none of its own — every Teams account is a Gauzy user                    | inherits Gauzy's                                       | Gauzy's `zitadel_account` (Teams holds no link table) | Gauzy's picker result, as Teams uses today                                      |

```
                      Ever ID  (iss, sub = "u-81f…")
                 ┌──────────────┼───────────────────────────┐
                 ▼              ▼                           ▼
  Ever Works account     Gauzy user @ workspace A    Gauzy user @ workspace B     (Teams reads these)
  (1 row)                (1 row, tenant A)           (1 row, tenant B)
```

**Rules applied identically everywhere:**

1. **Explicit linking (every platform's default).** A link is created only by a person who is **already signed
   in** to that platform account, after a fresh Ever ID authentication (`auth_time` ≤ 300 s), with
   `email_verified: true`, and after confirming a screen that shows both e-mail addresses. On Gauzy the signed-in
   user row is linked; another workspace's row with the same address is linked only when the person ticks it and
   proves the mailbox with Gauzy's own one-time e-mail code.
2. **No account from Ever ID without the person's explicit sign-up.** Signing in with an unlinked Ever ID never
   selects or creates an account by itself. Ever Works may offer account creation after a confirmation (spec
   FR-23). Ever Teams and Ever Gauzy never create an account from Ever ID unless the person explicitly signs up:
   on Ever's own hosted Gauzy and Teams a person new to them may create a workspace with Ever ID through Gauzy's
   own register path after confirming it (`ZITADEL_SIGNUP_ENABLED`, §4.1), and a self-hosted installation never
   creates one. **Ever's own hosted Gauzy and Teams also accept a confirmed link:** when an unlinked Ever ID's
   verified e-mail matches existing Gauzy users, those users are linked only after the person enters the one-time
   code Gauzy sends to that mailbox (`ZITADEL_LINK_MODE=confirmed`); nothing is written before the code is
   accepted, and self-hosted installations keep `explicit`.
3. Unlinking keeps a working sign-in method (a password, another social account, or a verified e-mail that
   can receive a reset or magic code). On Gauzy the rule is evaluated per user row.
4. Unique constraints decide races: on Gauzy `(issuer, subject, userId)` is unique, so a pair links each user row
   at most once; on Ever Works (issuer, subject) and (user, issuer).
5. The existing e-mail-matching social flows (Gauzy's workspace sign-in by social e-mail, Teams'
   `GauzyAdapter` social path) are **not** used for `ever-id` and are not changed.

## 3. What ships today (the integration points)

### 3.1 Ever Gauzy

| Area                     | Path                                                                                                                                         | Relevant behaviour today                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin registry          | `apps/api/src/plugins.ts`; `packages/plugin/src/lib/plugin-metadata.ts`; precedent `packages/plugins/integration-ever-async`                 | `@GauzyCorePlugin` classes listed in one array, some behind a conditional spread. A plugin carries `entities`, `subscribers`, `extensions` and `configuration`; migrations still come only from core's migration directory (plugin migrations wait for Gauzy PR #10254).                                                                                                                                                            |
| Strategy registry        | `packages/auth/src/lib/internal.ts`                                                                                                          | `Strategies` (Auth0, Facebook, Fiverr, GitHub, Google, Keycloak, LinkedIn, Microsoft, Twitter), `Controllers` (no Keycloak controller), `AuthGuards` (Microsoft, Keycloak).                                                                                                                                                                                                                                                         |
| Module                   | `packages/auth/src/lib/social-auth.module.ts`                                                                                                | Registers strategies, guards, controllers; `SocialAuthService` is replaced by core's `AuthService` via `registerAsync`.                                                                                                                                                                                                                                                                                                             |
| Base service             | `packages/auth/src/lib/social-auth.service.ts`                                                                                               | `validateOAuthLoginEmail` contract; `routeRedirect` builds the web redirect after a social callback; OAuth-app registry types.                                                                                                                                                                                                                                                                                                      |
| Keycloak                 | `packages/auth/src/lib/keycloak/keycloak.strategy.ts`, `keycloak-auth-guard.ts`                                                              | `passport-keycloak-oauth2-oidc`, realm-specific config, `'disabled'` placeholders when unconfigured. **Dormant: no controller, so no route** — and it cannot be pointed at ZITADEL, because that library hard-codes `{authServerURL}/realms/{realm}/protocol/openid-connect/*` (`idp-options.md` §7.1). It moves into the `auth-keycloak` plugin (§5.1) with every strategy, guard, export, env name and `'disabled'` default kept. |
| Auth0                    | `packages/auth/src/lib/auth0/auth0.strategy.ts`, `auth0.controller.ts`                                                                       | `passport-auth0`; callback → `validateOAuthLoginEmail(user.emails)` → `routeRedirect`.                                                                                                                                                                                                                                                                                                                                              |
| Social pattern           | `packages/auth/src/lib/google/google.controller.ts`                                                                                          | `@UseGuards(FeatureFlagEnabledGuard, AuthGuard('google'))` + `@FeatureFlag(FeatureEnum.FEATURE_GOOGLE_LOGIN)`.                                                                                                                                                                                                                                                                                                                      |
| Feature flags            | `packages/contracts/src/lib/feature.model.ts`, `packages/common/src/lib/guards/feature-flag-enabled.guard.ts`                                | `FEATURE_*_LOGIN` members; `featureEnabled()` returns **true unless** the variable is `'false'` (fail-open — Ever ID must not use it, and adds no member here).                                                                                                                                                                                                                                                                     |
| Gauzy as OAuth server    | `packages/auth/src/lib/oauth-app/oauth-app.controller.ts`                                                                                    | `/integration/ever-gauzy/oauth/{authorize,token}` for third-party integrations: `oauth_clients` registry, exact redirect match, consent page. No ID token or discovery. **Unrelated to Ever ID and unchanged.**                                                                                                                                                                                                                     |
| MCP authorization server | `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.ts`, `packages/auth/src/lib/mcp/server/oauth-authorization-server.ts`                         | OAuth 2.x server for MCP clients (PKCE, dynamic client registration, introspection, userinfo, JWKS); `/oauth2/login` authenticates with e-mail and password via `userAuthenticator`.                                                                                                                                                                                                                                                |
| Core sign-in             | `packages/core/src/lib/auth/auth.controller.ts`, `auth.service.ts`                                                                           | `POST /auth/signin.email.social` → `signinWorkspacesByEmailSocial` (verifies a provider token, finds users **by e-mail**, returns workspaces); `POST /auth/signin.workspace`; `GET /auth/workspaces`; `POST /auth/switch-workspace`; `POST /auth/logout`. `verifyOAuthToken` supports Google, GitHub, Twitter, Facebook. **None of these routes is changed, wrapped or re-exported for Ever ID.**                                   |
| Social accounts          | `packages/core/src/lib/auth/social-account/social-account.entity.ts`                                                                         | `social_account`: `provider: ProviderEnum`, `providerAccountId`, `userId`, tenant columns. No issuer — which is why Ever ID keeps its own table instead.                                                                                                                                                                                                                                                                            |
| Token revocation         | `packages/core/src/lib/access-token/`, `packages/core/src/lib/refresh-token/`, `packages/core/src/lib/token/` (used by `AuthService.logout`) | `AccessTokenService.revoke` / `RefreshTokenService.revoke`.                                                                                                                                                                                                                                                                                                                                                                         |
| Web sign-in UI           | `packages/ui-auth/src/lib/components/social-links/social-links.component.ts`, `workspace-selection/`, `auth.routes.ts`                       | Social buttons from app config (`packages/ui-core/core/src/lib/auth/auth.module.ts` `socialLinks`, URLs from `packages/ui-config/src/lib/environments/model.ts`); workspace picker; routes `login`, `oauth-authorize`, `logout`.                                                                                                                                                                                                    |
| UI plugins               | `apps/gauzy/src/plugin-ui.config.ts`                                                                                                         | Angular `PluginUiDefinition`s registered in one list, each with a location such as `settings-sections`.                                                                                                                                                                                                                                                                                                                             |
| Profile UI               | `packages/ui-core/shared/src/lib/user/edit-profile-form/edit-profile-form.component.ts`                                                      | The user's own profile form.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Migrations               | `packages/core/src/lib/database/migrations/`                                                                                                 | Forward-only migrations for both ORMs, read from this directory only.                                                                                                                                                                                                                                                                                                                                                               |

### 3.2 Ever Teams

| Area           | Path                                                                                                                         | Relevant behaviour today                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth.js config | `apps/web/auth.ts`                                                                                                           | `session: { strategy: 'jwt' }`; `signIn` and `jwt` callbacks send the provider's `access_token` to Gauzy (`signInCallback`, `jwtCallback`) and keep Gauzy tokens in `token.authCookie`.        |
| Adapter        | `apps/web/core/services/server/requests/o-auth.ts`                                                                           | `GauzyAdapter`: `createUser` registers a Gauzy user + tenant + organization + employee + team; `getUserByAccount` asks Gauzy by provider account; `linkAccount` → Gauzy `signup.link.account`. |
| Providers      | `apps/web/core/lib/utils/check-provider-env-vars.ts`                                                                         | Nine Auth.js providers; `filteredProviders` shows one only when advertised (`NEXT_PUBLIC_<X>_APP_NAME`) **and** configured (client ID).                                                        |
| Provider enum  | `apps/web/core/types/generics/enums/social-accounts.ts`                                                                      | `EProvider`: github, google, facebook, twitter.                                                                                                                                                |
| Gauzy requests | `apps/web/core/services/server/requests/auth.ts`                                                                             | `signWithSocialLoginsRequest` → `/auth/signin.email.social`; `/auth/signin.workspace`; `/auth/refresh-token`.                                                                                  |
| Buttons        | `apps/web/core/components/auth/social-logins-buttons.tsx`                                                                    | Renders `mappedProviders` with icons; hidden in demo mode.                                                                                                                                     |
| Passcode page  | `apps/web/core/components/pages/auth/passcode/page-component.tsx`, `apps/web/core/hooks/auth/use-authentication-passcode.ts` | The existing one-time-code screen — reused for the confirmed link (§4.2).                                                                                                                      |
| Sign-up        | `apps/web/app/api/auth/register/route.ts`, `apps/web/core/components/pages/auth/signup/page-component.tsx`                   | The existing sign-up page and its route — reused for the explicit sign-up path (§4.2).                                                                                                         |
| Settings       | `apps/web/app/[locale]/(main)/settings/personal/page.tsx`                                                                    | Personal settings.                                                                                                                                                                             |

## 4. Ever Teams adoption (P2)

Teams accounts are Gauzy users, so Teams needs the Gauzy plugin's **token route** first. The plugin is the same one
Gauzy's own web sign-in uses (§5.1); loaded alone it adds no Gauzy UI and has no effect unless someone signs in with
Ever ID.

### 4.1 The Gauzy side — the `auth-zitadel` plugin and its token route (in `ever-co/ever-gauzy`)

- **Placement: one plugin, not core.** New `packages/plugins/auth-zitadel` (`@gauzy/plugin-auth-zitadel`, a
  `@GauzyCorePlugin` named after the provider, never after the product) holds every piece of Gauzy's Ever ID
  integration: the entities, the services (sign-in, linking, one-time hand-off, token sign-in, sessions and sign-out
  notices), the controller with every Ever ID route, its DTOs and its specs. An optional companion UI plugin is
  described in §5.2.
- **Registration: one import plus one array entry** in `apps/api/src/plugins.ts`, beside the existing conditional
  plugins: `...(process.env['ZITADEL_ENABLED'] === 'true' ? [AuthZitadelPlugin] : [])`. Nothing is added to
  `packages/core` auth code, `packages/auth/src/lib/internal.ts` (it changes only by the Keycloak lines moving into
  their plugin, §5.1), `packages/config`, `FeatureEnum`, `IAuthenticationFlagFeatures` or `packages/contracts`.
- **Flag: `ZITADEL_ENABLED`, environment only.** Read once at boot and compared strictly with `'true'`; unset or
  malformed means the plugin is not loaded — no route, no timer, no query on its tables apart from the migration, and
  no outbound request. Loaded but without issuer and client settings, `GET /api/auth/zitadel/config` answers
  `{ enabled: false, reason: 'unconfigured' }`, every other route answers 404, and boot never fails.
- **Entities, owned by the plugin.** `zitadel_account` (issuer, subject, `userId`, the e-mail at link time, link
  method `explicit | confirmed | provisioned | signup`, linked and last-login times; unique `(issuer, subject, userId)`),
  `zitadel_organization` (an Ever organization ↔ one Gauzy organization), `zitadel_session` (the Ever ID session `sid`
  per sign-in, for sign-out notices) and `zitadel_logout_jti` (the replay window). `social_account` and `ProviderEnum`
  are untouched.
- **Migration: in core's migration directory for now.** One hand-written, multi-dialect migration,
  `packages/core/src/lib/database/migrations/<timestamp>-AuthZitadel.ts` (`CREATE TABLE IF NOT EXISTS`, PostgreSQL,
  MySQL and SQLite, with `down`, no per-tenant loop), because Gauzy reads migrations only from that directory until
  plugin migrations land (Gauzy PR #10254). The plugin's `MIGRATIONS.md` lists it, so moving it into the plugin later is
  mechanical.
- **Verification: a shared OpenID Connect library.** New `packages/auth/src/lib/oidc/` — discovery, JWKS cache with
  `jose`, PKCE, a signed-cookie transaction for `state` and `nonce`, ID-token and logout-token validation — is a library
  registered nowhere and knows no provider; the plugin configures it. Settings: `ZITADEL_ISSUERS` (1–3 exact issuer
  strings), `ZITADEL_CLIENT_ID` / `ZITADEL_CLIENT_SECRET`, `ZITADEL_ALLOWED_AUDIENCES` (the client ids whose tokens the
  token route accepts — the Ever Teams client and the Ever Works client).
- **Token route — `POST /api/auth/zitadel/token`** (public, `Cache-Control: no-store`, throttled like
  `signin.email.social`). Body `{ id_token }` — or `{ access_token }` when it is a JWT — verified **locally** against the
  issuer's keys: issuer in `ZITADEL_ISSUERS`, signature, `exp`, `iat` no more than 300 s ahead, and `aud` or `azp` in
  `ZITADEL_ALLOWED_AUDIENCES`; an ID token must carry `email_verified: true`. There is no userinfo call, opaque tokens
  are refused, and an access token can only complete an existing link. Answers:
    - a linked pair → `IUserSigninWorkspaceResponse` (the shape of `POST /auth/signin.email/confirm`) listing the linked
      workspaces only; the client then calls the **existing** `POST /auth/signin.workspace`, which issues Gauzy's usual
      access and refresh tokens with their payload unchanged;
    - `confirmed` mode, unlinked, verified e-mail matching existing users → `{ confirm_required: true, handoff }`; the
      client posts the code Gauzy e-mailed to `POST /api/auth/zitadel/confirm { handoff, code }`;
    - sign-up enabled (Ever's hosted Gauzy and Teams only) and no account → `404 { code: 'signup_required', handoff }`;
      the client shows its own sign-up page and posts `POST /api/auth/zitadel/signup { handoff, confirm: true, user }`;
    - otherwise → `404 { code: 'no_workspace' }`. Nothing is ever looked up by e-mail outside `confirmed` mode.
- **Sign-out notices — `POST /api/auth/zitadel/backchannel-logout`** (public, form `logout_token`): validated by the
  shared library (`iss`, `aud` ∋ the client, the back-channel event, `sid`, no `nonce`, `iat` within 300 s, unseen `jti`);
  a token that fails any of these checks is answered `400` and changes nothing. A valid token revokes the Gauzy tokens
  issued after that Ever ID session started for the users of that `sid` and deletes the session rows; the answer is `200`
  even when a revocation fails (the failure is logged). The route is on whenever the plugin is loaded; only
  `ZITADEL_BACKCHANNEL_LOGOUT_ENABLED=false` turns it off (404).
- **Tests (tracked in `ever-co/ever-gauzy`; Jest `*.spec.ts`, a local `jose` key pair as the fake provider):**
  `packages/auth/src/lib/oidc/{pkce,transaction,jwks,id-token,logout-token}.spec.ts`,
  `packages/plugins/auth-zitadel/src/lib/specs/{token,backchannel,no-silent-link,link.confirmed,signup,email-unverified}.spec.ts`,
  and, new under `apps/api/src/e2e/`, `zitadel.token.e2e.spec.ts` and `preservation.e2e.spec.ts` (every existing sign-in
  route answers byte for byte the same with the plugin loaded and unloaded) — mapping in §7.

### 4.2 Ever Teams changes (in `ever-co/ever-teams`)

- `apps/web/core/lib/utils/check-provider-env-vars.ts`: a generic Auth.js OIDC provider `{ id: 'ever-id', name:
'Ever ID', type: 'oidc', issuer: EVER_ID_ISSUER_URL, clientId: EVER_ID_CLIENT_ID, clientSecret:
EVER_ID_CLIENT_SECRET, checks: ['pkce', 'state'], idToken: true }`, filtered like the others (advertised by
  `NEXT_PUBLIC_EVER_ID_APP_NAME` **and** configured). Scopes `openid profile email` plus the ZITADEL resource-owner
  scope, and — when `EVER_PLATFORM_PROJECT_ID` is set — the audience scope of that project.
- `apps/web/core/constants/config/constants.tsx`: server-only `EVER_ID_ISSUER_URL` (the older `EVER_ID_ISSUER` is still
  read, with a one-time deprecation warning), `EVER_ID_CLIENT_ID`, `EVER_ID_CLIENT_SECRET`, `EVER_PLATFORM_PROJECT_ID`,
  `EVER_ID_TEAMS_AUTO_PROVISION` (default `false`); documented in `apps/web/.env.sample`, `.env.docker`, the compose
  files and the `turbo.json` env list.
- `apps/web/core/types/generics/enums/social-accounts.ts`: `EProvider.EVER_ID = 'ever-id'`.
- `apps/web/core/components/auth/social-logins-buttons.tsx` (+ `apps/web/core/components/icons/icons.tsx`): an Ever ID
  entry, after Google, labelled `Ever ID`; hidden in demo mode like every social button.
- `apps/web/auth.ts`, `apps/web/core/services/server/requests/o-auth.ts`: the `signIn` and `jwt` callbacks pass the
  provider's `id_token` as well; for `ever-id`, sign-in calls the new `signWithEverIdRequest(id_token)` in
  `apps/web/core/services/server/requests/auth.ts` (`POST /api/auth/zitadel/token`) instead of
  `signWithSocialLoginsRequest`, then continues exactly as today with `signInWorkspace` and the existing cookies —
  Gauzy's tokens, unchanged. The Ever ID token stays inside the encrypted Auth.js JWT, never in a URL or `localStorage`.
- `confirm_required` → the existing passcode page posts the code to new `apps/web/app/api/auth/ever-id/confirm/route.ts`,
  which forwards it to Gauzy's `POST /api/auth/zitadel/confirm`.
- `signup_required` → the existing sign-up page, carrying only the one-time hand-off key (never an e-mail or a token in the
  address, new `apps/web/app/api/auth/ever-id/signup-handoff/route.ts`); after the person confirms, Teams posts its usual
  sign-up fields to Gauzy's `POST /api/auth/zitadel/signup`.
- `no_workspace` → the error page says no workspace is linked to this Ever ID yet and how to get one. A self-hosted Teams
  may opt in with `EVER_ID_TEAMS_AUTO_PROVISION === 'true'` (default off, and off on every Ever deployment): the page then
  offers Teams' existing sign-up instead, and `GauzyAdapter.createUser` runs only after the person confirms it there —
  never silently from the sign-in (§2 rule 2). `getUserByAccount` / `linkAccount` do nothing for `ever-id` — the link
  lives in Gauzy's `zitadel_account`.
- Sign-out notices: new `apps/web/app/api/auth/ever-id/backchannel-logout/route.ts` verifies the logout token with `jose`,
  forwards it to Gauzy's `POST /api/auth/zitadel/backchannel-logout` (Gauzy keeps the authoritative replay cache and
  revokes the tokens), and answers `400` for a malformed token and `200` otherwise; the next Gauzy call with a revoked
  token ends the Teams session, because Teams sessions are stateless cookies.
- Connecting an existing account happens on Gauzy's **Connected identities** page (§5.2), which a Teams user reaches with
  the same account; a Connect entry inside Teams settings is a later addition (§8).
- The App Launcher's token route for Teams is a separate, later change, described with the launcher
  ([`../APW-11-app-launcher/cross-platform.md`](../APW-11-app-launcher/cross-platform.md)); it is not part of this adoption.
- **Tests (tracked in `ever-co/ever-teams`):** Jest (`apps/web/jest.config.ts`, `*.test.ts(x)` beside the source) —
  existing `apps/web/core/lib/utils/check-provider-env-vars.test.ts` (extended), new
  `apps/web/core/components/auth/social-logins-buttons.test.tsx`,
  `apps/web/core/services/server/requests/o-auth.ever-id.test.ts`,
  `apps/web/app/api/auth/ever-id/{confirm,backchannel-logout,signup-handoff}/route.test.ts`,
  `apps/web/core/lib/auth/ever-id/logout-token.test.ts` and `apps/web/test/architecture/ever-id-provider-off.test.ts`;
  existing `apps/web/app/api/auth/register/route.test.ts` (extended); Cypress (`apps/web/cypress.config.ts`) —
  `apps/web/cypress/e2e/ever-id-sign-in.cy.ts`, run against stage — mapping in §7.

### 4.3 P2 rollout

1. Development and stage: `ZITADEL_ENABLED=true` on the Gauzy API that serves the Teams stage, with the Ever Teams client
   in `ZITADEL_ALLOWED_AUDIENCES`; the Teams stage with `NEXT_PUBLIC_EVER_ID_APP_NAME` and the client settings.
2. Production comes with Gauzy's (§5.4): the Gauzy API behind Gauzy Cloud also serves Teams Cloud, so the plugin is loaded
   there once, server-side first, in the owner-supervised change.
3. Teams production with `NEXT_PUBLIC_EVER_ID_APP_NAME` set. Existing Teams sign-ins verified unchanged.

## 5. Ever Gauzy adoption (P3 — production last)

### 5.1 API sign-in for Gauzy's own web app

- **The same plugin, its sign-in routes** (`packages/plugins/auth-zitadel`, all under `/api/auth/zitadel`,
  `Cache-Control: no-store`, `@Public()` unless noted; existing routes are not wrapped, decorated or re-exported):

    | Route                                                                                                                                               | Behaviour                                                                                                                                                                                                                                                  |
    | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `GET /config`                                                                                                                                       | `{ enabled, issuer, link_modes, signup }` — the web shows the button only when `enabled`                                                                                                                                                                   |
    | `GET /`                                                                                                                                             | 302 to the provider's authorize endpoint with PKCE, `state` and `nonce` kept in a signed, HttpOnly cookie; the return path is checked against `CLIENT_BASE_URL`; no e-mail is ever forwarded as `login_hint`                                               |
    | `GET /callback`                                                                                                                                     | exchange and validate; require `email_verified`; then 302 to `#/auth/ever-id?handoff=<key>` (linked), `#/auth/ever-id/confirm?handoff=<key>` (`confirmed` mode) or the sign-up confirmation (sign-up enabled) — a one-time key, never a token or a user id |
    | `POST /handoff`                                                                                                                                     | redeems the key once (60 s): returns `IUserSigninWorkspaceResponse` for linked users only; the existing workspace selection and `POST /auth/signin.workspace` finish the sign-in                                                                           |
    | `POST /confirm`, `POST /signup`                                                                                                                     | the confirmed link and the explicit sign-up of §2 rule 2                                                                                                                                                                                                   |
    | `POST /link` _(signed in)_, `GET /link/callback`, `POST /link/confirm` _(signed in)_, `DELETE /link` _(signed in)_, `GET /identities` _(signed in)_ | explicit linking from Settings (fresh authentication, both e-mails shown, per-row proof for other workspaces), unlinking with `409` when it would leave no sign-in method, and the list of connected identities                                            |

- **Hand-off without tokens in the address.** The one-time key is 32 random bytes, kept 60 s in the Nest cache (Redis on
  multi-replica installs) and deleted on read; a second read answers 410. `routeRedirect` is **not** used.
- **Nothing changes in Gauzy's session model.** The plugin issues only the existing `WORKSPACE_SIGNIN` purpose tokens;
  access and refresh tokens still come solely from `POST /auth/signin.workspace`, with no new claim.
- **The provider-plugin family (owner decision, 2026-09-17).** Ever ID's own IdP is **ZITADEL**; the other providers are
  **optional per-installation plugins for self-hosters**, not alternatives Ever ID switches to, each named after its
  provider:
    - `auth-zitadel` — the Ever ID provider (this epic).
    - `auth-keycloak` — **moved from core**: the same strategy, guard, exports, env names and `'disabled'` defaults, and
      `@gauzy/auth` keeps re-exporting every Keycloak symbol it exports today. It also gains its own sign-in routes and a
      login button, loaded **only** when `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET` are set; an installation without
      them sees no route and no button, exactly as today (blast radius in [`idp-options.md`](./idp-options.md) §7.3).
    - `supertokens` (new, requested by the owner "not to replace anything") and the `auth0` move into the same shape are
      later, separate changes; Auth0 keeps working from `packages/auth/src/lib/auth0/` meanwhile.

    Each plugin is independent, enabled by its own configuration, and **fails closed when unconfigured**. None of them is a
    dependency of Ever ID, and Ever ID is not a dependency of any of them; they share only the OpenID Connect library of
    §4.1.

### 5.2 Gauzy web UI

- `packages/ui-config/src/lib/environments/model.ts`: `ZITADEL_AUTH_LINK` beside the other `*_AUTH_LINK` values;
  `packages/ui-core/core/src/lib/auth/auth.module.ts`: one more `socialLinks` entry
  `{ url: environment.ZITADEL_AUTH_LINK, icon: 'ever-id' }`, rendered only when the link is set **and**
  `GET /api/auth/zitadel/config` says `enabled`; label and tooltip "Sign in with Ever ID". The Keycloak button follows the
  same pattern with `KEYCLOAK_AUTH_LINK`.
- New `packages/plugins/auth-zitadel-ui` (`@gauzy/plugin-auth-zitadel-ui`, a `PluginUiDefinition` registered in
  `apps/gauzy/src/plugin-ui.config.ts`, location `settings-sections`): **Settings → Connected identities** (list,
  **Connect Ever ID**, **Disconnect**, the confirmation screen with both e-mails and the other workspaces' rows), and the
  pages `#/auth/ever-id` (redeems the hand-off, then the existing workspace picker), `#/auth/ever-id/confirm` (the code
  screen) and `#/auth/ever-id/signup` (the explicit sign-up confirmation). The page is hidden when `/config` answers 404.
- **Tests (tracked in `ever-co/ever-gauzy`):** Jest — `packages/plugins/auth-zitadel/src/lib/specs/{handoff,link.explicit}.spec.ts`,
  the `auth-zitadel-ui` components' specs and the extended
  `packages/ui-auth/src/lib/components/social-links/social-links.component.spec.ts`; Playwright —
  `apps/gauzy-e2e/tests/ever-id-signin-start.har.spec.ts` (the recorded sign-in start carries no e-mail and no token)
  beside the existing `apps/gauzy-e2e/tests/login.smoke.spec.ts`.

### 5.3 MCP authorization server (last within P3)

- `packages/auth/src/lib/mcp/server/oauth-authorization-server.ts`: optional `federatedLogin` configuration
  adding `GET /oauth2/login/ever-id` and its callback beside the e-mail/password `loginEndpoint`; on success the
  pair resolves a Gauzy user through `zitadel_account` (a workspace choice page when there are several) and
  the pending authorization request continues exactly as after `userAuthenticator` succeeds.
- `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.ts`: wires it from `MCP_AUTH_EVER_ID_ENABLED` (default
  `false`) and the Gauzy client settings. The e-mail/password login stays the default. This is its own, later change.
- **Tests (tracked in `ever-co/ever-gauzy`):** `packages/auth/src/lib/mcp/server/oauth-authorization-server.ever-id.spec.ts`
  and `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.spec.ts` (Jest, `apps/mcp-auth/jest.config.ts`).

### 5.4 P3 rollout

Gauzy development → stage (`ZITADEL_ENABLED=true`, then `ZITADEL_AUTH_LINK` for the button) → **owner-supervised**
production: first the plugin loaded with `ZITADEL_AUTH_LINK` unset (server-side only, no button), then the button —
for Gauzy Cloud and Teams Cloud in the same change, because they share the API and the database; then, separately,
`MCP_AUTH_EVER_ID_ENABLED=true`. Before each production step: backups verified per the operations runbook, the
migration rehearsed on a production-sized copy, a shared cache for the hand-off keys on multi-replica deployments, and
existing e-mail/password, magic code and every configured social sign-in exercised end to end. Rollback is unsetting
`ZITADEL_ENABLED` (the plugin unloads; the additive tables stay).

## 6. Flags and configuration

| Platform   | Name                                                                                                                                    | Default    | Fail mode | Meaning                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------ |
| Ever Works | `oidc-identity` plugin, turned on by a platform administrator; `ever-id` rollout flag                                                   | off        | closed    | UI rollout / API kill switch ([`plan.md`](./plan.md) §6.4, §9.2)                                 |
| Ever Gauzy | `ZITADEL_ENABLED`                                                                                                                       | unset      | closed    | loads the `auth-zitadel` plugin: every Ever ID route, table use and outbound request             |
| Ever Gauzy | `ZITADEL_AUTH_LINK` (web app setting)                                                                                                   | empty      | hidden    | Gauzy's own "Sign in with Ever ID" button; empty means the server side can ship first            |
| Ever Gauzy | `ZITADEL_LINK_MODE`                                                                                                                     | `explicit` | closed    | `confirmed` only on Ever's hosted Gauzy and Teams (§2 rule 2)                                    |
| Ever Gauzy | `ZITADEL_SIGNUP_ENABLED`                                                                                                                | `false`    | closed    | the explicit sign-up path on Ever's hosted Gauzy and Teams; ignored on self-hosted installs      |
| Ever Gauzy | `ZITADEL_JIT_PROVISIONING`                                                                                                              | `false`    | closed    | silent account creation — stays off everywhere                                                   |
| Ever Gauzy | `ZITADEL_BACKCHANNEL_LOGOUT_ENABLED`                                                                                                    | `true`     | on        | the sign-out notice route while the plugin is loaded; only a strict `'false'` turns it off       |
| Ever Gauzy | `MCP_AUTH_EVER_ID_ENABLED`                                                                                                              | `false`    | closed    | federated login on the MCP authorization server                                                  |
| Ever Gauzy | `ZITADEL_ISSUERS`, `ZITADEL_CLIENT_ID`, `ZITADEL_CLIENT_SECRET` (secret), `ZITADEL_CALLBACK_URL`, `ZITADEL_ALLOWED_AUDIENCES`           | unset      | closed    | verification and client settings (values, not switches)                                          |
| Ever Gauzy | `KEYCLOAK_*` (existing names, unchanged), `KEYCLOAK_AUTH_LINK` (web app setting)                                                        | unset      | hidden    | the Keycloak plugin's sign-in routes and button exist only when the client id and secret are set |
| Ever Teams | `NEXT_PUBLIC_EVER_ID_APP_NAME`, `EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID`, `EVER_ID_CLIENT_SECRET` (secret), `EVER_PLATFORM_PROJECT_ID` | unset      | hidden    | provider advertised only when the name, issuer and client are all set; demo mode hides it        |
| Ever Teams | `EVER_ID_TEAMS_AUTO_PROVISION`                                                                                                          | `false`    | closed    | a self-hoster's opt-in: Teams' sign-up for an Ever ID with no workspace, after a confirmation    |

## 7. Acceptance per platform (gates spec ACC-12-40)

Each id's tests are **tracked in the named repository**, not in the Ever Works monorepo; paths are relative to that
repository's root on `develop` (layout read on 2026-10-01: Ever Teams — Jest `*.test.ts(x)` beside the source and
Cypress in `apps/web/cypress/e2e/`; Ever Gauzy — Jest `*.spec.ts` beside the source, API end-to-end specs in the new
`apps/api/src/e2e/`, and Playwright in `apps/gauzy-e2e/tests/`). Files marked "existing" already exist there; every
other file is new in that task.

**Ever Teams (P2)**

- [ ] **XP-T-01** A Teams user linked to an Ever ID signs in with it and lands in the same workspace and team they reach with their usual method.
      _Tests (tracked in `ever-co/ever-teams`):_ `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (linked user → usual
      workspace and team); `apps/web/core/services/server/requests/o-auth.ever-id.test.ts` (for provider `ever-id` the
      `id_token` goes to `POST /api/auth/zitadel/token` and Gauzy's tokens stay in the existing cookies). _Tracked in
      `ever-co/ever-gauzy`:_ `packages/plugins/auth-zitadel/src/lib/specs/token.spec.ts` and
      `apps/api/src/e2e/zitadel.token.e2e.spec.ts` (a linked pair returns the linked workspaces). Task T35, T36.
- [ ] **XP-T-02** An unlinked Ever ID signs nobody in and creates no Gauzy user, tenant or social account unless the person explicitly signs up.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/plugins/auth-zitadel/src/lib/specs/no-silent-link.spec.ts`
      (`explicit` mode, an existing user with the same verified e-mail → `no_workspace`, zero rows written) and
      `packages/plugins/auth-zitadel/src/lib/specs/signup.spec.ts` (sign-up off or a self-hosted install → zero users; no
      confirmation → zero users). _Tracked in `ever-co/ever-teams`:_
      `apps/web/core/services/server/requests/o-auth.ever-id.test.ts` (`GauzyAdapter` `createUser` and `linkAccount` are
      no-ops for `ever-id`; with `EVER_ID_TEAMS_AUTO_PROVISION` on, `createUser` runs only after the sign-up is confirmed;
      `no_workspace` and `signup_required` handled). Task
      T35, T36.
- [ ] **XP-T-03** Explicit linking needs a signed-in session, `auth_time` ≤ 300 s and a confirmation; the confirmed link on Ever's hosted Gauzy and Teams needs no session but writes nothing before the e-mailed code is accepted.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/plugins/auth-zitadel/src/lib/specs/link.explicit.spec.ts`
      (`auth_time` 300 s accepted, 361 s refused with `reauth_required`; other workspaces' rows only when chosen and proved;
      unlinking the last sign-in method → 409) and `packages/plugins/auth-zitadel/src/lib/specs/link.confirmed.spec.ts`
      (nothing written before `/confirm`; five wrong codes → 410). _Tracked in `ever-co/ever-teams`:_
      `apps/web/app/api/auth/ever-id/confirm/route.test.ts` (the code is forwarded, never placed in an address). Task T35,
      T36.
- [ ] **XP-T-04** A sign-out notice from Ever ID revokes the Gauzy tokens that sign-in issued; the Teams session ends on its next API call; password sessions are untouched.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/plugins/auth-zitadel/src/lib/specs/backchannel.spec.ts`
      (revokes only the tokens of that `sid`'s sessions; other sessions untouched; reused `jti` or `iat` over 300 s → 400).
      _Tracked in `ever-co/ever-teams`:_ `apps/web/app/api/auth/ever-id/backchannel-logout/route.test.ts` and
      `apps/web/core/lib/auth/ever-id/logout-token.test.ts` (a valid token is forwarded to Gauzy and answered 200; a
      malformed token → 400; a duplicate delivery is de-duplicated). Task T35, T36.
- [ ] **XP-T-05** No Ever ID or Gauzy token appears in any address, log line or `localStorage` entry.
      _Tests (tracked in `ever-co/ever-teams`):_ `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (every visited URL, console
      entry and `localStorage` value scanned for the minted tokens, with a planted control). _Tracked in
      `ever-co/ever-gauzy`:_ `packages/plugins/auth-zitadel/src/lib/specs/handoff.spec.ts` (no JWT in any `Location`
      header). Task T36, T37.
- [ ] **XP-T-06** With `ZITADEL_ENABLED` unset, no Ever ID route exists on Gauzy and every existing Teams sign-in test passes unchanged.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `apps/api/src/e2e/preservation.e2e.spec.ts` (every existing sign-in route
      answers identically with the plugin loaded and unloaded; `/api/auth/zitadel/config` → 404 when unset, `'false'`,
      `'TRUE'` or `'1'`). _Tracked in `ever-co/ever-teams`:_ `apps/web/test/architecture/ever-id-provider-off.test.ts`
      (provider absent and new routes 404 with the env unset); existing `apps/web/core/hooks/auth/use-authentication-passcode.test.tsx`,
      `apps/web/app/api/auth/register/route.test.ts` and `apps/web/core/lib/utils/check-provider-env-vars.test.ts`
      (Ever ID hidden unless advertised and configured). Task T35, T36.

**Ever Gauzy (P3)**

- [ ] **XP-G-01** Gauzy web sign-in with Ever ID lists only workspaces whose user is linked to the pair.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `apps/api/src/e2e/zitadel.token.e2e.spec.ts` and the `auth-zitadel-ui`
      hand-off page's spec (two linked workspaces listed, a third workspace with the same e-mail but no link absent; the page
      redeems the key and opens the existing workspace picker). Task T40.
- [ ] **XP-G-02** The hand-off key is single-use and expires after 60 s.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/plugins/auth-zitadel/src/lib/specs/handoff.spec.ts` (second
      redemption → 410; 61 s → 410). Task T39.
- [ ] **XP-G-03** The callback address never contains a JWT, refresh token, user ID or e-mail.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `packages/plugins/auth-zitadel/src/lib/specs/handoff.spec.ts` (every
      redirect is `#/auth/ever-id…?handoff=<32-byte key>` only, asserted against a JWT pattern, the issued refresh token and
      the user id); `apps/gauzy-e2e/tests/ever-id-signin-start.har.spec.ts` (no `@` and no `login_hint` in the recorded
      start). Task T39.
- [ ] **XP-G-04** With `ZITADEL_ENABLED` unset or `ZITADEL_AUTH_LINK` empty, no Ever ID button renders; with the plugin unloaded `GET /api/auth/zitadel` answers not found.
      _Tests (tracked in `ever-co/ever-gauzy`):_ `apps/api/src/e2e/preservation.e2e.spec.ts` (routes absent while unloaded);
      existing `packages/ui-auth/src/lib/components/social-links/social-links.component.spec.ts`, extended (no Ever ID entry
      unless the link is set and `/config` says `enabled`). Task T39, T40.
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

- **Account creation from Ever ID in Teams and Gauzy.** Settled for now: only the explicit sign-up of §2 rule 2, and only
  on Ever's hosted Gauzy and Teams; silent creation stays off everywhere.
- **Multi-audience tokens vs token exchange** for Teams → Gauzy and Teams → Ever Works — decided with the
  identity provider ([`idp-options.md`](./idp-options.md) §6). The token route of §4.1 accepts an ID token issued to an
  allowed client, so Teams needs no exchange to sign in to Gauzy.
- **A Connect entry inside Teams settings** that drives Gauzy's link routes, for Teams installations without the Gauzy
  web app.
- **Ever Rec and other Ever apps.** Not covered; the same model applies when they adopt.
- **Gauzy self-hosters** who already use the Keycloak or Auth0 strategies: document that Ever ID's generic
  library can point at their own provider, without changing theirs. Ever ID's own provider is **ZITADEL**
  (`idp-options.md` §6) — a self-hoster's Keycloak realm is neither required nor touched.
