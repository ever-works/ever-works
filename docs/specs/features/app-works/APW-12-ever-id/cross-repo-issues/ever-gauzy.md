# Draft issue for `ever-co/ever-gauzy` — sign in with Ever ID, as a plugin, off by default

**Epic**: APW-12 (Ever Works) · **Tracking**: tasks T35, T39, T40, T41, T42 in [`../tasks.md`](../tasks.md) ·
**Design**: [`../cross-platform.md`](../cross-platform.md) §4.1 and §5 · **Filed as**: see the table in
[`README.md`](./README.md)

Everything under **Issue body** is the text filed in `ever-co/ever-gauzy`. Its links are absolute because the issue
lives in another repository; paths were verified on `develop` at `84a527d85` (2026-10-01).

**Issue title**: `Sign in with Ever ID: an optional auth-zitadel plugin, off by default`

---

## Issue body

### What and why

People who use several Ever products should be able to sign in to Gauzy with one **Ever ID**, while Gauzy keeps its
own accounts. Ever ID is an **addition**:

- Gauzy keeps e-mail/password, magic code and every social strategy exactly as they are.
- Gauzy keeps its own user database and its own sessions; a person may exist in both, and nothing is merged.
- With the plugin unloaded (the default) Gauzy behaves exactly as it does today, including every existing test.

Ever Teams signs in through Gauzy's API, so the same plugin also gives Ever Teams its Ever ID sign-in (companion issue
in `ever-co/ever-teams`).

Implementation in progress: #10362.

The full contract, with every route, flag and test file:
[Ever ID — adoption by Ever Teams and Ever Gauzy](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-12-ever-id/cross-platform.md),
§4.1 and §5.

### Scope

1. **A shared OpenID Connect library**, `packages/auth/src/lib/oidc/`: discovery, a JWKS cache with `jose`, PKCE, a
   signed-cookie transaction for `state` and `nonce`, ID-token and logout-token validation. It is registered nowhere
   and knows no provider.
2. **One plugin: `packages/plugins/auth-zitadel`** (`@gauzy/plugin-auth-zitadel`), named after the provider. It holds
   the entities, services, controller, DTOs and specs, and is registered by **one import plus one conditional entry**
   in `apps/api/src/plugins.ts`:
   `...(process.env['ZITADEL_ENABLED'] === 'true' ? [AuthZitadelPlugin] : [])`. Gauzy core's sign-in code,
   `packages/config`, `FeatureEnum` and `packages/contracts` gain nothing for Ever ID.
