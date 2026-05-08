# Task Breakdown: Mail Providers

**Feature ID**: `mail-providers`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## Phase 1 — Provider Wiring

- [x] T1. `MailerModule` (`apps/api/src/mail/mail.module.ts`) wires
      `@nestjs-modules/mailer` with the SMTP transport
      (`config.mail.smtpHost/Port/Secure/IgnoreTLS/User/Password` +
      `tls.rejectUnauthorized: false`), `defaults.from =
config.mail.from()`, and the Handlebars adapter
      (`inlineCssEnabled: true`, `strict: true`) reading from
      `${process.cwd()}/src/templates`.
- [x] T2. `RESEND_CLIENT` provider built via `useFactory`:
      `config.mail.resend.apiKey()` truthy → `new Resend(apiKey)`,
      else `undefined`.
- [x] T3. `FakerMailerService`, `MailerService`, and `MailService`
      registered as module providers.

## Phase 2 — Provider Router

- [x] T4. `MailerService.sendMail(data)` switch on
      `config.mail.provider()` for `smtp` / `resend` / default
      branches.
- [x] T5. SMTP branch logs "Sending …" + "Email sent …" lines and
      delegates to `SmtpMailerService.sendMail(data)`.
- [x] T6. Resend branch fallback when `RESEND_CLIENT` is undefined:
      warn-log and route through `FakerMailerService`.
- [x] T7. Resend branch resolves `from` via
      `config.mail.resend.emailFrom()`, builds `html` via
      `readHtmlTemplate(data)`, and forwards
      `{to, from, subject, html}` to `Resend.emails.send`.
- [x] T8. Default branch routes to `FakerMailerService` with a
      debug log.
- [x] T9. `getDestination(destination)` normalises `string |
Address | (string|Address)[]` to `string[]` (string
      pass-through, `address` field extraction, fallthrough to
      `toString`).
- [x] T10. `readHtmlTemplate(data)` resolves
      `${cwd}/src/templates/${template}.hbs` with `{encoding:
'utf8'}` and compiles via `Handlebars.compile`; falls back to
      `data.html` (Buffer or string), then `data.text` (Buffer or
      string), then empty string.
- [x] T11. Constructor log line: `Mailer service initialized with
provider: <provider>`.

## Phase 3 — Faker Fallback

- [x] T12. `FakerMailerService.sendMail(data)` debug-logs
      `FakerMailerService:sendMail to=<to> subject="<subject>"` and
      resolves immediately.

## Phase 4 — Domain Event Listeners

- [x] T13. `MailService` subscribes via `@OnEvent` to all seven
      user-lifecycle events: - `UserCreatedEvent` → `signup-confirmation`. - `UserConfirmedEvent` → `welcome` (default `dashboardUrl =
${webAppUrl}/works/new`). - `UserPasswordChangedEvent` → `password-changed`
      (`formatDateTime(changedAt)`). - `UserForgotPasswordEvent` → `forgot-password` (default
      `expiresIn = '1 hour'`). - `UserNewDeviceLoginEvent` → `new-device-login`
      (`formatDateTime(loginTime)` + device + browser + IP +
      verifyUrl/Token + secureAccountUrl). - `UserAccountDeletionEvent` → `account-deletion` (default
      `expiresIn = '24 hours'`). - `MemberInvitedEvent` → `member-invitation`
      (`formatRoleName(role)`).
- [x] T14. `getBrandingContext()` returns `{appName, companyOwner,
platformWebsite, currentYear}` and is merged into every
      template context.
- [x] T15. Each handler wraps its body in `try/catch` +
      `logger.error('Failed to send …', err?.stack ?? err)` so
      delivery failures DO NOT propagate back to the originating
      event emitter.
- [x] T16. `formatDateTime(date)` uses
      `Intl.DateTimeFormat('en-US', {year:numeric, month:long,
day:numeric, hour:'2-digit', minute:'2-digit',
timeZoneName:'short'})`.
- [x] T17. `formatRoleName(role)` capitalises the first character
      and lowercases the rest.

## Phase 5 — Templates

- [x] T18. Seven Handlebars templates committed at
      `apps/api/src/templates/`:
    - `signup-confirmation.hbs`.
    - `welcome.hbs`.
    - `password-changed.hbs`.
    - `forgot-password.hbs`.
    - `new-device-login.hbs`.
    - `account-deletion.hbs`.
    - `member-invitation.hbs`.

## Phase 6 — Tests

