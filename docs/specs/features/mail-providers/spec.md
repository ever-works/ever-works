# Feature Specification: Mail Providers

**Feature ID**: `mail-providers`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The mail-providers feature is the platform's transactional-email
delivery surface. It abstracts three concrete delivery backends
(SMTP via Nodemailer, Resend, and a no-op Faker for local
development) behind a single `MailerService.sendMail(...)` call,
and wires seven domain events
(`UserCreatedEvent`, `UserConfirmedEvent`, `UserPasswordChangedEvent`,
`UserForgotPasswordEvent`, `UserNewDeviceLoginEvent`,
`UserAccountDeletionEvent`, `MemberInvitedEvent`) to seven
Handlebars-templated emails (`signup-confirmation`, `welcome`,
`password-changed`, `forgot-password`, `new-device-login`,
`account-deletion`, `member-invitation`). Provider selection is
driven entirely by the `MAILER_PROVIDER` environment variable; a
missing/invalid value silently degrades to the Faker provider so the
API never crashes on a misconfigured mail backend, and template
context is consistently enriched with the platform's branding
(app name, company owner, platform website, current year).

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** a new user signs up, **when** the
  `UserCreatedEvent` fires, **then** the `MailService` builds a
  `signup-confirmation` Handlebars context (firstName + confirmation
  URL + token + branding) and hands it to the configured provider.
- **Given** I forget my password, **when** the
  `UserForgotPasswordEvent` fires with a `resetUrl` and `resetToken`,
  **then** I receive a `forgot-password` email whose copy interpolates
  my username, reset URL, reset token, and a default `expiresIn` of
  `'1 hour'` when the event omits it.
- **Given** I confirm my account, **when** the
  `UserConfirmedEvent` fires, **then** I receive a `welcome` email
  with a `dashboardUrl` that defaults to
  `${config.webAppUrl()}/works/new` when the event omits it.
- **Given** I sign in from a new device, **when** the
  `UserNewDeviceLoginEvent` fires, **then** I receive a
  `new-device-login` alert that includes the formatted login time
  (`Intl.DateTimeFormat('en-US', {year:numeric, month:long, day:numeric,
  hour:'2-digit', minute:'2-digit', timeZoneName:'short'})`),
  `device`, `browser`, `location`, `ipAddress`, the
  `verifyUrl`/`verifyToken`, and a `secureAccountUrl`.
- **Given** I am invited to a work, **when** the
  `MemberInvitedEvent` fires, **then** I receive a `member-invitation`
  email with the inviter and invitee names, the work name, the
  formatted role label (`role.charAt(0).toUpperCase() +
  role.slice(1).toLowerCase()`), and a `workUrl`.
- **Given** I request account deletion, **when** the
  `UserAccountDeletionEvent` fires, **then** I receive an
  `account-deletion` email with `deleteUrl`/`deleteToken`,
  `keepAccountUrl`, and a default `expiresIn` of `'24 hours'` when the
  event omits it.
- **Given** an admin sets `MAILER_PROVIDER=smtp`, **when**
  `MailerService.sendMail` runs, **then** the SMTP transport from
  `@nestjs-modules/mailer` resolves the matching `*.hbs` template
  via `HandlebarsAdapter` (with `inlineCssEnabled: true` and
  `strict: true`) and delivers the message — and the service emits
  two info-level log lines surrounding the call (`Sending …
  to=<recipient> subject=…` then `Email sent via SMTP to=<recipient>`).
- **Given** an admin sets `MAILER_PROVIDER=resend` and
  `RESEND_APIKEY`, **when** `MailerService.sendMail` runs, **then**
  the Resend client receives `{to, from, subject, html}` (where
  `html` is the rendered Handlebars template) and the service logs
  `Email sent via Resend to=<recipient> id=<resendId>` (or
  `id=unknown` when the response has no `data.id`).

### 2.2 Edge cases & failures

- **Given** a domain event handler in `MailService` rejects, **when**
  the originating event is consumed, **then** the listener swallows
  the error via `try/catch` + `logger.error('Failed to send …', err?.stack ?? err)`
  and the originating event MUST NOT see the rejection — a delivery
  failure does not block sign-up, password reset, etc.
- **Given** `MAILER_PROVIDER=resend` but `RESEND_APIKEY` is unset,
  **when** the module factory builds the `RESEND_CLIENT` provider,
  **then** the client is `undefined` and the runtime falls through
  to the Faker delivery with a single `Resend client not initialized
  (missing RESEND_APIKEY?), falling back to faker for to=<recipient>`
  warn-level log.
