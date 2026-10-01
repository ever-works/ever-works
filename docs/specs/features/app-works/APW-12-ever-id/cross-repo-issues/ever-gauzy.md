# [Ever ID] Optional sign-in with Ever ID, as a plugin, default off

**Epic**: APW-12 (Ever Works) · **Wave**: 3 (P3, production last) · **Tracking**: tasks T35, T39, T40, T41, T42 in
[`../tasks.md`](../tasks.md) · **Design**: [`../cross-platform.md`](../cross-platform.md) §5

> **Re-verify before filing.** Paths below were read on `develop` on 2026-09-17. Gauzy is the only production
> platform, so this issue is deliberately conservative: server-side first, default off, its own review, and the
> production flag in a separate owner-approved change with backups verified first.

## What and why

People who use several Ever products should be able to arrive at Gauzy already knowing who they are, without
Gauzy giving up its own accounts. Ever ID is an **addition**:

- Gauzy keeps e-mail/password, magic code and every social strategy exactly as they are.
- Gauzy keeps its own user database and its own sessions; a person may exist in both, and nothing is merged.
- With the flags off, Gauzy behaves exactly as it does today — including every existing test.

## Scope

1. **A provider plugin, not core.** A new `packages/plugins/<name>` (`@gauzy/plugin-*`) exporting a NestJS module
   that carries its own Passport strategy over a generic OpenID Connect client, its own guard, its own
   controller and its own configuration (`EVER_ID_ISSUER`, `EVER_ID_GAUZY_CLIENT_ID`,
   `EVER_ID_GAUZY_CLIENT_SECRET`, callback under `${API_BASE_URL}/api/auth/ever-id/callback`). Registered by
   **one import plus one array entry in `apps/api/src/plugins.ts`**. `packages/core`,
   `packages/auth/src/lib/internal.ts` and `packages/config` are **not** edited.
2. **Server-side sign-in, default off.** `FEATURE_EVER_ID_API`, evaluated strictly as `'true'` inside the plugin.
3. **Web sign-in with a code hand-off.** The callback redirects with a one-time code — never a token, never a
   session id — which the web exchanges on the same origin. Existing `routeRedirect` behaviour is untouched.
4. **Connect / disconnect** for an existing Gauzy user, on the profile page, with the same two decisions Ever
   Works has.
5. **Back-channel logout**, ending only the sessions Ever ID opened.
6. **MCP authorization server sign-in** through Ever ID, behind `MCP_AUTH_EVER_ID_ENABLED`, in its own change.
7. **The provider-plugin family** (`zitadel`, `keycloak`, `supertokens`, `auth0`) ships alongside: each is
   optional, independent, enabled by its own configuration and fails closed when unconfigured. The shipped
   Keycloak code is **relocated into its plugin with behaviour unchanged** — same exports, same `'disabled'`
   defaults, same routes — so a self-hoster who uses Keycloak today notices no difference. A **SuperTokens**
   plugin is added ("not to replace anything") so a self-hoster can run Gauzy with SuperTokens exactly as they
   can with Keycloak today.

## Acceptance

- The criteria in [`../cross-platform.md`](../cross-platform.md) §7 under `XP-G-01`…`XP-G-06`, each mapped to the
  test file named there.
- Existing suites pass **unchanged** with the flags off and on: the login smoke test, the login BDD feature and
  every configured social sign-in.
- The callback URL contains no token, no code belonging to another session, and no user identifier.

## Production gate (separate change)

Backups verified per the operations runbook; every existing sign-in method exercised on stage before and after;
owner approval recorded; `FEATURE_EVER_ID_LOGIN=true` in production — and `MCP_AUTH_EVER_ID_ENABLED=true` in a
further separate change. Rollback is a flag flip.

## Out of scope

- Replacing, deprecating or reordering any existing sign-in method.
- Migrating accounts, merging profiles or synchronising profile fields with Ever ID.
- Any behaviour change to the shipped Keycloak strategy beyond its relocation into a plugin.
