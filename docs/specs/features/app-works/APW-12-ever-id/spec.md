# Feature Specification: Ever ID

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-12-ever-id`
**Program**: [App Works](../README.md) — Wave 2 (P1) · Wave 3 (P2, P3)
**Branch**: `feat/apw-12-ever-id`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product · Security
**Size**: XL · **Depends on**: the owner decisions in [`idp-options.md`](./idp-options.md) (P1) ·
**Depended on by**: APW-11 P2 (the App Launcher reads a person's App Works from other Ever platforms)
**Companions**: [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md) · [`cross-platform.md`](./cross-platform.md)
(Ever Teams and Ever Gauzy adoption) · [`idp-options.md`](./idp-options.md) (identity provider decision record)

> **Additive-only (program rule #1).** Every sign-in method that ships today keeps working exactly as it
> does: email and password, magic link, anonymous start and claim, GitHub, Google, Facebook, LinkedIn,
> API keys, and the browser hand-off the command-line tool and nodes use. That local hand-off returns a
> session token inside a redirect; it is kept unchanged and **must not be extended** — this epic adds a
> replacement beside it and routes no new flow through it. Ever Works is **not** the identity root of any
> other platform (program decision D14).

> **Copy rule (launch-parity backlog G-09).** Until Ever ID is live for Ever Works in production, no page,
> document or UI string claims single sign-on in any form. After launch, copy says only what is true —
> "Sign in with Ever ID" and the Ever apps that accept it today — and never says "SSO" or "enterprise
> single sign-on", which remain G-09's to earn.

---

## 1. Overview

**Ever ID** is one identity a person uses across Ever platforms. It is a dedicated OpenID Connect identity
provider, operated separately from every Ever platform. Ever Works, Ever Teams and Ever Gauzy become
_relying parties_ of it and keep all of their current sign-in methods.

For Ever Works: a **Sign in with Ever ID** button; account creation after an explicit confirmation;
connecting from **Settings → Security → Connected identities** only while signed in and only after
confirming — never because two e-mail addresses match; disconnecting while another way to sign in remains;
sign-out at Ever ID ending the sessions it opened; terminal sign-in with a short code instead of a token in a
redirect; and a narrow, read-only permission that lets another Ever platform list the person's App Works in
the **App Launcher** — never a session.

## 2. Why now

### 2.1 The user's question

> _"I already have an Ever account over there. Why do I need another password here?"_

and, from inside Ever Teams:

> _"Show me the apps I built on Ever Works without making me sign in again."_

### 2.2 What they do today instead

| The need                               | What Ever platforms offer today                                                                                                                    | What the person actually does                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| One account across Ever apps           | Each platform keeps its own accounts. Ever Teams accounts are Ever Gauzy accounts; Ever Gauzy keeps one account per workspace.                     | Creates an account per platform, often with a different password. |
| Sign in the same way everywhere        | Each platform signs a Google or GitHub login into a local account on its own, each deciding separately which account an e-mail address belongs to. | Sometimes lands in an account they did not expect.                |
| Sign a terminal tool in                | A browser round-trip that returns the session to a local address, or typing an e-mail and password into the terminal.                              | Pastes credentials into terminals.                                |
| Let another Ever app list my App Works | API keys: full account powers, no narrower permission exists.                                                                                      | Nothing. Switches tabs.                                           |
| Sign out everywhere                    | Sign out of each platform separately.                                                                                                              | Leaves sessions open.                                             |

### 2.3 The gaps, all of them ours

1. **There is no identity shared across Ever platforms**, and Ever Works must not become one: it runs
   agents and user-controlled code, so it cannot be the root of trust for the production platform (D14).
2. **There is no narrow delegated permission.** The only machine credential Ever Works has can do
   everything its owner can do.
3. **E-mail matching is not a foundation for a shared identity.** A shared identity links accounts only when
   the person says so, while signed in to both sides.

### 2.4 What this epic changes

```
   BEFORE                                          AFTER
   ──────                                          ─────
   Ever Works ─ own login                          ┌──────────── Ever ID ────────────┐
   Ever Teams ─ own login (Gauzy accounts)         │  one identity · sign-out notices │
   Ever Gauzy ─ own login per workspace            └──┬──────────────┬─────────────┬──┘
                                                      │ relying party│             │
   terminal ── session token in a redirect         Ever Works    Ever Teams    Ever Gauzy (last,
   other app ── API key (everything) or nothing    (P1)          (P2)          behind a flag, P3)
                                                      │
                                                   terminal ── code on screen ── session in a body
                                                   App Launcher ── read-only "see your apps" permission
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Sign in with a connected Ever ID.** **Given** Ever ID is available and Alice's Ever Works account
  is connected to her Ever ID, **when** she clicks **Sign in with Ever ID** and completes sign-in at Ever ID,
  **then** she returns signed in to the page she was headed to, and Activity records "Signed in with Ever ID".
- **S2 — First visit, no Ever Works account.** **Given** an Ever ID whose e-mail address is verified and not
  used by any Ever Works account, **when** the person signs in with Ever ID, **then** a **Create your Ever
  Works account** screen shows the name and e-mail from Ever ID with the terms to accept; **Create account**
  creates the account, connects the Ever ID and signs them in. Closing the screen creates nothing.
- **S3 — The e-mail already belongs to an Ever Works account.** **Given** an unconnected Ever ID whose
  verified e-mail is used by an existing account, **when** the person signs in with Ever ID, **then** they see
  **"An Ever Works account already uses {email}. Sign in to it the way you usually do, then connect Ever ID
  in Settings → Security."** No account, no connection and no session are created.