- **Given** `MAILER_PROVIDER` is unset / `'none'` / `'faker'` / any
  unrecognised string, **when** `sendMail` runs, **then** the
  `default` switch branch routes the call to `FakerMailerService`,
  which logs at `debug` level and resolves immediately without
  touching any network.
- **Given** the caller omits `data.to`, **when** `sendMail` builds
  its log line, **then** `recipient` is the literal string
  `'unknown'` (the Resend branch still calls
  `this.getDestination(data.to)` which currently throws on
  `undefined` — see follow-up FR-9 / open question OQ-1).
- **Given** the caller passes `data.to` as `Address[]` mixing
  strings and `{name, address}` objects, **when**
  `getDestination(...)` runs, **then** each item is normalised to
  `string` (raw string passes through, `Address` becomes its
  `.address` field, anything else falls through to its `toString`).
- **Given** `data.template = 'forgot-password'`, **when**
  `readHtmlTemplate(...)` runs, **then** it reads
  `${process.cwd()}/src/templates/forgot-password.hbs` with
  `{encoding: 'utf8'}`, compiles via `Handlebars.compile`, and
  evaluates with `data.context ?? {}`.
- **Given** no `template` is set but `data.html` is a `Buffer`,
  **when** `readHtmlTemplate(...)` runs, **then** the buffer is
  converted via `.toString()`. Same for `data.text`.
- **Given** no `template`, `html`, or `text` is set, **when**
  `readHtmlTemplate(...)` runs, **then** it returns the empty
  string `''` (Resend will reject this — guard responsibility lies
  with the caller).
- **Given** SMTP delivery throws (auth failure, connection refused,
  4xx/5xx response), **when** the error propagates out of
  `MailerService.sendMail`, **then** the calling `MailService`
  handler catches it, logs the error (with stack), and the
  originating event's flow continues normally.

## 3. Functional Requirements

- **FR-1** `MailService` MUST subscribe to all seven user-lifecycle
  events
  (`UserCreatedEvent`, `UserConfirmedEvent`, `UserPasswordChangedEvent`,
  `UserForgotPasswordEvent`, `UserNewDeviceLoginEvent`,
  `UserAccountDeletionEvent`, `MemberInvitedEvent`) via `@OnEvent`
  decorators and translate each into a `MailerService.sendMail`
  call with the matching `template` slug and a fully populated
  `context` object.
- **FR-2** Every template context MUST be merged with
  `getBrandingContext()` returning
  `{appName, companyOwner, platformWebsite, currentYear}` so all
  emails can render the same branding placeholders.
- **FR-3** `MailService` MUST wrap each handler body in `try/catch`
  and log delivery failures via
  `logger.error('Failed to send …', err?.stack ?? err)` so a mail
  delivery failure NEVER propagates back to the originating event
  emitter.
- **FR-4** `MailService.sendWelcomeEmail` MUST default
  `dashboardUrl` to `${config.webAppUrl()}/works/new` when
  `data.dashboardUrl` is omitted.
- **FR-5** `MailService.sendForgotPassword` MUST default
  `expiresIn` to `'1 hour'` when the event omits it; analogously
  `MailService.sendAccountDeletionConfirmation` MUST default
  `expiresIn` to `'24 hours'`.
- **FR-6** `MailService.formatDateTime(date)` MUST format dates via
  `Intl.DateTimeFormat('en-US', {year:numeric, month:long,
  day:numeric, hour:'2-digit', minute:'2-digit',
  timeZoneName:'short'})`. `MailService.formatRoleName(role)` MUST
  capitalise the first character and lowercase the rest.
- **FR-7** `MailerService.sendMail(data)` MUST switch on
  `config.mail.provider()` returning one of `'smtp'`, `'resend'`, or
  any other value (which maps to the Faker default branch). Provider
  resolution MUST be **per-call** — a deployment can change the env
  var and the next call respects it.
- **FR-8** The Resend branch MUST resolve `from` via
  `config.mail.resend.emailFrom()`, build `html` via
  `readHtmlTemplate(data)`, and pass `{to, from, subject, html}` to
  `resend.emails.send`. The `to` is normalised through
  `getDestination(data.to)` returning a `string[]`.
- **FR-9** `getDestination(destination)` MUST accept `string |
  Address | (string|Address)[]`, MUST wrap a single value in an
  array, and MUST map each entry through:
    - `typeof to === 'string'` → return as-is.
    - `'address' in to` → return `to.address`.
    - else → fall through to `to` (which Node will coerce to its
      `toString`).
