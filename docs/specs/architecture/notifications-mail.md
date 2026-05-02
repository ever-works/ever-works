# Architecture: Notifications & Mail

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers wiring new notification kinds,
adding email templates, debugging delivery, or extending the mailer
provider abstraction.

---

## 1. Purpose

The platform sends users two kinds of messages:

- **In-app notifications** — persisted rows the dashboard renders in
  a notifications drawer; mark-as-read state, pagination, filters.
- **Emails** — transactional messages (invitations, schedule
  pause-out, OAuth re-auth needed, payment failed) routed through a
  mailer provider abstraction.

Both share the same triggering events but differ in delivery
mechanics, retention, and provider strategy. This spec covers the
**delivery split**, the **mailer provider abstraction**, the **template
layer**, and the **idempotency model** that prevents the platform
from spamming users when an event fires multiple times.

## 2. Module Layout

```
apps/api/src/notifications/
├── notifications.controller.ts        # /api/notifications/* HTTP surface
├── notification-cleanup.service.ts    # Periodic purge of old rows
├── notifications.module.ts
└── index.ts

packages/agent/src/notifications/
├── notification.service.ts            # Domain service: emit, fan-out
├── notifications.module.ts
└── index.ts

apps/api/src/mail/
├── mail.module.ts
├── mail.service.ts                    # MailFacade — provider-agnostic API
├── types.ts                           # Email payload shapes
└── providers/
    ├── mailer.service.ts              # Production SMTP / API mailer
    └── faker-mailer.service.ts        # Captures emails for tests / dev
```

The split mirrors [`subscriptions`](./subscriptions.md) and
[`auth`](./auth.md): HTTP controllers in `apps/api`, domain logic in
`packages/agent` so Trigger.dev tasks and the internal CLI can emit
notifications without going through HTTP.

## 3. The Trigger Surface

Domain code emits notifications via a **single entry point**:

```ts
await notificationService.notify({
	userId,
	kind: NotificationKind.SCHEDULE_PAUSED,
	directoryId,
	payload: {
		directoryName: directory.name,
		failureCount,
		reason
	},
	channels: ['in_app', 'email']
});
```

The service:

1. **Resolves the user's preferences** for that notification kind
   (some kinds the user can mute; security-critical ones are always
   sent).
2. **Renders templates** for each requested channel (§5).
3. **Persists in-app** rows for the `in_app` channel.
4. **Hands off to mail** for the `email` channel.
5. **Records an activity log** entry (`NOTIFICATION_SENT`) for audit.

`NotificationKind` is an enum; today's values include:

| Kind                     | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `MEMBER_INVITED`         | You were invited to a directory                      |
| `SCHEDULE_PAUSED`        | Schedule auto-paused after consecutive failures      |
| `GENERATION_COMPLETED`   | Generation finished (opt-in)                         |
| `GENERATION_FAILED`      | Generation failed                                    |
| `OAUTH_REAUTH_REQUIRED`  | Provider token revoked; reconnect to keep generating |
| `PAYMENT_FAILED`         | Stripe payment failed; plan downgrade pending        |
| `COMMUNITY_PR_PROCESSED` | Community PR was merged into your directory          |
| `CUSTOM_DOMAIN_VERIFIED` | Domain DNS verified; site available                  |

Adding a new kind is one enum value + one template + one renderer
function — by design, it doesn't require touching every notification
emitter.

## 4. The In-App Channel

In-app notifications are rows in the `notifications` table:

```ts
@Entity('notifications')
export class Notification {
	@PrimaryGeneratedColumn('uuid') id: string;
	@Column() userId: string;
	@Column({ nullable: true }) directoryId: string | null;
	@Column({ type: 'varchar' }) kind: NotificationKind;
	@Column() title: string;
	@Column() body: string;
	@Column({ nullable: true }) actionUrl: string | null;
	@Column({ default: false }) read: boolean;
	@CreateDateColumn() createdAt: Date;
}
```

The dashboard reads:

| Method   | Endpoint                           | Description                     |
| -------- | ---------------------------------- | ------------------------------- |
| `GET`    | `/api/notifications`               | Paginated; `unread=true` filter |
| `POST`   | `/api/notifications/mark-all-read` | Mark every notification read    |
| `POST`   | `/api/notifications/:id/mark-read` | Mark one read                   |
| `DELETE` | `/api/notifications/:id`           | Soft-delete                     |

Reads are paginated offset-style (limit 20, max 100). The notifications
drawer subscribes to a WebSocket channel for live arrivals — see
[`web-dashboard`](./web-dashboard.md#9-real-time-ui) for the pattern.

### 4.1 Cleanup

`NotificationCleanupService` runs as a Trigger.dev cron (daily at
03:00 UTC) and **soft-deletes** notifications older than 90 days for
read entries / 180 days for unread. Hard-delete happens in a
quarterly sweep.

## 5. The Template Layer

Email templates live in `apps/api/src/templates/` (covered by the
[`templates` API doc](../../api/email-templates.md)). Each template
exposes:

- `subject(payload): string` — email subject.
- `html(payload): string` — HTML body.
- `text(payload): string` — plain-text fallback.
- `inAppTitle(payload): string` — in-app notification title.
- `inAppBody(payload): string` — in-app notification body.

A single template module covers both channels so notifications **can't
get out of sync** between in-app text and email text. Adding a new
notification kind requires one template module; it's impossible to
half-finish a kind.

Templates accept a typed `payload` per kind so renderers don't crash
on missing fields. The TypeScript narrows the payload shape at the
template's call site.

### 5.1 Localisation

Each template's renderer accepts a `locale` argument and consults
`@ever-works/contracts/api/locales` to pick the right translation
file. Subjects + bodies live in per-locale JSON bundles:

```
templates/<kind>/
├── render.ts                  # The render functions
├── locales/
│   ├── en.json
│   ├── fr.json
│   └── ...
```

Fallback is English when a locale is missing. `text(payload)` is
generated from `html(payload)` automatically via `html-to-text` if not
explicitly provided.

## 6. The Mailer Provider Abstraction

`MailService` (`mail.service.ts`) is the platform-side facade. It
delegates to a `MailerProvider`:

```ts
interface MailerProvider {
	send(email: EmailPayload): Promise<{
		id: string;
		provider: string;
		status: 'sent' | 'queued' | 'failed';
	}>;
}
```

Two implementations today:

| Provider             | When                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `MailerService`      | Production. Uses SMTP (default) or a transactional API (Postmark, SendGrid, Resend depending on env). |
| `FakerMailerService` | Tests + dev. Stores emails in memory; the test harness reads them via `getCapturedEmails()`.          |

Provider selection is by env vars at module init:

| `MAILER_PROVIDER` | Effect                                              |
| ----------------- | --------------------------------------------------- |
| `smtp` (default)  | `MailerService` with SMTP config                    |
| `postmark`        | `MailerService` with Postmark API                   |
| `sendgrid`        | `MailerService` with SendGrid API                   |
| `resend`          | `MailerService` with Resend API                     |
| `faker`           | `FakerMailerService` (also auto-selected in tests)  |
| `disabled`        | A no-op provider that logs each `send` and discards |

`disabled` is a self-hosted-friendly default — the platform boots and
runs without SMTP credentials, but emails are dropped (visible in
logs).

## 7. Idempotency & Coalescing

Some notification triggers fire multiple times in succession (a
schedule retrying, a webhook redelivering). The notification service
guards against duplicate user-visible messages via:

1. **Per-kind idempotency window** — within a configurable window
   (default 5 minutes per kind), a duplicate `(userId, kind, directoryId,
payloadHash)` triple is suppressed silently.
2. **Cache-backed lookup** — the idempotency key is stored in
   [`cache_entries`](./cache.md) under namespace `notification-idem`
   with TTL = the window.
3. **Coalescing for high-volume kinds** — `GENERATION_COMPLETED`
   notifications coalesce within a 60-second window so a user who
   runs five quick generations gets one summary notification, not
   five.

Security-critical kinds (`PAYMENT_FAILED`, `OAUTH_REAUTH_REQUIRED`)
bypass coalescing — the user must see them every time.

## 8. Delivery Reliability

The mail layer is best-effort:

- **Send failures don't block the request** — a `try/catch` around
  each `provider.send` logs the failure and returns. The user-facing
  operation that triggered the notification still succeeds.
- **Retries** for `failed` status — a Trigger.dev task picks up
  failed emails (per provider, per webhook signature) and retries
  with exponential backoff up to 24 hours. After 24 hours, the
  email is dropped and an activity-log entry records the
  permanent failure.
- **No transactional dependency** — emails are _not_ part of the
  underlying mutation's transaction. A directory invitation
  succeeds even if the email fails (the user is still a member;
  they'll see the directory in their dashboard regardless).

In-app notifications are stronger: they're persisted as part of the
notification service's call, which runs in the **same transaction** as
the underlying mutation. If the mutation rolls back, the notification
row rolls back too.

## 9. Webhooks (Inbound)

Some providers (Postmark, SendGrid) post webhooks for delivery
events. `MailerService` exposes `handleWebhook(provider, payload)`
that:

1. Verifies the provider signature.
2. Updates the originating activity-log row's `details.status` to
   `delivered` / `bounced` / `complained`.
3. For repeat `bounced` / `complained`, marks the user's email as
   `unverified` and surfaces a dashboard banner.

Webhook endpoints are `@Public()` (verified by signature, not auth)
and namespaced per provider.

## 10. Observability

Each `notify(...)` call emits Sentry breadcrumbs:

- `notification.kind`
- `notification.channels` (sent + skipped)
- `notification.idempotency` (hit / miss)

Failed emails Sentry-capture with the provider's response, the user
id, and the kind. PostHog gets a `notification_sent` event keyed on
`kind` + `channel`, useful for tracking which notifications drive
re-engagement.

Cleanup task emits a daily summary log line:

```
notification-cleanup: soft_deleted=1234 hard_deleted=567 oldest=2025-12-01
```

## 11. User Preferences

Each user can mute a configurable subset of notification kinds via
**Settings → Notifications**. Preferences live in `user_preferences`
(jsonb) under the `notifications` key:

```json
{
	"notifications": {
		"GENERATION_COMPLETED": { "in_app": false, "email": false },
		"MEMBER_INVITED": { "in_app": true, "email": true }
	}
}
```

`notificationService` consults preferences before fan-out and
**never** allows muting security-critical kinds. The settings UI greys
out those toggles.

## 12. Constitution Reconciliation

| Principle                   | How notifications/mail respects it                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| I — Plugin-first            | Mailer provider is interface-first; SMTP / Postmark / SendGrid / Resend are pluggable.    |
| II — Capability-driven      | `MailerProvider` selection by env var matches the capability-resolution pattern.          |
| III — Source-of-truth repos | Notifications are platform-side; never written to user repos.                             |
| IV — Trigger.dev            | Cleanup + retry tasks run as Trigger.dev cron + queues.                                   |
| V — Forward-only migrations | `notifications` schema is additive; new `kind` values add enum entries.                   |
| VI — Tests                  | `notification.service.spec.ts` + `mail.service.spec.ts` cover all kinds + provider modes. |
| VII — Secret hygiene        | SMTP creds + provider API keys in encrypted env-var store; templates never echo secrets.  |
| VIII — Plugin counts        | N/A.                                                                                      |
| IX — Behaviour-first        | This spec describes observable notification behaviour.                                    |
| X — Backwards-compat        | New kinds + new providers are additive.                                                   |

## 13. References

- Source:
    - `apps/api/src/notifications/`
    - `apps/api/src/mail/`
    - `apps/api/src/templates/`
    - `packages/agent/src/notifications/`
- Related specs:
    - [`activity-log`](./activity-log.md)
    - [`features/directory-members/spec`](../features/directory-members/spec.md)
    - [`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)
    - [`subscriptions`](./subscriptions.md)
    - [`cache`](./cache.md) (notification idempotency keys)
- User docs:
    - [`docs/api/notifications.md`](../../api/notifications.md)
    - [`docs/api/mail.md`](../../api/mail.md)
    - [`docs/api/email-templates.md`](../../api/email-templates.md)