- **S4 — Connect from Settings.** **Given** Bob is signed in with a session opened less than 12 hours ago,
  **when** he clicks **Connect Ever ID** and signs in again at Ever ID, **then** a confirmation names his
  Ever ID e-mail and his Ever Works e-mail, and **Connect** adds the identity to the **Connected identities**
  card.
- **S5 — Disconnect.** **Given** Bob has a password and a connected Ever ID, **when** he clicks
  **Disconnect** and confirms, **then** the identity is removed, every other session Ever ID opened for him
  ends, and his current session continues.
- **S6 — Signed out of Ever ID elsewhere.** **Given** Alice has two Ever Works sessions opened with Ever ID
  and one opened with her password, **when** she signs out of Ever ID in another Ever app, **then** both Ever
  ID sessions end within 5 seconds of Ever ID's notice, her next page load shows **"You were signed out of
  Ever ID."**, and the password session is untouched.
- **S7 — Sign out of Ever ID too.** **Given** a session opened with Ever ID, **when** Alice signs out and ticks
  **Also sign out of Ever ID** (unticked by default), **then** she is signed out at Ever ID as well and lands
  on the sign-in page with **"You're signed out of Ever Works and Ever ID."**
- **S8 — Terminal sign-in with a code.** **Given** a connected Ever ID, **when** Alice runs the command-line
  sign-in with the Ever ID option, **then** the terminal prints a web address and an 8-character code, she
  approves it at Ever ID, and within 5 seconds of approval the terminal prints **"Signed in as {email}."** No
  token appears in any address, browser history entry or terminal line.
- **S9 — Apps from another Ever platform.** **Given** Alice is signed in to Ever Teams with Ever ID, **when**
  she opens the App Launcher there, **then** Ever Teams obtains a read-only "see your apps" permission from
  Ever ID and lists her App Works; the same permission is refused by every other Ever Works endpoint.
- **S10 — An administrator configures Ever ID.** **Given** a platform administrator, **when** they enter the
  issuer address, client ID and client secret and press **Test connection**, **then** each check reports pass
  or fail within 5 seconds, and the secret is never displayed again.

### 3.2 Unhappy paths

- **S11 — Unverified Ever ID e-mail.** No account is created and nothing is connected: **"Verify your e-mail
  address with Ever ID first, then try again."**
- **S12 — Ever ID connected to another account.** Connecting returns **"This Ever ID is already connected to
  a different Ever Works account. Disconnect it there first."** — never which account.
- **S13 — Account already has an Ever ID.** **"This account already has an Ever ID connected. Disconnect it
  first."**
- **S14 — Disconnect would lock the person out.** No password they set, no other connected provider and an
  unverified account e-mail: **Disconnect** is disabled with **"Add another way to sign in first — Ever ID is
  the only one this account has."** and a **Set a password** action.
- **S15 — Session too old to connect.** **"For your security, sign in again before connecting Ever ID."** with
  **Sign in again**, which returns to Settings afterwards.
- **S16 — Ever ID is not responding.** After 5 seconds without an answer: **"Ever ID isn't responding. Try again
  in a minute, or sign in another way."** Other methods and existing sessions are unaffected.
- **S17 — Expired, tampered or replayed sign-in.** **"That sign-in expired or was already used. Start
  again."** No session.
- **S18 — An administrator turns Ever ID off.** The button disappears; the Connected identities card still
  lists connections and still offers **Disconnect**; sign-out notices from Ever ID are still honoured.
- **S19 — A token in an address.** A request carrying a token as a query parameter is refused before it is
  processed, and the token is written nowhere.
- **S20 — A delegated permission used out of bounds.** Any endpoint not marked for it answers "not
  authorised"; an expired permission is refused.
- **S21 — The same sign-in finished in two tabs.** The first completes; the second gets S17.
- **S22 — Deactivated account.** Ever ID sign-in shows the existing "account disabled" message; no session.
- **S23 — Terminal sign-in for an unconnected Ever ID.** **"Connect Ever ID to your Ever Works account in
  Settings → Security first."** The terminal never creates accounts.

### 3.3 Race and permission edges

- **S24 — Sign-up races a connection.** One browser creates an account from Ever ID X while another connects
  X to an existing account: exactly one succeeds; the other sees S12.
- **S25 — Disconnect from a session Ever ID opened.** The current session continues; other sessions opened by
  that identity end.
- **S26 — A sign-out notice for someone Ever Works does not know.** It is acknowledged and changes nothing.
- **S27 — An API key or a delegated permission tries to connect or disconnect.** Refused: only a signed-in
  person's session may change connected identities.

---

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 Availability and configuration

- **FR-1.** Ever ID sign-in is offered only when a platform administrator has enabled and configured an
  identity provider integration **and** the `ever-id` rollout flag is on for the viewer. A flag that cannot be
  evaluated is **off**; an installation with no rollout-flag service relies on the configuration alone.
- **FR-2.** Configuration holds: issuer address (`https`; `http` only for `localhost` outside production),
  client ID, client secret (write-only), 1–3 allowed issuers (exact strings), API audience (default
  `ever-works`), 0–5 local-client IDs allowed to exchange for a session, whether sign-up is allowed (default
  on), clock-skew tolerance (default 60 s, 0–120 s) and display name (default "Ever ID").
- **FR-3.** **Test connection** reads the provider's discovery document within 5 seconds and reports each
  check: issuer equals the configured issuer exactly; authorization, token and key-set endpoints present;
  code challenge method S256 supported; at least one signing algorithm from RS256, ES256, EdDSA; and whether
  back-channel logout and device authorization are supported. It never returns the secret.