3. **Four tables, owned by the plugin**: `zitadel_account` (the link: issuer, subject, user, link method),
   `zitadel_organization`, `zitadel_session` and `zitadel_logout_jti`. Until Gauzy plugins can carry their own
   migrations (#10254), the one migration lives in core's migration directory — hand-written for PostgreSQL, MySQL and
   SQLite, `CREATE TABLE IF NOT EXISTS`, with `down` and no per-tenant loop — and the plugin's `MIGRATIONS.md` lists it.
   `social_account` and `ProviderEnum` are untouched.
4. **Routes under `/api/auth/zitadel`**: `config`; the sign-in start and callback (PKCE, `state` and `nonce`; a
   verified e-mail is required); a one-time hand-off key redeemed by `POST` (60 s, single use) that returns the usual
   workspace list, after which the **existing** `POST /auth/signin.workspace` issues Gauzy's usual tokens; explicit
   linking from Settings (fresh sign-in, both e-mails shown, other workspaces' rows only with Gauzy's own e-mailed code),
   unlinking and the identity list; the token route for the Ever Teams and Ever Works clients (an ID token verified
   locally against an audience allow-list, no userinfo call); and back-channel logout (`400` for a token that fails
   validation, `200` once a valid token is accepted).
5. **No silent linking by e-mail.** Linking is explicit by default. Ever's hosted deployments may select
   `ZITADEL_LINK_MODE=confirmed`, which links an unlinked Ever ID to the existing users with the same verified e-mail
   only after the person enters the one-time code Gauzy sends to that mailbox.
6. **No account from Ever ID without an explicit sign-up.** Only Ever's hosted deployments may offer one
   (`ZITADEL_SIGNUP_ENABLED`): the person confirms, and Gauzy's own register path and subscription check create the
   workspace. Self-hosted installations never create accounts from Ever ID, and `ZITADEL_JIT_PROVISIONING` stays
   `false`.
7. **Web**: `ZITADEL_AUTH_LINK` in `packages/ui-config/src/lib/environments/model.ts` and one more `socialLinks` entry
   in `packages/ui-core/core/src/lib/auth/auth.module.ts`, labelled "Sign in with Ever ID" and shown only when the link
   is set and the plugin says it is enabled; an optional `packages/plugins/auth-zitadel-ui` (registered in
   `apps/gauzy/src/plugin-ui.config.ts`) with **Settings → Connected identities** and the hand-off, code and sign-up
   pages.
8. **Keycloak moves into `packages/plugins/auth-keycloak`** with the same strategy, guard, exports and `KEYCLOAK_*`
   names (`@gauzy/auth` keeps re-exporting every Keycloak symbol), and gains sign-in routes and a login button that exist
   only when Keycloak is configured (a real client id, secret and realm). Installations without it see no change.
9. **Later, in separate changes**: federated login on the MCP authorization server (`MCP_AUTH_EVER_ID_ENABLED`, default
   `false`), a SuperTokens plugin, and moving Auth0 into the same plugin shape.

### Flags (environment only, read once at boot)

| Name                                                                                                                 | Default    | Meaning                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| `ZITADEL_ENABLED`                                                                                                    | unset      | loads the plugin; unset or malformed means no route and no outbound call   |
| `ZITADEL_AUTH_LINK` (web app)                                                                                        | empty      | Gauzy's own button; empty lets the server side ship first                  |
| `ZITADEL_LINK_MODE`                                                                                                  | `explicit` | `confirmed` only on Ever's hosted deployments                              |
| `ZITADEL_SIGNUP_ENABLED`                                                                                             | `false`    | the explicit sign-up, honoured only on Ever's hosted deployments           |
| `ZITADEL_JIT_PROVISIONING`                                                                                           | `false`    | silent account creation, which stays off                                   |
| `ZITADEL_BACKCHANNEL_LOGOUT_ENABLED`                                                                                 | `true`     | sign-out notices while the plugin is loaded; only `'false'` turns them off |
| `ZITADEL_ISSUERS`, `ZITADEL_CLIENT_ID`, `ZITADEL_CLIENT_SECRET`, `ZITADEL_CALLBACK_URL`, `ZITADEL_ALLOWED_AUDIENCES` | unset      | settings; loaded without them the plugin reports itself unconfigured       |

### Acceptance

- The Gauzy criteria `XP-G-01`…`XP-G-06` and the Gauzy halves of `XP-T-01`…`XP-T-06` in §7 of the contract, each mapped
  to the test file named there.
- A preservation snapshot: every existing sign-in route (`/auth/login`, `/auth/signin.email*`, `/auth/signin.workspace`,
  `/auth/switch-*`, `/auth/refresh-token`, `/auth/register`, `/auth/signin.email.social`, `/auth/signup.*`,
  `/auth/logout`, invites, the OAuth app routes and MCP sign-in) answers identically with the plugin loaded and unloaded.
- The migration runs up, down and up again on PostgreSQL, MySQL and SQLite.
- No redirect carries a token, a user id or an e-mail; the recorded sign-in start carries no `login_hint`.

### Rollout

Development and stage first. Production is a separate, owner-supervised change: first the plugin loaded with no
button, then the button — for Gauzy Cloud and Ever Teams Cloud together, because they share this API and its database —
with backups verified, the migration rehearsed on a production-sized copy, a shared cache for hand-off keys on
multi-replica deployments, and every existing sign-in method exercised before and after. Rollback is unsetting
`ZITADEL_ENABLED`; the additive tables stay.

### Out of scope

- Replacing, deprecating or reordering any existing sign-in method.
- Migrating accounts, merging profiles or synchronising profile fields with Ever ID.
- Any change to `JwtStrategy`, the token payloads or the existing `/auth/*` routes.
