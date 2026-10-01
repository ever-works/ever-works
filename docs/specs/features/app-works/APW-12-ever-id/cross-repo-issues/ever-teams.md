# Draft issue for `ever-co/ever-teams` — sign in with Ever ID, off by default

**Epic**: APW-12 (Ever Works) · **Tracking**: tasks T36, T37, T38 in [`../tasks.md`](../tasks.md) · **Design**:
[`../cross-platform.md`](../cross-platform.md) §4 · **Filed as**: see the table in [`README.md`](./README.md)

Everything under **Issue body** is the text filed in `ever-co/ever-teams`. Its links are absolute because the issue
lives in another repository; paths were verified on `develop` at `e6ebffadb` (2026-10-01).

**Issue title**: `Sign in with Ever ID: an optional provider, off by default`

---

## Issue body

### What and why

Ever Teams gains an **additional** way to sign in — **Ever ID** — next to the existing options. Nothing about the
current sign-in changes, and with the provider's settings unset Teams behaves exactly as it does today.

Teams has no user store of its own: every account is a Gauzy user. The accounts, the Ever ID links and the sign-out
handling therefore live in the Gauzy API Teams talks to — its `auth-zitadel` plugin (companion issue
ever-co/ever-gauzy#10368). Teams adds the provider, the button and three small routes.

The full contract, with every route, flag and test file:
[Ever ID — adoption by Ever Teams and Ever Gauzy](https://github.com/ever-works/ever-works/blob/develop/docs/specs/features/app-works/APW-12-ever-id/cross-platform.md),
§4.

### Scope

1. **Provider** — in `apps/web/core/lib/utils/check-provider-env-vars.ts`, a generic Auth.js OpenID Connect provider
   `ever-id` (PKCE and `state`, ID token kept), filtered like the other providers: advertised by
   `NEXT_PUBLIC_EVER_ID_APP_NAME` **and** configured. `EProvider.EVER_ID = 'ever-id'` in
   `apps/web/core/types/generics/enums/social-accounts.ts`; the server-only settings in
   `apps/web/core/constants/config/constants.tsx`, `apps/web/.env.sample`, `.env.docker`, the compose files and the
   `turbo.json` env list.
2. **Button** — an Ever ID entry in `apps/web/core/components/auth/social-logins-buttons.tsx` (icon in
   `apps/web/core/components/icons/icons.tsx`), after Google; hidden in demo mode like the other social buttons.
3. **Sign-in** — `apps/web/auth.ts` and `apps/web/core/services/server/requests/o-auth.ts` pass the provider's ID token
   as well; for `ever-id` a new `signWithEverIdRequest(id_token)` in `apps/web/core/services/server/requests/auth.ts`
   posts it to Gauzy's `POST /api/auth/zitadel/token`, and sign-in continues exactly as today through the workspace
   chooser and `signInWorkspace` — Gauzy's tokens, the same cookies.
4. **Code confirmation** — when Gauzy answers `confirm_required`, the existing passcode page posts the e-mailed code to
   a new `apps/web/app/api/auth/ever-id/confirm/route.ts`, which forwards it to Gauzy.
5. **Explicit sign-up** — when Gauzy answers `signup_required` (only on Ever's hosted deployments), the person lands on
   the existing sign-up page with a one-time hand-off key (new `apps/web/app/api/auth/ever-id/signup-handoff/route.ts`;
   no e-mail and no token in the address) and, after confirming, Teams posts its usual sign-up fields to Gauzy.
6. **No workspace** — the error page explains that no workspace is linked to this Ever ID yet. A self-hosted Teams may
   opt in with `EVER_ID_TEAMS_AUTO_PROVISION` set to `'true'` (default off): the page then offers the existing sign-up,
   and `GauzyAdapter.createUser` runs only after the person confirms it there — never silently from the sign-in.
   `getUserByAccount` / `linkAccount` do nothing for `ever-id`.
7. **Back-channel logout** — a new `apps/web/app/api/auth/ever-id/backchannel-logout/route.ts` verifies the logout token
   and forwards it to Gauzy, which revokes the tokens (a malformed token is answered `400`, a valid one `200`); the next
   API call then ends the Teams session.

### Settings (runtime environment, nothing baked into the image)

| Name                                                                           | Default | Meaning                                                         |
| ------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------- |
| `NEXT_PUBLIC_EVER_ID_APP_NAME`                                                 | unset   | advertises the provider; unset hides the button                 |
| `EVER_ID_ISSUER_URL` (`EVER_ID_ISSUER` still read, with a deprecation warning) | unset   | the issuer                                                      |
| `EVER_ID_CLIENT_ID`, `EVER_ID_CLIENT_SECRET`                                   | unset   | the client Teams is registered as                               |
| `EVER_PLATFORM_PROJECT_ID`                                                     | unset   | optional; adds that project's audience scope                    |
| `EVER_ID_TEAMS_AUTO_PROVISION`                                                 | `false` | a self-hoster's opt-in: offer the sign-up, after a confirmation |

### Acceptance

- The Teams halves of `XP-T-01`…`XP-T-06` in §7 of the contract, each mapped to the test file named there.
- Every existing sign-in test in this repository passes **unchanged** with the provider's settings unset and set; an
  architecture test proves the provider and the new routes are absent while the settings are unset.
- No token appears in any URL, log line, error message or `localStorage` entry.

### Out of scope

- Ever ID as a replacement for any existing method, account merging, or profile synchronisation.
- A Connect page inside Teams settings (accounts are linked on Gauzy's Connected identities page for now) and the App
  Launcher's token route — both later, separate changes.
