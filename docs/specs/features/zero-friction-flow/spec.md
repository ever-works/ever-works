# Zero-friction prompt → deployed Work flow

> Epic: **EW-617** &nbsp;|&nbsp; Sub-tasks: EW-618 (G1), EW-619 (G2), EW-620 (G3), EW-621 (G4), EW-622 (G5), EW-623 (G6), EW-624 (G7), EW-625 (G8)
>
> Status: G6 merged (#752). G2 PR #756 open. G3 (this PR) builds on G2.

## Goal

A first-time visitor lands on `https://ever.works/`, types a prompt
describing the website / directory they want, clicks **Generate**, and
ends up on `https://app.ever.works/` already signed in as an
**anonymous / temporary user**. The Onboarding Wizard auto-runs with
all defaults; a single **Generate now** button creates the Work, which
is then:

- Published as 3 **private** repos under the `ever-works-cloud` GitHub org
- Deployed to **k8s-works** with auto-provisioned DNS + TLS
- Served at `https://{slug}.ever.works/`

**The user provides nothing — not even an email — to try the platform
end-to-end.** Later they can _Claim Account_ and attach credentials to
keep their Work.

## Gap breakdown

Each gap is tracked as a sub-task under EW-617 and shipped as its own
PR.

| #  | Title                                                          | Jira    | Status   |
|----|----------------------------------------------------------------|---------|----------|
| G1 | Landing-page prompt input + handoff to app.ever.works          | EW-618  | Planned  |
| G2 | Anonymous / temporary user auth                                | EW-619  | This PR  |
| G3 | Claim-Account flow (anon → registered)                         | EW-620  | This PR  |
| G4 | Wizard "Finish & Generate with Defaults" + `/api/works/quick-create` | EW-621 | Planned |
| G5 | Subdomain ingress + Cloudflare DNS automation                  | EW-622  | Planned  |
| G6 | Default `work.deployProvider` `'vercel'` → `'ever-works'`      | EW-623  | Merged (#752) |
| G7 | Quotas + abuse protection                                      | EW-624  | Planned  |
| G8 | Telemetry events + ops runbook                                 | EW-625  | Planned  |

## G3 — Claim-Account flow (anonymous → registered)

### Functional requirements

- **FR-G3-1** `POST /api/auth/claim` MUST require an authenticated
  session (via `AuthSessionGuard`) and MUST reject (403) when the
  caller's `User` row is not `is_anonymous = true`. This prevents
  hijacking an already-registered account.
- **FR-G3-2** The endpoint accepts `{ email, password, username?,
  emailVerificationCallbackUrl? }` (validated by `ClaimAccountDto`
  with the same password rules as `RegisterDto`).
- **FR-G3-3** If `email` (normalized to lowercase, trimmed) matches a
  different existing user, the endpoint MUST return 409 Conflict.
  Auto-merging is intentionally forbidden — it's a footgun. The
  client UI should redirect to `/login` instead.
- **FR-G3-4** On success the service MUST in a single update set
  `email`, `username` (defaulting to the existing anon username),
  `password` (hash), `is_anonymous=false`, clear
  `anonymous_expires_at`, set `registration_provider='local'`, reset
  `email_verified=false`.
- **FR-G3-5** A verification email MUST be triggered via
  `AuthService.sendVerificationEmail` so the existing pipeline
  (`UserCreatedEvent` → `MailService`) handles it. A failure to send
  MUST NOT roll back the claim — the user can request resend via
  `POST /api/auth/send-verification`.
- **FR-G3-6** The caller's existing session token MUST stay valid.
  Works ownership is by `user_id`, which doesn't change, so no Work
  transfer is needed.
- **FR-G3-7** The endpoint MUST be throttled (default: 10/hour per
  IP) to dampen email-squatting brute force.

### Non-functional requirements

- **NFR-G3-1** Email comparison MUST be case-insensitive and
  whitespace-trimmed.
- **NFR-G3-2** Password hashing MUST go through the same Better Auth
  credential adapter used by `/register` so `/login` works without
  any additional sync step.
- **NFR-G3-3** When username is omitted the existing `anon-<hex>`
  value is kept rather than auto-derived from email — the user can
  edit it via `PUT /api/auth/profile` later.

## G2 — Anonymous / temporary user auth

### Functional requirements

- **FR-G2-1** The `users` table MUST allow `email` and `password` to be
  NULL when `is_anonymous = true`. Existing rows are unaffected.
- **FR-G2-2** Two new columns on `users`: `is_anonymous BOOLEAN`
  (default `false`) and `anonymous_expires_at TIMESTAMPTZ` (nullable).
- **FR-G2-3** `POST /api/auth/anonymous` MUST mint a fresh `User` row
  with `is_anonymous=true`, `email=NULL`, `password=NULL`,
  `registration_provider='anonymous'`, `anonymous_expires_at = now +
  ANONYMOUS_USER_TTL_DAYS` (default 7), then issue an `AuthSession`
  token and return `{ access_token, user }` in the same shape as
  `POST /api/auth/register`.
- **FR-G2-4** `POST /api/auth/anonymous` MUST be rate-limited per IP
  (default: 5 requests per hour). EW-624 (G7) will harden this with
  captcha + global caps.
- **FR-G2-5** The `AuthenticatedUser` type used downstream MUST carry
  an optional `isAnonymous` flag so services can gate behavior
  (quota path, claim-account UI, OAuth-only endpoints).
- **FR-G2-6** Existing endpoints guarded by `AuthSessionGuard` MUST
  accept anonymous session tokens — no guard changes are required
  because the guard already issues a session regardless of identity.
  Services that require a real email (e.g. transactional mail) MUST
  reject anonymous users explicitly.
- **FR-G2-7** A nightly Trigger.dev schedule `anonymous-user-cleanup`
  (cron `17 3 * * *`) MUST find users with `is_anonymous=true AND
  anonymous_expires_at < now` and delete them. The existing `work.user`
  `ON DELETE CASCADE` removes their Works. A single delete failure
  MUST log + continue so one stuck row cannot block the batch.
- **FR-G2-8** The web-side `JwtPayload` type MUST expose `isAnonymous`
  so layouts/components can render the claim-account nag.

### Non-functional requirements

- **NFR-G2-1** Anonymous user creation MUST be a single round-trip; no
  Better Auth signup ceremony, no email verification mail.
- **NFR-G2-2** Generated `username` MUST be DNS-/log-safe and not leak
  IP/UA: pattern `anon-<8 hex chars>`.
- **NFR-G2-3** `User.asCommitter()` MUST keep returning a parseable
  email even when both `email` and `committerEmail` are null — fallback
  to `anon-<userId>@anonymous.ever.works`. Real commits MUST NOT happen
  on this fallback (claim-account flow lands before any repo write).

### Out of scope (deferred to other gaps)

- Landing-page prompt UI (G1).
- Claim-account endpoint (G3).
- Quick-create wizard (G4).
- Subdomain DNS (G5).
- Captcha / abuse hardening (G7).
- Telemetry event emission (G8).

## Acceptance (E2E, after all gaps land)

A fresh-incognito user, with no account, no GitHub, no Vercel
connection, no email:

1. Lands on `https://ever.works/`.
2. Types "AI coding assistants directory" into the prompt input.
3. Clicks **Generate**.
4. Is redirected to `https://app.ever.works/onboarding` already signed
   in as an anonymous user.
5. Wizard auto-completes with all defaults; user clicks one
   **Generate now** button.
6. Within ~3 min, 3 private repos appear in `ever-works-cloud` GitHub
   org.
7. Within ~5 min, `https://ai-coding-assistants.ever.works/` serves the
   generated site over HTTPS.
8. Optional: clicks **Claim account**, enters email + password, keeps
   the Work.

## References

- Audit + gap breakdown: `EW-617`.
- Wizard v2 defaults: `docs/specs/features/onboarding-wizard-v2/spec.md`.
- `ever-works-cloud` org PAT lifecycle: `EW-614`.
- k8s-works deploy pipeline: `docs/specs/features/k8s-deployment/`.