- **FR-4.** Every configuration change is recorded in Activity with field names only.
- **FR-5.** Turning Ever ID off makes sign-in, sign-up, connect and local-client exchange answer "not found"
  within 60 seconds. Listing and disconnecting connections and sign-out notices keep working; existing
  sessions run until they expire or are signed out.
- **FR-6.** Every existing sign-in method, route and response is unchanged whether Ever ID is on or off. The
  providers list the web app reads gains one additive Ever ID availability field.
- **FR-7.** One issuer set per installation. Per-user, per-Organization and per-Work identity providers are
  out of scope.

### 4.2 Protocol security

- **FR-8.** Authorization code flow with PKCE S256 only. Implicit, hybrid, plain PKCE and password grants are
  never used.
- **FR-9.** Each sign-in carries a fresh `state` and `nonce` of at least 32 random bytes each and a
  64-character code verifier, bound to the browser by an HttpOnly, SameSite=Lax cookie (Secure on HTTPS) that
  lives 600 seconds and is cleared at the callback whatever the outcome.
- **FR-10.** Exactly one redirect address per deployment, derived from the configured public web address and
  registered at Ever ID as an exact string — never built from request input. The return path after sign-in
  must be a same-site relative path; anything else falls back to the dashboard.
- **FR-11.** An ID token is accepted only if: its signature verifies against Ever ID's published keys; its
  algorithm is RS256, ES256 or EdDSA; `iss` equals the configured issuer and is allow-listed; `aud` contains
  the client ID, and when `aud` has several values `azp` equals the client ID; `exp` is later than now minus
  the skew; `iat` is no later than now plus the skew and no earlier than 600 seconds ago; `nonce` matches;
  and `sub` is 1–255 characters.
- **FR-12.** When the authorization response carries `iss`, it must equal the configured issuer.
- **FR-13.** Signing keys are cached for 600 seconds. An unknown key ID triggers at most one refresh per 30
  seconds. While Ever ID is unreachable, cached keys stay usable for at most 21,600 seconds after the last
  successful refresh; after that, validation fails closed. A key Ever ID removes stops validating at the next
  successful refresh.
- **FR-14.** The discovery document is cached for 3,600 seconds. If its issuer ever differs from the
  configured issuer, sign-in turns off until an administrator re-tests.
- **FR-15.** Calls to Ever ID time out after 5 seconds. The code exchange is never retried; discovery and key
  fetches retry once after 1 second.
- **FR-16.** Tokens, codes, verifiers and nonces never appear in logs, Activity, analytics, error messages or
  responses. The only credential ever returned is the Ever Works session token, in a response body, exactly
  as other sign-in methods return it today.
- **FR-17.** Any Ever ID endpoint, and any endpoint accepting a delegated permission, refuses a request that
  carries an access token, ID token, logout token or session token as a query parameter with status 400.
- **FR-18.** Rate limits, answered with 429 and `Retry-After`: start sign-in 20/min per IP; callback 20/min
  per IP; confirm sign-up 10/min per IP; start connect 10/min per user; confirm connect 10/min per user;
  disconnect 10/hour per user; local-client exchange 10/min per IP; sign-out notices 60/min per IP; delegated
  apps reads 60/min per Ever ID subject.
- **FR-19.** A sign-in transaction completes at most once.
- **FR-20.** Ever ID sign-in never uses the e-mail-matching behaviour of the existing social providers.

### 4.3 Connected identities

- **FR-21.** A connected identity is the pair (Ever ID issuer, subject). A pair belongs to at most one Ever
  Works account; an account has at most one pair per issuer.
- **FR-22.** Sign-in finds the account by the pair only. An e-mail address never selects an account.
- **FR-23.** Unknown pair, `email_verified` true, sign-up allowed, and no account using that e-mail
  (case-insensitive): offer account creation (S2). Creating requires the confirmation screen and acceptance of
  every currently required terms document. The pending creation expires after 600 seconds and is single-use.
- **FR-24.** Unknown pair and the e-mail used by an existing account: S3. Unknown pair and `email_verified`
  missing or false: S11.
- **FR-25.** Connecting requires all of: a signed-in session (not an API key, not a delegated permission)
  opened at most 12 hours ago; a fresh Ever ID authentication, with `auth_time` no older than 300 seconds
  plus the skew; `email_verified` true; and the person's confirmation on a screen showing both e-mail
  addresses. When they differ, the screen says **"These e-mail addresses are different. Connect only if both
  are yours."**
- **FR-26.** A pending connection expires after 300 seconds and is single-use.
- **FR-27.** Conflicts answer S12 or S13 and reveal nothing about another account.
- **FR-28.** Disconnect is allowed only if the account keeps at least one working sign-in method afterwards:
  a password the person set, another connected social provider, or a verified account e-mail (which can
  always receive a password-reset link). Otherwise it is refused with S14.
- **FR-29.** Disconnecting ends every session that identity opened except the current one.
- **FR-30.** Deleting an account deletes its connected identities. Removing a connected identity never deletes
  an account.
- **FR-31.** Ever Works stores for each connected identity only: issuer, subject, the e-mail and its verified
  state at connection time, how it was connected (sign-up or settings), when it was connected, when it last
  signed in, and the last-seen time of at most 10 apps that used a delegated permission. **No Ever ID token is
  stored.**

### 4.4 Sessions and sign-out

