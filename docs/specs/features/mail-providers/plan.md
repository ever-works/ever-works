# Implementation Plan: Mail Providers

**Feature ID**: `mail-providers`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    Event[Domain @OnEvent\nUserCreatedEvent / UserConfirmedEvent /\nUserPasswordChangedEvent / UserForgotPasswordEvent /\nUserNewDeviceLoginEvent / UserAccountDeletionEvent /\nMemberInvitedEvent] --> Listener[MailService.send<Kind>\n@OnEvent handler]
    Listener -->|getBrandingContext +\nevent payload| Mailer[MailerService.sendMail]
    Mailer --> Provider{config.mail.provider}
    Provider -->|smtp| Smtp[SmtpMailerService\n@nestjs-modules/mailer\n+ HandlebarsAdapter]
    Provider -->|resend AND RESEND_CLIENT bound| Resend[Resend.emails.send\n{to, from, subject, html}]
    Provider -->|resend BUT RESEND_CLIENT undefined| Warn[logger.warn fallback]
    Warn --> Faker[FakerMailerService.sendMail\ndebug log, no-op]
    Provider -->|other / unset / 'none' / 'faker'| Faker
    Mailer --> ReadTemplate[readHtmlTemplate\nfs.readFile cwd/src/templates/<slug>.hbs\nHandlebars.compile + context]
    ReadTemplate --> Resend
    Smtp --> SmtpServer[(SMTP host)]
    Resend --> ResendApi[(Resend API)]
    Faker --> Noop[(no-op)]
