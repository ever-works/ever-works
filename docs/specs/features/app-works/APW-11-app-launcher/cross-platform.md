# APW-11 — mounting the launcher inside another Ever platform (P2)

> Named by [APW-12 T53](../APW-12-ever-id/tasks.md) so the mount is not unnamed. This file is APW-11's half of
> the P2 handshake: **the component and the mount are APW-11's**, the **token the host hands it is APW-12's**
> ([`../APW-12-ever-id/cross-platform.md`](../APW-12-ever-id/cross-platform.md) §4.2, T37). Nothing here is built
> in P1, and nothing here changes a P1 behaviour — P2 is defined by [`spec.md`](./spec.md) FR-45…FR-52 and
> [`plan.md`](./plan.md) §4.7, §6.1–§6.5, §11.

## 1. Which platform first

**Ever Teams** is the first host, for the reason APW-12 gives: its users already authenticate against the Gauzy
API slice, so the delegated token has a place to come from. **Ever Gauzy** follows in Wave 3 with its own
adoption plan (APW-12 §5). Both mounts are changes in those platforms' own repositories
(`ever-co/ever-teams`, `ever-co/ever-gauzy`) and land as coordinated pull requests — the launcher package is
published first (T28), then each host adds one element and one token route.

## 2. What the host adds

| Piece              | Host-side change                                                                                                                                                                                                                                       | Owner                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| The component      | The published `@ever-works/app-launcher` (T28) as a dependency, loaded **client-side only** (`dynamic`/lazy import) so the host's SSR never touches `customElements`.                                                                                  | APW-11                                           |
| The mount          | One `<ever-app-launcher>` element in the host's header, with `current="<host platform id>"`, `environment`, `catalog-url`, `apps-url` and `sign-in-available`.                                                                                         | APW-11 T53's Done-when, in the host's repository |
| The token          | A **server-only** route in the host that returns a delegated Ever ID access token scoped `apps:read`, audience `ever-works` — Ever Teams' route is APW-12 T37; the token lives only in the host's encrypted session, never in a URL or `localStorage`. | APW-12                                           |
| The sign-in action | What the element calls for S6's **Sign in** button; when the host provides none, the element omits the prompt (FR-48).                                                                                                                                 | APW-11                                           |

The element contract itself is [`plan.md`](./plan.md) §6.2 — no host reads any other API, and no host-side
code is needed to render **Ever apps**.

## 3. What crosses the boundary, and what never does

- **The platform list is public.** `GET /api/app-launcher/platforms` is `@Public()`, carries
  `Cache-Control: public, max-age=3600` and `Access-Control-Allow-Origin: *` **without** credentials (FR-37,
  plan §4.3). A signed-out visitor on any page can render **Ever apps**.
- **The person's apps never travel on a cookie.** The component reads `apps-url` with
  `Authorization: Bearer <delegated token>` and never sends `credentials: 'include'` (FR-36, plan §6.1,
  T24) — an Ever Works session cookie is meaningless in a Teams page and must never be sent from one.
- **The API accepts a delegated read only from an allow-listed origin**, at most 50 exact `https` origins in
  `EVER_WORKS_APP_LAUNCHER_ORIGINS` (FR-50, [CONTRACTS §7](../CONTRACTS.md)). Everything else gets no CORS
  headers, and the browser blocks the read (S22). The middleware sets `Access-Control-Allow-Origin: <origin>`,
  `Vary: Origin` and `Access-Control-Allow-Headers: Authorization`, and **never**
  `Access-Control-Allow-Credentials` (plan §4.7, T26).
- **Delegated access is read-only.** `@DelegatedRead('apps:read')` sits on the `GET` only; the `PUT` has no such
  metadata, so the guard never verifies a delegated token there and answers `401` (FR-49, plan §4.5, T25).
- **Nothing is written from the host.** Arrangement and exposure stay in Ever Works; the signed-in panel's
  footer link reads **Manage apps in Ever Works** (spec §6.5).
- **The person's language travels as strings.** The host passes translated strings through the `strings`
  property; the element never invents copy, and the no-sign-on rule of
  [`no-sso-terms-draft.md`](./no-sso-terms-draft.md) applies to the host's own strings around it too.

## 4. What the person sees

- **Signed out of Ever ID.** **Ever apps** renders with the host platform marked **You're here**, and **Your
  apps** is replaced by `Sign in with Ever ID to see your apps here.` + **Sign in** (S6, FR-48). No request
  carrying an Ever Works session is made from the host page.
- **Signed in.** The same three sections as in Ever Works — **Pinned**, **Ever apps**, **Your apps** — with the
  same tiles, the same order, the same pins and the same hidden items (S7, FR-49). Read-only.
- **Ever ID unavailable.** Treated exactly as signed out; the component never falls back to cookies (plan §9.2).
- **The platform list unreachable.** The component renders the last good list it stored in that browser within
  7 days; with none, it renders S9's message and **Try again** (FR-51).

## 5. How it is verified

| Check                                                                                                                                                 | Where                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The same component renders in an Angular, a React and a Solid page and in plain HTML, with no style leaking into the host                             | `apps/web/e2e/app-launcher-cross-framework.spec.ts` (T27, ACC-11-34) |
| Signed out, no request carries the Ever Works session cookie; with a delegated token, **Your apps** equals the Ever Works panel and cannot be changed | T24/T25 specs (ACC-11-36, ACC-11-37)                                 |
| A non-allow-listed origin is refused and the signed-out state renders                                                                                 | T26 spec (ACC-11-38)                                                 |
| A token in a query string is refused, not ignored                                                                                                     | APW-12's `NoTokenInQueryGuard` (T25 test)                            |
| The host mount itself renders live tiles for a signed-in person                                                                                       | APW-12 T53, in `ever-co/ever-teams`                                  |

## 6. Open items this file does not decide

- **The published package's repository and npm scope** — the owner's decision (README §8 question 7; spec §9
  question 2), with a names-only publish credential, before T28 can finish.
- **The host's allow-listed origin** — added to `EVER_WORKS_APP_LAUNCHER_ORIGINS` per environment by the
  operator, not by this epic; the value is deployment configuration.
- **Whether a host shows the launcher on a public marketing page** — spec §9 question 4; P1 assumes dashboards
  only, and P2's public platform list already makes either answer additive.