- **FR-32.** A session opened with Ever ID lives as long as any other session: 7 days. It records its
  connected identity and Ever ID's session identifier when Ever ID provides one.
- **FR-33.** Ever ID sign-out notices (OpenID Connect back-channel logout) are accepted at one public endpoint
  and validated like FR-11 and FR-13, plus: `iat` within the skew and no older than 300 seconds; the
  back-channel logout event present; no `nonce`; `sid` or `sub` present; and a `jti` not seen in the last 600
  seconds.
- **FR-34.** A valid notice with `sid` ends the sessions carrying it; with `sub` only, it ends every session
  that pair opened. Sessions end within 5 seconds and the answer is 200 with `Cache-Control: no-store`. An
  invalid notice answers 400 with no detail; a notice for an unknown `sid` or `sub` answers 200 and changes
  nothing.
- **FR-35.** A sign-out notice never ends a session opened by another method.
- **FR-36.** When the current session was opened with Ever ID, signing out offers **Also sign out of Ever ID**,
  unticked by default. Ticked, the person is sent to Ever ID's sign-out with a validated `state` and returns
  to the sign-in page.
- **FR-37.** The existing "sign out of all devices" also ends sessions Ever ID opened.
- **FR-38.** Ever Works never stores Ever ID refresh tokens in P1.

### 4.5 Local clients

- **FR-39.** The command-line tool and nodes can sign in with device authorization: they show Ever ID's
  verification address and user code; the person approves at Ever ID; the client exchanges the resulting Ever
  ID access token at Ever Works for an Ever Works session returned in a response body.
- **FR-40.** The exchange accepts a token only if: its issuer is allow-listed; its audience contains the API
  audience; its scope contains the session-exchange scope; its authorised party is one of the configured
  local-client IDs; `iat` is no older than 300 seconds; `exp` has not passed; its `jti` is unused within 600
  seconds; and its pair is connected (otherwise S23, status 403). Local clients never create accounts.
- **FR-41.** Clients poll no faster than the interval Ever ID returns (at least 5 seconds), add 5 seconds on
  every `slow_down`, and stop when the code expires (at most 900 seconds).
- **FR-42.** Clients print the address and code only — never a token — and keep the session where they keep
  it today.
- **FR-43.** The existing browser hand-off stays unchanged; documentation recommends device sign-in.

### 4.6 Delegated read for the App Launcher

- **FR-44.** Another Ever platform may read the person's App Works with an Ever ID access token carrying the
  `apps:read` scope.
- **FR-45.** The token is accepted only if: its signature and issuer validate as in FR-11 and FR-13; its
  audience contains the API audience; `exp` has not passed (with skew); its lifetime (`exp` − `iat`) is at
  most 3,600 seconds; its subject is a connected identity of an active account.
- **FR-46.** Only endpoints explicitly marked for a delegated scope accept it. Everywhere else it is answered
  exactly like an invalid credential (401). On a marked endpoint, a token without the required scope answers 403.
- **FR-47.** A delegated read never opens a session, never updates the last sign-in time, and can never
  connect, disconnect or exchange.
- **FR-48.** The **Connected identities** card lists apps that used a delegated permission in the last 30 days
  with their last-used time, and links to Ever ID to revoke them.

### 4.7 Audit, privacy, accessibility and copy

- **FR-49.** Activity records, with IP address and user agent as sign-in rows do today: signed in, account
  created, connected, disconnected, signed out by Ever ID (one row per notice, with the number of sessions
  ended), terminal or node sign-in, first delegated read per app per 24 hours, and configuration changed.
  Rows carry the identity's display name and never a token, code or subject.
- **FR-50.** A refused sign-in with no resolvable account is counted without a user and without storing the
  e-mail address.
- **FR-51.** Every user-visible string is translatable in every locale; none is concatenated from fragments.
- **FR-52.** The button, dialogs and card are operable by keyboard alone, errors are announced to assistive
  technology, and no state is conveyed by colour alone.
- **FR-53.** Ever Works works with any standards-compliant OpenID Connect provider: nothing requires a claim
  beyond the standard ones plus the two scopes named in this spec.

### 4.8 Other Ever platforms (details in [`cross-platform.md`](./cross-platform.md))

- **FR-54.** Adoption order: Ever Works, then Ever Teams, then Ever Gauzy production last.
- **FR-55.** Each platform adds Ever ID as an additional method and keeps every existing method.
- **FR-56.** Each platform applies FR-21–FR-28's rules. On Ever Gauzy, where a person has one account per
  workspace, a pair belongs to at most one account per workspace, and the workspace picker lists only
  workspaces whose account is connected to that pair.
- **FR-57.** Ever Gauzy production is enabled only behind default-off flags; its first production change is
  server-side only.
- **FR-58.** No platform places a session token or signed access token in an address on the Ever ID path, and
  each honours sign-out notices for sessions it opened with Ever ID.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                     | Today                                                                              | This epic adds                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Account** (user)         | E-mail, profile, verification state, password credential, linked social providers. | Connected identities. Nothing else changes.                                               |
| **Session**                | A hashed bearer, expiry, device fingerprint.                                       | Which connected identity opened it and Ever ID's session identifier.                      |
| **Plugin**                 | Categories and capabilities resolved through facades.                              | An identity provider category and capability, configured by platform administrators only. |
| **Activity**               | Sign-in rows per provider.                                                         | The Ever ID rows of FR-49.                                                                |
| **Sign-in providers list** | Email/password, magic link, social providers.                                      | One additive Ever ID availability field.                                                  |

### 5.2 New