```

## 2. Tech Choices

| Concern              | Choice                                                                     | Rationale                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Event ingestion      | NestJS `@OnEvent` listeners (`@nestjs/event-emitter`)                      | Decouples mail delivery from domain code; event handler runs off the request hot path                                      |
| Provider abstraction | `MailerService` switch keyed on `config.mail.provider()`                   | Capability-driven (Constitution Principle II); env-var driven swap, zero code change                                       |
| SMTP transport       | `@nestjs-modules/mailer` + Handlebars adapter                              | Battle-tested wrapper around Nodemailer; `inlineCssEnabled: true` + `strict: true`                                         |
| Resend transport     | `resend` SDK (`Resend.emails.send`)                                        | First-class TypeScript SDK; `RESEND_CLIENT` is a Nest provider so we can swap it in tests                                  |
| Local-dev fallback   | `FakerMailerService`                                                       | Lets local developers run the API without configuring a real provider; logs payloads at debug level                        |
| Template engine      | Handlebars                                                                 | Required by `@nestjs-modules/mailer`'s adapter; works for the Resend path via direct `Handlebars.compile`                  |
| Templates location   | `apps/api/src/templates/*.hbs`                                             | Lives next to the API code; `path.join(process.cwd(), 'src/templates', '<slug>.hbs')`                                      |
| Branding context     | `config.branding.{appName, companyOwner, platformWebsite}` + `currentYear` | Single source of truth; merged into every template render                                                                  |
| Error policy         | `try/catch` + `logger.error` per handler                                   | Mail delivery failures MUST NOT propagate back to the originating event emitter (Constitution Principle VI tests pin this) |

## 3. Data Model

No persistent storage. The feature is stateless — each mail delivery
is event-driven and synchronous-from-the-listener. The `RESEND_CLIENT`
NestJS provider is a singleton per process.

```ts
// apps/api/src/mail/types.ts
export interface Address {
	name: string;
	address: string;
}

export interface SendMailOptions {
	to?: string | Address | Array<string | Address>;
	cc?: string | Address | Array<string | Address>;
	bcc?: string | Address | Array<string | Address>;
	replyTo?: string | Address | Array<string | Address>;
	inReplyTo?: string | Address;
	from?: string | Address;
	subject?: string;
	text?: string | Buffer;
	html?: string | Buffer;
	sender?: string | Address;
	raw?: string | Buffer;
	references?: string | string[];
	encoding?: string;
	date?: Date | string;
	context?: { [name: string]: any };
	transporterName?: string;
	template?: string;
}
```

## 4. API Surface

The mail-providers feature is **internal** — it exposes no HTTP
endpoints. Public callers interact via emitting one of the seven
domain events. Internal services interact via
`MailerService.sendMail(options: SendMailOptions): Promise<void>`.

| Trigger event              | Template slug         | Notable defaults                                               |
| -------------------------- | --------------------- | -------------------------------------------------------------- |
| `UserCreatedEvent`         | `signup-confirmation` | —                                                              |
| `UserConfirmedEvent`       | `welcome`             | `dashboardUrl` defaults to `${webAppUrl}/works/new`            |
| `UserPasswordChangedEvent` | `password-changed`    | `formatDateTime(changedAt)`                                    |
| `UserForgotPasswordEvent`  | `forgot-password`     | `expiresIn` defaults to `'1 hour'`                             |
| `UserNewDeviceLoginEvent`  | `new-device-login`    | `formatDateTime(loginTime)`; passes device + browser + IP      |
| `UserAccountDeletionEvent` | `account-deletion`    | `expiresIn` defaults to `'24 hours'`                           |
| `MemberInvitedEvent`       | `member-invitation`   | `formatRoleName(role)` (capitalise first char, lowercase rest) |

## 5. Plugin / Web / CLI

- **Plugin**: no plugin surface today. Adding a new transactional
  email is an in-repo change: drop a `<slug>.hbs` file, add a domain
  event class, and wire a new `@OnEvent` handler in `MailService`.
- **Web**: indirect — actions in the web app emit the underlying
  events (`forgot password`, `invite member`, etc.). The web app
  never calls `MailerService` directly.
- **CLI**: indirect — CLI commands that mutate user state emit the
  same events through the API and inherit the same delivery paths.

## 6. Background Jobs

There are **no** dedicated background jobs. Each delivery runs
inside the originating `@OnEvent` handler. The provider's own
upstream queue (Nodemailer pool, Resend's API queue) absorbs bursty
volume.

## 7. Security & Permissions

- **Provider credentials**: SMTP user/password and Resend API key
  live exclusively in env vars (`SMTP_USER`, `SMTP_PASSWORD`,
  `RESEND_APIKEY`). They are never logged.
- **TLS**: the SMTP transport sets `tls.rejectUnauthorized: false`
  to support self-signed certs in dev. Production deployments MUST
  audit this gate per FR-? in the spec (OQ-3).
- **Email body content**: templates render only safe placeholders
  — usernames, work names, URLs, device strings. They never embed
  passwords, hashes, OAuth tokens, or API keys. Reviewers MUST
  flag any template that does.
- **Logging**: recipient email addresses appear in INFO-level
  logs to support delivery diagnostics; body content is never
  logged.
- **Token expiry**: confirmation, reset, and account-deletion
  links carry one-shot tokens whose expiries are computed by the
  caller (`AuthService` for password reset / signup confirm;
  `account` module for deletion). Mail delivery does not cache
  tokens.

## 8. Observability

- **Construction log**: `Mailer service initialized with provider:
<provider>` (info, once at boot).
- **Per-call SMTP**:
    - `Sending email via SMTP to=<recipient> subject="<subject>"`
    - `Email sent via SMTP to=<recipient>`
- **Per-call Resend**: - `Sending email via Resend to=<recipient> from="<from>"
subject="<subject>"` - `Email sent via Resend to=<recipient> id=<resendId | "unknown">`
- **Resend fallback**: - `Resend client not initialized (missing RESEND_APIKEY?),
falling back to faker for to=<recipient>` (warn).
- **Faker default**:
    - `No mail provider configured, using faker for to=<recipient>`
      (debug).
- **Faker handler**:
    - `FakerMailerService:sendMail to=<to> subject="<subject>"`
      (debug).
- **MailService delivery failure**:
    - `Failed to send <kind> to <email>` + stack (error).

## 9. Risks & Mitigations

| Risk                                                              | Mitigation                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAILER_PROVIDER=resend` with missing `RESEND_APIKEY` crashes API | `RESEND_CLIENT` factory returns `undefined`; runtime fallback in `MailerService.sendMail` warns and routes through Faker                     |
| Garbage `MAILER_PROVIDER` value crashes API                       | `default` switch arm routes through Faker                                                                                                    |
| Mail delivery throws and breaks signup / password reset flow      | Per-handler `try/catch` + `logger.error` — listener swallows the rejection                                                                   |
| Template referenced placeholder missing from context              | `HandlebarsAdapter` is built with `{strict: true}` so missing keys throw at render time — caught by per-handler `try/catch` (OQ-2 follow-up) |
| `Resend.emails.send` called with `to=undefined`                   | Currently throws `TypeError: Cannot use 'in' operator …` — pinned by current tests; FR-9 / OQ-1 follow-up tracks the proper guard            |
| SMTP auth or network failure                                      | Caught by `MailService` per-handler `try/catch` and logged; upstream provider handles its own retry/backoff                                  |
| Self-signed cert in production                                    | `tls.rejectUnauthorized: false` is intentional for dev — operators MUST audit per OQ-3                                                       |

## 10. Constitution Reconciliation

See `spec.md` §9.

## 11. References

- Spec: `./spec.md`
- Service: `apps/api/src/mail/mail.service.ts`
- Provider router: `apps/api/src/mail/providers/mailer.service.ts`
- Faker fallback: `apps/api/src/mail/providers/faker-mailer.service.ts`
- Module: `apps/api/src/mail/mail.module.ts`
- Types: `apps/api/src/mail/types.ts`
- Templates: `apps/api/src/templates/*.hbs`
- Tests:
    - `apps/api/src/mail/providers/mailer.service.spec.ts` (14)
    - `apps/api/src/mail/providers/faker-mailer.service.spec.ts` (2)
- Config: `apps/api/src/config/constants.ts` (`config.mail.*`,
  `config.branding.*`).