- **FR-10** When `MAILER_PROVIDER=resend` but `RESEND_APIKEY` is
  unset, the module's `RESEND_CLIENT` factory MUST return
  `undefined` and `MailerService.sendMail` MUST log a warn-level
  fallback line and route the call through `FakerMailerService`
  instead of throwing.
- **FR-11** `readHtmlTemplate(data)` MUST resolve templates from
  `${process.cwd()}/src/templates/${template}.hbs` with
  `{encoding: 'utf8'}` and compile via `Handlebars.compile(content)`.
  When `template` is unset, `Buffer` and `string` `html` / `text`
  fields MUST be normalised via `.toString()`.
- **FR-12** `MailerService` MUST emit a single info-level log line
  on construction
  (`Mailer service initialized with provider: <provider>`).
- **FR-13** Per-call logs MUST include the recipient (or `'unknown'`
  when `data.to` is omitted) and the subject. SMTP and Resend MUST
  log both a "Sending …" and an "Email sent …" line surrounding the
  outbound call.
- **FR-14** The `MailerModule` MUST configure
  `@nestjs-modules/mailer` with the SMTP transport, the
  `HandlebarsAdapter` (with `inlineCssEnabled: true` and
  `strict: true`), the templates directory at
  `${process.cwd()}/src/templates`, and the default `from` from
  `config.mail.from()`.
- **FR-15** `FakerMailerService.sendMail` MUST resolve immediately
  without touching the network and MUST log at `debug` level
  (`FakerMailerService:sendMail to=<to> subject="<subject>"`).

## 4. Non-Functional Requirements

- **Performance**:
    - The mail handler executes inside the `@OnEvent` listener, off
      the request critical path. SMTP/Resend latency does not
      block the originating HTTP response.
    - Template files are read fresh on every send (no in-process
      cache); typical handler latency is dominated by the upstream
      provider's HTTP round-trip, not by `readFile`.
- **Reliability**:
    - Provider misconfiguration NEVER crashes the API — Resend
      without `RESEND_APIKEY` falls back to Faker;
      `MAILER_PROVIDER=garbage` falls back to Faker.
    - Each `MailService` handler is independently `try/catch`-ed so
      one failed delivery type cannot wedge another.
    - Bounce / spam / quota handling is the responsibility of the
      configured upstream provider; the platform does not retry
      delivery itself.
- **Security & privacy**:
    - Email subjects and bodies MUST NOT include passwords, password
      hashes, OAuth tokens, or other secrets; reset and confirmation
      links carry one-shot tokens with explicit expiries.
    - SMTP credentials live in env vars (`SMTP_USER`, `SMTP_PASSWORD`)
      and are never logged.
    - `RESEND_APIKEY` lives in env vars and is never logged.
    - Recipient email addresses appear in INFO-level provider logs
      so operators can diagnose delivery; no body content is
      logged.
    - The SMTP transport sets `tls.rejectUnauthorized: false` to
      allow self-signed certs in dev environments — operators
      deploying to prod MUST front the SMTP host with a properly
      signed certificate or revisit this gate.
- **Observability**:
    - Construction log: `Mailer service initialized with provider:
      <provider>`.
    - Per-call info logs around SMTP and Resend sends as described
      in FR-13.
    - Faker-fallback warn log when Resend client is not
      initialised.
    - Per-handler error log on delivery failure
      (`Failed to send <kind> to <email>` + stack).
- **Compatibility**:
    - Provider switching is a config change, not a code change
      (Constitution Principle II — capability-driven).
    - Adding a new template means: drop a `<slug>.hbs` file under
      `apps/api/src/templates/`, add the matching event class,
      and add the matching `@OnEvent` handler — no schema or
      provider changes required.

## 5. Key Entities & Domain Concepts