| Entity                                     | Why it must exist                                                                                                                                                                                                                                                                                                                                                           | Shape                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Connected identity** (external identity) | Linked social provider records are keyed by provider name without an issuer, carry provider tokens, and are resolved by e-mail matching. A shared identity must be keyed by issuer and subject (so a second issuer can coexist during a provider change), must never be matched by e-mail, and must store no token. Reusing those records would inherit all three problems. | One row per (issuer, subject), belonging to one account. Unique per (issuer, subject) and per (account, issuer). Fields listed in FR-31. |

> **No other new noun.** Pending sign-ups and connections are short-lived sealed values, not records. Replay
> protection reuses the verification store that already exists. "Connected identity" is added to the
> program vocabulary (README §1) in the implementing pull request.

### 5.3 States and transitions

**Sign-in decision** — Ever ID has authenticated the person and the ID token validated:

```
  pair connected? ──yes──► account active? ──yes──► session opened (S1)
        │                        └──no──► "account disabled" (S22)
        no
        ▼
  intent = connect? ──yes──► session ≤ 12 h, auth_time ≤ 300 s, email_verified ──► confirm screen (S4)
        │                          └─ any fails ──► S15 / S11
        no
        ▼
  email_verified? ──no──► S11
        │ yes
        ▼
  e-mail used by an account? ──yes──► S3 (nothing created)
        │ no
        ▼
  sign-up allowed? ──no──► "Ask an administrator for an invitation."
        │ yes
        ▼
  create-account screen (S2) ── confirm + terms ──► account + connected identity + session
```

**Connected identity lifecycle:** created by a sign-up or settings confirmation → each sign-in updates its
last sign-in time, each delegated read its app last-seen list (≤ 10 apps) → a disconnect allowed by FR-28
removes it and ends its other sessions. There is no suspended or pending state stored.

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 Sign-in and registration pages

```
╔══════════════════════════════════════════════╗
║  Sign in to Ever Works                       ║
║  [ Email ] [ Password ]        [ Sign in ]   ║
║  ───────────── or continue with ───────────  ║
║  [ ◆ Sign in with Ever ID                  ] ║   ← full width, above the social grid
║  [ Google ]  [ GitHub ]                      ║
╚══════════════════════════════════════════════╝
```

| Element                         | Copy                                                   |
| ------------------------------- | ------------------------------------------------------ |
| Button (sign-in page)           | `Sign in with Ever ID`                                 |
| Button (registration page)      | `Sign up with Ever ID`                                 |
| Button while redirecting        | `Opening Ever ID…`                                     |
| Registration consent not ticked | disabled, reason `Accept the terms above to continue.` |

### 6.2 Create your account (S2)

```
╔══════════════════════════════════════════════════════════════╗
║  Create your Ever Works account                              ║
║  Signed in to Ever ID as  Alice Martin · alice@example.com   ║
║  [ ] I agree to the Terms of Service and Privacy Policy      ║
║                         [ Cancel ]  [ Create account ]       ║
╚══════════════════════════════════════════════════════════════╝
```

The S3 screen is titled `You already have an Ever Works account`, shows the S3 copy, and offers
`Forgot password?` and `Go to sign in`.

### 6.3 Settings → Security → Connected identities

```
╔════════════════════════════════════════════════════════════════════╗
║  Connected identities                                              ║
║  Sign in to Ever Works with an identity you already use.           ║
╟────────────────────────────────────────────────────────────────────╢
║  ◆ Ever ID   alice@example.com · connected 3 Sep 2026              ║
║              Last used to sign in 2 hours ago        [ Disconnect ] ║
║  Apps that can see your App Works                                  ║
║     Ever Teams — last used 5 minutes ago     [ Manage in Ever ID ↗ ]║
╚════════════════════════════════════════════════════════════════════╝
```

Variants: **not connected** — `Not connected` with `Connect Ever ID`; **cannot disconnect** — the S14 copy
and `Set a password`; **turned off by an administrator** — the row stays with `Disconnect` and the line
`Signing in with Ever ID is turned off on this installation.`

### 6.4 Confirm connection (S4) and disconnect

```
╔════════════════════════════════════════════════════════════════╗
║  Connect Ever ID to this account?                              ║
║  Ever ID           alice@example.com                           ║
║  Ever Works        bob@example.com                             ║
║  ⚠ These e-mail addresses are different. Connect only if both  ║
║    are yours.                                                  ║
║  You'll be able to sign in to this account with Ever ID.       ║
║                               [ Cancel ]  [ Connect ]          ║
╚════════════════════════════════════════════════════════════════╝

DISCONNECT
  "Disconnect Ever ID? You won't be able to sign in with it any more, and other
   devices signed in with Ever ID will be signed out. This device stays signed in."
  [ Keep it ]  [ Disconnect ]
```

### 6.5 Error and notice copy

Sign-out dialog (sessions opened with Ever ID only): `Sign out of Ever Works?` · checkbox
`Also sign out of Ever ID` (unticked) · `Cancel` · `Sign out`.