- [x] T19. `mailer.service.spec.ts` (14 tests):
    - SMTP path (single recipient string, mixed string + Address
      array log format, `to=unknown` log when omitted, object
      without `address` key falls through to `toString`).
    - Resend path (no client → faker fallback w/ warn, html-string
      body, Buffer html / Buffer text / empty body, Handlebars
      template via `fs.readFile` w/ correct path + `utf8` opts,
      undefined `result.data?.id` → `id=unknown`, documents the
      existing unguarded `getDestination(undefined)` bug in
      `resend.emails.send`).
    - Faker fallback (MAILER_PROVIDER unset / `none`).
    - Constructor log line via `Logger.prototype` spy.
    - Mocks `fs/promises.readFile` at module scope.
- [x] T20. `faker-mailer.service.spec.ts` (2 tests): debug log
      shape + undefined-recipient tolerance.
- [x] T21. `mail.service.spec.ts` (`apps/api/src/mail`) —
      28 listener-side unit tests covering all seven `@OnEvent`
      handlers (`sendSignupConfirmation`/`sendForgotPassword`/
      `sendPasswordChanged`/`sendWelcomeEmail`/`sendNewDeviceAlert`/
      `sendAccountDeletionConfirmation`/`sendMemberInvitation`),
      `getBrandingContext` merge across all four branding fields
      (`appName`/`companyOwner`/`platformWebsite`/`currentYear`)
      with `APP_NAME`/`NEXT_PUBLIC_APP_NAME` fallback chain pinned,
      default `expiresIn = '1 hour'` (forgot-password) /
      `'24 hours'` (account-deletion), default `dashboardUrl =
      ${webAppUrl}/works/new` with `WEB_URL` env override AND
      `http://localhost:3000` last-resort fallback,
      `formatDateTime` Intl.DateTimeFormat shape (year + long
      month assertions, TZ-agnostic), `formatRoleName`
      capitalise-first/lowercase-rest including mid-word casing,
      single-letter input, and empty-string no-crash, the
      per-handler `try/catch + logger.error('Failed to send …',
      err?.stack ?? err)` swallowing policy (sendMail rejection
      MUST NOT propagate back to the event-bus), and the
      member-invitation log routing pinned against the
      INVITEE's email (NOT the inviter's). Closes the
      listener-side coverage gap called out in `spec.md` §9 /
      Constitution Gate VI.

## Phase 7 — Bug Fixes

- [x] T22. (FR-9 / OQ-1): `MailerService.sendMail` Resend branch
      no longer crashes when `to` is omitted. The call site
      `to: this.getDestination(data.to)` is now short-circuited to
      `to: data.to ? this.getDestination(data.to) : []`, mirroring
      the log line's `data.to ? this.getDestination(data.to).join(', ') : 'unknown'`
      gate. The corresponding assertion in `mailer.service.spec.ts`
      flipped from "rejects with `'address' in` TypeError" to
      "forwards `to: []` to `resend.emails.send`". The "to=unknown"
      log line still fires, mirroring the SMTP / faker branches'
      tolerance of a missing `to` field.

## Phase 8 — Docs

- [x] T23. This Spec Kit folder (spec / plan / tasks).
- [ ] T24. **Follow-up**: developer-facing doc at
      `docs/devops/mail-providers.md` — env-var reference, SMTP
      vs Resend trade-offs, the `tls.rejectUnauthorized` gate, and
      how to add a new template.

## Definition of Done

- [x] All seven user-lifecycle events trigger the right template
      with the right context, branding-merged.
- [x] Provider switching is purely env-var driven and degrades
      gracefully (Resend without API key → Faker; unrecognised
      `MAILER_PROVIDER` → Faker).
- [x] Per-handler `try/catch` + `logger.error` means a delivery
      failure does NOT propagate back to the originating event.
- [x] Both providers are unit-tested with branching coverage; the
      Resend-`to`-undefined edge case now forwards `to: []` instead
      of crashing.

## Follow-ups discovered

- **T24** — operator-facing devops doc covering SMTP vs Resend
  configuration, `tls.rejectUnauthorized` audit guidance, and the
  new-template workflow.
- **OQ-2** — codegen template-key types from the `.hbs` files so
  drift is caught at compile time rather than at Handlebars render
  time.
- **OQ-3** — production-mode `tls.rejectUnauthorized: true` toggle
  for SMTP; today the code accepts self-signed certs unconditionally.
- **Localisation** — if user feedback requests email copy in the
  user's UI locale, this is the spec to amend (currently English
  only).