| Entity / concept             | Description                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MailService`                | `apps/api/src/mail/mail.service.ts`. Subscribes to seven user-lifecycle events and translates each into a `MailerService.sendMail` call with the matching `template` slug and a branding-enriched context.                                                                                                              |
| `MailerService`              | `apps/api/src/mail/providers/mailer.service.ts`. The provider-routing facade. Switches on `config.mail.provider()` between SMTP (`@nestjs-modules/mailer`), Resend (`resend` SDK), or the Faker default branch.                                                                                                          |
| `FakerMailerService`         | `apps/api/src/mail/providers/faker-mailer.service.ts`. No-op debug-logging delivery used when no real provider is configured or when Resend is selected without an API key.                                                                                                                                              |
| `MailerModule`               | `apps/api/src/mail/mail.module.ts`. Wires `MailerModule.forRootAsync` with the SMTP transport (`config.mail.smtpHost/Port/Secure/IgnoreTLS/User/Password`, `tls.rejectUnauthorized: false`, `defaults.from = config.mail.from()`, Handlebars adapter with `inlineCssEnabled: true` + `strict: true`) and the `RESEND_CLIENT` factory provider. |
| `SendMailOptions`            | `apps/api/src/mail/types.ts`. `{to?, cc?, bcc?, replyTo?, inReplyTo?, from?, subject?, text?, html?, sender?, raw?, references?, encoding?, date?, context?, transporterName?, template?}`. Both single-recipient and array-of-recipient shapes are supported.                                                            |
| `Address`                    | `{name: string; address: string}`. Used inside `to`/`cc`/`bcc`/etc.                                                                                                                                                                                                                                                       |
| `MAILER_PROVIDER`            | Env-var switch: `smtp` / `resend` / anything-else (faker).                                                                                                                                                                                                                                                                |
| Handlebars templates         | Seven `*.hbs` files under `apps/api/src/templates/`: `signup-confirmation`, `welcome`, `password-changed`, `forgot-password`, `new-device-login`, `account-deletion`, `member-invitation`. Compiled at request time via `Handlebars.compile`.                                                                              |
| Branding context             | `{appName, companyOwner, platformWebsite, currentYear}` from `config.branding.*` and `new Date().getFullYear()`.                                                                                                                                                                                                          |
| `RESEND_CLIENT` token        | NestJS provider injected via `@Optional() @Inject('RESEND_CLIENT')`. Built via `useFactory` that returns `new Resend(apiKey)` if `config.mail.resend.apiKey()` is truthy, else `undefined`.                                                                                                                                |

## 6. Out of Scope

- **Provider-level retry / dead-letter queues.** Bounces, soft
  failures, quota exceedances, and rate-limiting are owned by the
  configured upstream provider (SMTP server or Resend). The
  platform does not implement its own retry queue.
- **Template versioning / A/B copy.** Templates are committed to
  the repo; changing one requires a code deploy.
- **Per-tenant from addresses.** All outbound mail uses the global
  `config.mail.from()` value — no per-work or per-org override.
- **Localisation / i18n of email copy.** Templates render in
  English regardless of the user's UI locale.
- **Inbound mail processing.** The platform does not parse incoming
  mail (no IMAP/POP integration, no Resend webhook handler).
- **Per-recipient personalisation beyond `{firstName,
  inviteeName, dashboardUrl, …}`.** Anything richer lives in the
  Handlebars template's own context.
- **Bulk / marketing email.** This surface is strictly for
  transactional, event-triggered messages.
- **In-app notifications.** Covered by the
  [`notifications`](../notifications/spec.md) feature, which is
  user-facing and runs independently.

## 7. Acceptance Criteria

- [x] All seven `@OnEvent` handlers in `MailService` deliver the
      right template with the right context, and each handler is
      independently `try/catch`-wrapped.
- [x] Branding context (appName / companyOwner / platformWebsite /
      currentYear) is merged into every template render.
- [x] `MailerService.sendMail` switches on the env-driven
      `MAILER_PROVIDER` per call and falls back to Faker on
      unrecognised values or missing Resend API key.
- [x] SMTP and Resend paths log a "Sending …" line before the
      provider call and an "Email sent …" line after.
- [x] `getDestination` accepts `string | Address | array-of-mixed`
      and returns a `string[]`.
- [x] `readHtmlTemplate` reads from `${cwd}/src/templates/{slug}.hbs`
      with utf-8, compiles via Handlebars, falls back to
      `data.html` / `data.text` (Buffer or string), else returns
      `''`.
- [x] Tests cover both providers + the constructor log + the
      Handlebars template path — see `mailer.service.spec.ts`
      (14 tests) and `faker-mailer.service.spec.ts` (2 tests),
      [#492](https://github.com/ever-works/ever-works/pull/492).

## 8. Open Questions

- **OQ-1 (FR-9 follow-up — Resend `to`-undefined crash).** As of
  2026-05-08, `MailerService.sendMail` builds its `recipient` log
  line via `data.to ? this.getDestination(data.to).join(', ') :
  'unknown'`, but the Resend branch unconditionally calls
  `this.getDestination(data.to)` — so when a caller omits `to`,
  the log line says `to=unknown` and then `getDestination(undefined)`
  throws `TypeError: Cannot use 'in' operator to search for
  'address' in undefined`. The SMTP and Faker paths handle a
  missing `to` cleanly. Tracked as a follow-up in `tasks.md`; not
  a regression — current behaviour is pinned by a test in
  `mailer.service.spec.ts`. A fix should short-circuit Resend the
  same way (e.g. `to: data.to ? this.getDestination(data.to) : []`),
  and the test must be updated to assert the new behaviour.
- **OQ-2 (template-context drift).** Each `@OnEvent` handler builds
  its context manually. There is no compile-time check that the
  `*.hbs` template's referenced placeholders match the keys the
  handler provides — drift is caught only at runtime when
  Handlebars `strict: true` rejects the missing key. A future
  improvement could codegen template-key types from the `.hbs`
  files.
- **OQ-3 (`tls.rejectUnauthorized: false`).** The SMTP transport
  accepts self-signed certs by default. This is fine for dev but
  questionable for production deployments that want strict
  certificate validation. Operators MUST audit this gate per
  deployment.

## 9. Constitution Gates

- [x] **I — Plugin-first**: N/A. Mail delivery is a
      platform-cross-cutting concern, not a per-work plugin. Adding
      a new transactional email is an in-repo change to
      `MailService` + `apps/api/src/templates/`.
- [x] **II — Capability-driven**: provider selection is purely
      config-driven (`MAILER_PROVIDER` env var). Swapping SMTP for
      Resend is zero code change, and adding a third backend
      requires only a new switch arm in `MailerService` and a new
      `@nestjs/common` provider in `MailerModule`.
- [x] **III — Source-of-truth repos**: N/A — emails are outbound
      transactional messages, not user-repo state.
- [x] **IV — Trigger.dev / exclusive workers**: N/A — delivery is
      synchronous-from-the-event-handler, off the request hot path.
      The platform deliberately keeps this simple; bursty volume
      lives in the upstream provider's queue.
- [x] **V — Forward-only migrations**: no schema. Adding a template
      is a file-add; renaming a slug requires changing both the
      caller and the file.
- [x] **VI — Tests**: 16 unit tests cover both providers (
      `mailer.service.spec.ts` 14 + `faker-mailer.service.spec.ts` 2)
      including SMTP/Resend/faker branching, recipient log shape,
      Handlebars template read path, Buffer/text body resolution,
      and constructor log
      ([#492](https://github.com/ever-works/ever-works/pull/492)).
      Listener-side coverage of `MailService` is a documented
      follow-up (T15 in `tasks.md`).
- [x] **VII — Secret hygiene**: SMTP credentials and Resend API key
      live in env vars and are never logged. Email bodies never
      include secrets.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      mail delivery behaviour (when emails go out, what they
      contain, how delivery degrades).
- [x] **X — Backwards-compat**: provider switching is non-breaking
      (env-var only); template / event additions are additive;
      existing emails MUST continue to deliver after every change.

## 10. References

- Implementation:
    - Service: `apps/api/src/mail/mail.service.ts`
    - Provider router: `apps/api/src/mail/providers/mailer.service.ts`
    - Faker fallback: `apps/api/src/mail/providers/faker-mailer.service.ts`
    - Module wiring: `apps/api/src/mail/mail.module.ts`
    - Types: `apps/api/src/mail/types.ts`
    - Templates: `apps/api/src/templates/{signup-confirmation,welcome,password-changed,forgot-password,new-device-login,account-deletion,member-invitation}.hbs`
- Tests:
    - `apps/api/src/mail/providers/mailer.service.spec.ts` (14)
    - `apps/api/src/mail/providers/faker-mailer.service.spec.ts` (2)
- Config: `apps/api/src/config/constants.ts` (`config.mail.*`,
  `config.branding.*`).
- Related feature specs:
    - [`../notifications/spec.md`](../notifications/spec.md) — sibling
      surface (notifications are in-app, mail-providers is outbound
      email — both consume some of the same domain events but are
      decoupled).
    - [`../activity-log/spec.md`](../activity-log/spec.md) — listens
      to the same user-lifecycle events for the audit trail.
- PR:
  [#492](https://github.com/ever-works/ever-works/pull/492) — added
  the 16 unit tests covering both providers and pinned the
  Resend-with-undefined-`to` follow-up bug (OQ-1).