| Situation                   | Copy                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| S11 unverified e-mail       | `Verify your e-mail address with Ever ID first, then try again.`                                  |
| S12 connected elsewhere     | `This Ever ID is already connected to a different Ever Works account. Disconnect it there first.` |
| S13 already has one         | `This account already has an Ever ID connected. Disconnect it first.`                             |
| S15 session too old         | `For your security, sign in again before connecting Ever ID.`                                     |
| S16 provider not responding | `Ever ID isn't responding. Try again in a minute, or sign in another way.`                        |
| S17 expired or replayed     | `That sign-in expired or was already used. Start again.`                                          |
| Sign-up not allowed         | `New accounts can't be created with Ever ID here. Ask an administrator for an invitation.`        |
| S6 notice on next load      | `You were signed out of Ever ID.`                                                                 |
| S7 both signed out          | `You're signed out of Ever Works and Ever ID.`                                                    |
| Connected (toast)           | `Ever ID connected.`                                                                              |
| Disconnected (toast)        | `Ever ID disconnected.`                                                                           |
| Rate limited                | `Too many attempts. Try again in {seconds} seconds.`                                              |

### 6.6 Terminal

```
$ ever-works login --ever-id
To sign in, open  https://<ever-id-host>/device  and enter the code:  WDJB-MJHT
Waiting for approval… (expires in 15 minutes)
Signed in as alice@example.com.
```

Failure lines: `Ever ID isn't responding. Try "ever-works login" without --ever-id.` ·
`The code expired. Run the command again.` · `Connect Ever ID to your Ever Works account in Settings →
Security first.` Exit code 1 on every failure.

### 6.7 Administrator settings

Fields in FR-2 order; **Test connection** renders one row per FR-3 check (`✓ Issuer matches` /
`✗ S256 code challenge not supported`); **Health** shows the last discovery refresh, key refresh and sign-out
notice. The secret reads `•••••• (set)` after saving. Keyboard: `Tab` follows visual order; `Esc` closes a
dialog and returns focus to its opener; `Enter` fires the primary action unless focus is on a checkbox.

---

## 7. Out of scope

- **Enterprise identity** — SAML, per-Organization identity providers, SCIM and group-to-role mapping (G-09).
- **Ever Works acting as an identity provider** for other platforms (D14).
- **Operating the identity provider itself** — hosting, domains, keys and backups live in the private
  operations repository.
- **Automatic or bulk linking**, account merging, or migrating existing accounts to Ever ID.
- **Refresh tokens and offline access** at Ever Works.
- **Removing** the local-client browser hand-off or any existing provider.
- **Multi-factor policy** — enforced at Ever ID, not re-implemented here.
- **Platforms other than Ever Works, Ever Teams and Ever Gauzy.**

---

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a running build with a test OpenID Connect provider.

**Availability**

- [ ] **ACC-12-01** With the integration unconfigured or the flag off, no Ever ID button renders and every Ever ID sign-in endpoint answers not found.
- [ ] **ACC-12-02** An unevaluable flag behaves as off.
- [ ] **ACC-12-03** Test connection reports each FR-3 check within 5 seconds and never returns the secret.
- [ ] **ACC-12-04** Turning Ever ID off leaves listing, disconnect and sign-out notices working.
- [ ] **ACC-12-05** The existing providers list keeps every existing field; existing sign-in e2e suites pass unchanged.

**Protocol**

- [ ] **ACC-12-06** The authorization request carries S256, a fresh 32-byte `state` and `nonce`, and the exact registered redirect address.
- [ ] **ACC-12-07** An ID token with a wrong issuer, audience, nonce, algorithm `none`, a symmetric algorithm, an expired `exp` beyond 60 seconds, or an `iat` older than 600 seconds is refused.
- [ ] **ACC-12-08** A token signed with a newly rotated key validates after one key refresh; a removed key is refused after the next refresh.
- [ ] **ACC-12-09** Replaying a completed callback yields S17.
- [ ] **ACC-12-10** A token in a query parameter is refused with 400 and appears in no log line.
- [ ] **ACC-12-11** Each FR-18 limit answers 429 with `Retry-After` at the stated count.
- [ ] **ACC-12-12** A return path to another site falls back to the dashboard.

**Accounts and connections**

- [ ] **ACC-12-13** A connected Ever ID signs in to its account (S1) and Activity records it.
- [ ] **ACC-12-14** An unknown verified Ever ID creates an account only after confirmation and terms acceptance (S2).
- [ ] **ACC-12-15** An unknown Ever ID whose e-mail matches an account creates nothing and signs nobody in (S3).
- [ ] **ACC-12-16** An unverified Ever ID e-mail creates and connects nothing (S11).
- [ ] **ACC-12-17** Connecting requires a session under 12 hours old and `auth_time` within 300 seconds.
- [ ] **ACC-12-18** Connecting an Ever ID already connected elsewhere answers S12 without naming the other account.
- [ ] **ACC-12-19** Concurrent sign-up and connection of the same Ever ID leave exactly one connection (S24).
- [ ] **ACC-12-20** Disconnect is refused only in the S14 situation and otherwise ends the identity's other sessions while keeping the current one.
- [ ] **ACC-12-21** An API key or delegated token cannot connect or disconnect (S27).
- [ ] **ACC-12-22** No Ever ID token is stored anywhere in the database.

**Sessions and sign-out**

- [ ] **ACC-12-23** A valid sign-out notice with `sid` ends only that session within 5 seconds; with `sub` it ends all sessions that identity opened.
- [ ] **ACC-12-24** A notice with a reused `jti`, a `nonce`, or an `iat` older than 300 seconds answers 400.
- [ ] **ACC-12-25** Password sessions survive every sign-out notice.
- [ ] **ACC-12-26** "Also sign out of Ever ID" signs out at the provider and returns with a validated `state`.
- [ ] **ACC-12-27** An Ever ID session expires after 7 days like any other.

**Local clients**

- [ ] **ACC-12-28** Terminal sign-in with a code completes within 5 seconds of approval and prints no token.
- [ ] **ACC-12-29** The exchange refuses a token from an unlisted client, without the exchange scope, older than 300 seconds, or with a reused `jti`.
- [ ] **ACC-12-30** An unconnected Ever ID gets S23 and no account is created.
- [ ] **ACC-12-31** Polling respects the returned interval and `slow_down`.
- [ ] **ACC-12-32** The existing terminal browser sign-in still works unchanged.

**Delegated read**

- [ ] **ACC-12-33** A valid `apps:read` token reads the person's App Works on the marked endpoint.
- [ ] **ACC-12-34** The same token is refused with 401 on an unmarked endpoint and 403 on a marked endpoint without the scope.
- [ ] **ACC-12-35** A token with lifetime over 3,600 seconds or a wrong audience is refused.
- [ ] **ACC-12-36** The Connected identities card lists the app that read, with its last-used time.

**Cross-cutting**

- [ ] **ACC-12-37** Every Activity row of FR-49 exists and none contains a token, code or subject.
- [ ] **ACC-12-38** Every new string resolves in all locales; no page contains "SSO" or "single sign-on".
- [ ] **ACC-12-39** The button, both confirmation screens, the card and the dialogs pass an automated accessibility check with no new violations.
- [ ] **ACC-12-40** Ever Teams and Ever Gauzy adoption criteria in [`cross-platform.md`](./cross-platform.md) §7 are met before each platform's production flag is turned on.
- [ ] **ACC-12-41** Deleting an account or an organization deletes every `external_identities` row it owned, so no Ever ID link outlives the account (Resolution R-35's APW-12 half), and the cascade is idempotent when the deletion event is replayed.

---

## 9. Open questions

- **~~[NEEDS CLARIFICATION: identity provider product and domain.]~~ ANSWERED (owner, 2026-09-17): provider
  **ZITADEL**, self-hosted **as-is and unmodified**, at **`auth.ever.co`** (verified free in the `ever.co` zone),
  one instance serving every platform.** Decision record: [`idp-options.md`](./idp-options.md) §6–§7 (status
  `Decided`); the binding "pure addition, never a replacement" constraints are §7 there. This spec assumes only
  standard OpenID Connect, which is unchanged.
- **[NEEDS CLARIFICATION: does Ever ID itself offer Google and GitHub sign-in?]** If yes, a person may reach
  Ever Works through Ever ID's Google button; Ever Works still sees only the Ever ID pair. Default: yes, with
  linking at Ever ID also explicit.
  → **Resolved (D4, [`idp-options.md`](./idp-options.md) §6, recommended default):** yes, with the §6.1 explicit
  re-authentication linking rule. Register row: `CLARIFICATIONS.md` (row for this marker).
- **[NEEDS CLARIFICATION: sign-up through Ever ID on Ever Works.]** Default on (FR-2). Should a private
  installation default it off?
  → **Answered as a configuration default, not a defect:** `signUpAllowed` is `true` everywhere and an
  installation sets `EVER_ID_SIGN_UP_ALLOWED=false` to turn it off (plan §4.2, CONTRACTS §7).
- **[NEEDS CLARIFICATION: delegated token lifetime.]** Ever Works accepts up to 3,600 seconds; the
  recommendation to Ever ID is 900 seconds. Confirm.
  → **Resolved ([`idp-options.md`](./idp-options.md) §6.1):** access 900 s, ID token 300 s, and Ever Works keeps
  accepting up to 3,600 s so a slower provider does not break the contract (FR-45).
- **[NEEDS CLARIFICATION: consent for `apps:read`.]** Consent screen at first use, or pre-approved for
  first-party Ever apps? Default: pre-approved for first-party clients only, listed and revocable on the card.
  → **Resolved (D7, [`idp-options.md`](./idp-options.md) §6):** pre-approved for first-party Ever clients only;
  the card lists every client that read and offers revoke (FR-48).
- **[NEEDS CLARIFICATION: other product lines.]** Whether another product line's identity provider ever
  federates with Ever ID. Default: no; the Ever instance stays separate. No nudge to connect in P1.
  → **Resolved (D9, [`idp-options.md`](./idp-options.md) §6; R-28):** no. Each product line keeps its own
  identity infrastructure and the Ever instance stays separate.

---

## 10. Non-functional requirements

Numbers are binding; each is measurable and each names where it is proven. They are lifted from the plan rather
than invented here (Constitution IX keeps implementation detail in `plan.md`).

| Id     | Requirement                                                                                                                                                                                                                                                     | Proven by                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| NFR-1  | Sign-in completes within **5 seconds** of the provider's redirect for a healthy provider; every outbound call the sign-in path makes has a **5,000 ms** timeout, with one retry after 1 s for discovery and the key set and **no retry** for the token endpoint | T6, T7, T20; ACC-12-28                  |
| NFR-2  | A sign-out notice ends its sessions within **5 seconds** of arriving, and the person's next page load shows the notice                                                                                                                                          | T14, T30; ACC-12-23                     |
| NFR-3  | A token in a query parameter is refused with `400 tokenInQuery` **before** authentication runs and before any logging interceptor records the URL                                                                                                               | T16; ACC-12-10                          |
| NFR-4  | Turning the plugin off, or the provider becoming unavailable, takes effect within **60 seconds** on **every** API replica, with no restart                                                                                                                      | T32; ACC-12-01, ACC-12-04               |
| NFR-5  | The key set is cached for 600 s, an unknown key triggers one refetch with a 30 s cooldown, and stale use beyond 21,600 s fails closed                                                                                                                           | T6; ACC-12-08                           |
| NFR-6  | A sealed cookie never exceeds 3,072 bytes (so it fits under 4 KB) with `returnTo` up to 2,048 characters                                                                                                                                                        | T13; ACC-12-09                          |
| NFR-7  | Replay protection is single-use and cross-replica: two concurrent consumers of one `state`, `pending` value or `jti` leave exactly one winner                                                                                                                   | T13, T15; ACC-12-09, ACC-12-19          |
| NFR-8  | No secret, token, code, `state` or subject appears in a log line, an Activity row, a telemetry event or an error body                                                                                                                                           | T20, T32, T45; ACC-12-37                |
| NFR-9  | No token is ever carried in a URL, on any path, in any environment                                                                                                                                                                                              | T16, T18, T30; ACC-12-10, ACC-12-26     |
| NFR-10 | Every new string resolves in all 21 locales and no English value contains "SSO" or "single sign-on"                                                                                                                                                             | T27; ACC-12-38                          |
| NFR-11 | The new surfaces pass an automated accessibility check with no new violations, are keyboard-operable, and survive right-to-left locales                                                                                                                         | T30; ACC-12-39 (README §7 rule 17)      |
| NFR-12 | Nothing that signs a person in today changes behaviour: every pre-existing sign-in test in all three repositories passes **unchanged**, with the feature off and on                                                                                             | T30, T34, T35–T42; ACC-12-32, ACC-12-40 |

## 11. Constitution gates

One behaviour-level line per gate; the implementation checklist with its citations is
[`plan.md`](./plan.md) §12.

- [x] **I — Plugin-first.** The identity integration is a plugin with its own settings schema, and the OpenID Connect libraries are dependencies of that package only.
- [x] **II — Capability-driven.** Callers ask the facade; no plugin id appears in core. Declared deviation: the settings cascade collapses to the platform tier, because sign-in precedes any user or Work.
- [x] **III — Source-of-truth repositories.** Identity metadata is platform metadata, never Work content.
- [x] **IV — Job runtime.** No new background job is needed: notices are synchronous, keys refresh lazily, replay cleanup is opportunistic.
- [x] **V — Forward-only migrations.** Two additive migrations, `down()` drops only what `up()` created, no backfill (Resolution R-39's block).
- [x] **VI — Tests first.** Unit, controller, integration, Playwright, client and other-repository specs are named in `plan.md` §10; no suite under `apps/api/test/` (Resolution R-22).
- [x] **VII — Secrets.** The client secret is `x-secret`; no Ever ID token is stored; query tokens are refused before logging.
- [x] **VIII — Plugin counts.** The plugin is registered in the built-in plugins documentation in the same PR.
- [x] **IX — Behaviour-first spec.** Every identifier lives in the plan, not in this file.
- [x] **X — Backwards compatibility.** One optional provider field, one optional session argument, one added value on the existing credential union and two nullable columns; every existing route and response is unchanged.
- [x] **Program rule 1 — additive only** (Resolution R-26), restated as the owner's binding constraints in [`idp-options.md`](./idp-options.md) §7.
- [x] **Constitutional gaps flagged, not absorbed** (README §7 rule 18): Principle VI's test location is corrected here per R-22 pending a constitution patch.

## 12. References

- **Program**: [README](../README.md) (D14, §8 questions 6, 9 and 10; §7 rules 1–18) ·
  [CONTRACTS](../CONTRACTS.md) (R-1, R-2, R-19, R-22, **R-28** Ever ID provider/domain, R-30 switches, R-32
  human-only, R-34 Activity completeness, R-35 deletion, R-37 registers, R-38 merge order, R-39 migrations; §4
  routes, §7 flags, §7A caps, §11 signals, §12 error codes) ·
  [ACCEPTANCE](../ACCEPTANCE.md) (ACC-E2E-13, the APW-12 section, ACC-NEG-17/18/19/20) ·
  [TRACKER](../TRACKER.md) (the APW-12 P0 operator action) ·
  [GITHUB-PERMISSIONS](../GITHUB-PERMISSIONS.md) · [THREAT-MODEL](../THREAT-MODEL.md) (B-7, B-11, B-12) ·
  [CLARIFICATIONS](../CLARIFICATIONS.md) (the D-rows and this epic's markers).
- **This epic**: [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md) · [`idp-options.md`](./idp-options.md) (the
  decision record and the owner's binding constraints) · [`cross-platform.md`](./cross-platform.md) (Teams and
  Gauzy adoption, XP ids) · [`cross-repo-issues/`](./cross-repo-issues/) (the issue drafts for those repositories).
- **Existing substrate**: [EXISTING-SUBSTRATE](../EXISTING-SUBSTRATE.md) §6 (identity and cross-platform
  navigation) · `apps/api/src/auth/` (Better Auth abstraction, session provider) ·
  `apps/api/src/terms/terms-acceptance.service.ts` (the terms contract sign-up reuses) ·
  `apps/api/src/safety/guards/human-actor.guard.ts` (the human-only guard) ·
  `packages/plugin/src/contracts/` (capability contracts) · `packages/agent/src/facades/oauth.facade.ts` (the
  facade precedent) · `docs/specs/security/THREAT-MODEL.md` (the platform threat model this epic extends).
- **Decisions**: ADR-014 (no hardcoded catalogs), ADR-015 (job-runtime provider pluggability), ADR-017 — the
  program decisions in README §2 that this epic depends on.
- **User documentation**: `docs/features/ever-id.md` (created by T33) and
  [`../user-docs/app-works.md`](../user-docs/app-works.md).
