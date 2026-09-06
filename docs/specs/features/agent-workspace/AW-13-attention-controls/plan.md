# AW-13 — Notification matrix & attention budget · Implementation plan

> How the behaviour in [spec.md](./spec.md) is built. Ordered work lives in [tasks.md](./tasks.md).
> Every path below was verified to exist in this worktree before being cited.

**Epic ID:** `AW-13-attention-controls`
**Program:** [Agent Workspace](../README.md) — Wave 2
**Status:** `Draft` · **Last updated:** 2026-09-06

---

## 1. Current state in the codebase

### 1.1 The subsystem is mature; the last mile is missing

Notifications in Ever Works are two layers. **v1** writes an in-app row and is called directly by
~16 typed producers. **v2** ("event subscriptions") layers a registry, per-user subscriptions,
quiet hours, category mutes and multi-channel fan-out on top without changing v1. The v2 backend
is complete and security-reviewed. Its **UI is a stub**, its **registry is incomplete**, and
**email is not a delivery target at all**.

| Piece | Where | State |
| --- | --- | --- |
| In-app record | [`packages/agent/src/entities/notification.entity.ts`](../../../../../packages/agent/src/entities/notification.entity.ts) (`notifications`) | Complete. Unique `(userId, deduplicationKey)`; `isPersistent` rows refuse dismissal. |
| Producers | [`packages/agent/src/notifications/notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts) | 16 typed `notify*` methods. Each writes the in-app row, then calls a private `dispatchFanout` that emits the v2 fan-out event. |
| Event registry | [`packages/agent/src/entities/notification-event-type.entity.ts`](../../../../../packages/agent/src/entities/notification-event-type.entity.ts) (`notification_event_types`, PK `key`) | Columns: `category`, `title`, `description`, `urgent`, `defaultChannels`, `source`, `pluginId`. |
| Registry seeding | [`apps/api/src/notifications/notification-event-type-bootstrap.service.ts`](../../../../../apps/api/src/notifications/notification-event-type-bootstrap.service.ts) + [`apps/api/src/migrations/1780000010000-SeedNotificationEventTypes.ts`](../../../../../apps/api/src/migrations/1780000010000-SeedNotificationEventTypes.ts) | `CORE_EVENTS` holds **15** rows and is upserted on every boot (idempotent). Plugin manifests contribute more, namespaced `<pluginId>:<key>`. |
| Subscriptions | [`packages/agent/src/entities/user-notification-subscription.entity.ts`](../../../../../packages/agent/src/entities/user-notification-subscription.entity.ts) | Unique `(userId, eventTypeKey)`; `channelIds` is a JSON array of channel row ids and/or the literal `'in-app'`. |
| Quiet hours | [`packages/agent/src/entities/user-notification-preference.entity.ts`](../../../../../packages/agent/src/entities/user-notification-preference.entity.ts) (PK `userId`) | `quietHoursStart` / `quietHoursEnd` as `varchar(8)` (deliberately not SQL `time` — the SQLite test driver), plus `timezone`. |
| Resolver | [`packages/agent/src/notifications/user-notification-subscription.service.ts`](../../../../../packages/agent/src/notifications/user-notification-subscription.service.ts) | `resolvePlan(userId, eventKey)` → `{ immediate, deferred, deferUntil }`. Fallback chain: subscription → organization default → event default → `['in-app']`. Then category mute (drop non-in-app), then quiet hours (defer non-in-app for non-urgent). |
| Fan-out listener | [`apps/api/src/notifications/notification-fanout.listener.ts`](../../../../../apps/api/src/notifications/notification-fanout.listener.ts) | `@OnEvent(..., { async: true, suppressErrors: true })`. Strips `'in-app'` and hands the rest to the channel facade. |
| Channel fan-out | [`packages/agent/src/facades/notification-channel.facade.ts`](../../../../../packages/agent/src/facades/notification-channel.facade.ts) | `send()` → `dispatchOrSend()` per target. `'in-app'` is an inline **sentinel**; everything else is enqueued through the optional `NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER`, falling back to in-process delivery when unbound. `deliverToChannelOrThrow()` is the retry primitive. |
| Delivery worker | [`packages/tasks/src/tasks/trigger/notification-channel-delivery.task.ts`](../../../../../packages/tasks/src/tasks/trigger/notification-channel-delivery.task.ts) | One run per (target, event). Retry 30s → 2m → 8m → 32m → 2h, `maxAttempts: 5`. Supports a `delay` for quiet-hours deferral. |
| Delivery log | [`packages/agent/src/entities/notification-channel-delivery-log.entity.ts`](../../../../../packages/agent/src/entities/notification-channel-delivery-log.entity.ts) | One row per attempt. `channelId` is `uuid NOT NULL` with an FK to `notification_channels`. |
| Channel plugins | `packages/plugins/{slack,discord,telegram,whatsapp,novu}-channel/` | Five. **No email channel plugin exists.** |
| Preferences API | [`apps/api/src/notifications/notification-preferences.controller.ts`](../../../../../apps/api/src/notifications/notification-preferences.controller.ts) + [`notification-preferences.service.ts`](../../../../../apps/api/src/notifications/notification-preferences.service.ts) | Six routes, all working. `BUILT_IN_CHANNEL_IDS` currently holds one member, `'in-app'`. `MAX_SUBSCRIPTION_CHANNELS = 20`. |
| Settings page | [`apps/web/src/app/[locale]/(dashboard)/settings/notifications/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/settings/notifications/page.tsx>) | Server component; four parallel fetches; renders the optional Novu widget and the matrix. |
| Matrix component | [`apps/web/src/components/settings/NotificationPreferencesSettings.tsx`](../../../../../apps/web/src/components/settings/NotificationPreferencesSettings.tsx) | 100 lines. Checkboxes use `defaultChecked` and have **no `onChange`**. No `useTranslations`. Its own comment says "v0". |
| Web API clients | [`apps/web/src/lib/api/notification-preferences.ts`](../../../../../apps/web/src/lib/api/notification-preferences.ts), [`notification-channels.ts`](../../../../../apps/web/src/lib/api/notification-channels.ts) | Both complete and typed; the preferences client already has `setEventSubscription`. |
| Bell | [`apps/web/src/components/dashboard/NotificationDropdown.tsx`](../../../../../apps/web/src/components/dashboard/NotificationDropdown.tsx) | 30 s poll of the unread count; lazy list fetch on open. No link to settings. |
| Digest | [`packages/agent/src/digest/digest.service.ts`](../../../../../packages/agent/src/digest/digest.service.ts), [`digest.types.ts`](../../../../../packages/agent/src/digest/digest.types.ts) | Deterministic composition + optional narrative; `renderMarkdown` builds sections; `MAX_ITEMS_PER_SECTION` caps each. Delivered as an in-app notification through `notifyDigest`. |
| Digest cron | [`packages/tasks/src/tasks/trigger/digest-dispatcher.task.ts`](../../../../../packages/tasks/src/tasks/trigger/digest-dispatcher.task.ts) | `15 7 * * *`; weekly rides Mondays in the same run. |
| Budget alerts | [`apps/api/src/budgets/budget-alert.handler.ts`](../../../../../apps/api/src/budgets/budget-alert.handler.ts) | Writes the in-app row, tracks analytics, then sends its **own** email through `MailService`, gated only on `users.emailBudgetAlerts`. It never reaches the v2 fan-out. |
| Transactional mail | [`apps/api/src/mail/mail.service.ts`](../../../../../apps/api/src/mail/mail.service.ts), [`mail.module.ts`](../../../../../apps/api/src/mail/mail.module.ts), [`templates.ts`](../../../../../apps/api/src/mail/templates.ts), templates in [`apps/api/src/templates/`](../../../../../apps/api/src/templates/) | 11 registered Handlebars templates (including `budget-alert.hbs`). `MailModule` exports `MailService` and imports nothing from the notifications tree — no cycle risk. |
| Cleanup cron | [`apps/api/src/notifications/notification-cleanup.service.ts`](../../../../../apps/api/src/notifications/notification-cleanup.service.ts) | Daily 03:00, wrapped in `DistributedTaskLockService.runExclusive` (1 h TTL). |

### 1.2 The five concrete defects this epic fixes

1. **The matrix never saves.** `NotificationPreferencesSettings.tsx` has no change handler, no
   mutation call and no translations, while `PUT /api/notifications/preferences/event/:eventKey`
   has existed and worked all along.
2. **Eight producer keys have no registry row.** Grepping `eventKey:` in
   `notification.service.ts` yields `credits_balance_exhausted`, `payg_cap_${percent}` (which is
   only ever `payg_cap_80` or `payg_cap_100` — the producer's `percent` is typed `80 | 100`),
   `payg_past_due`, `digest_ready`, `memory_consolidation_ready`. `notifyBudgetThresholdCrossed`
   emits no fan-out at all. `resolvePlan` returns `{ immediate: ['in-app'], deferred: [] }` for
   an unknown key, so these are permanently in-app-only *and invisible in the matrix*, which is
   why nobody has noticed.
3. **Two registry categories are not mutable.** `git_auth_expired` is registered under
   `integrations` and `agent_run_finished` under `agents`; neither string is a member of the
   category enum in [`notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts),
   and `POST /api/notifications/preferences/mute` validates against that enum, so those two rows
   can never be muted.
4. **An empty selection silently reverts.** `loadInitialChannels` only honours a subscription when
   `sub.channelIds.length > 0`; an explicit "nothing" therefore falls through to the org default
   and then the event default.
5. **There is no email target.** `BUILT_IN_CHANNEL_IDS` holds only `'in-app'`;
   `NotificationChannelsService.create` accepts **any** `pluginId` string, so a user can create a
   row that claims to be `email` and it will fail at send time with "plugin not found".

### 1.3 What is already right and must not be disturbed

Owner-scoped channel lookups (`findByIdForUser`), secret redaction before persistence, the
envelope-encrypted `targetConfig` column, timing-safe comparisons elsewhere in the tree, the
`suppressErrors` posture on the fan-out listener, and the rule that v1's in-app write can never be
blocked by a v2 failure. Every change below preserves all of it.

---

## 2. Architecture and the seam

### 2.1 One pipeline, five stages, no new transport

```
 notify*()  ──► create() in-app row ─────────────────────────────► notifications table
    │                (unconditional; gains `isSilent`)
    │
    └─► dispatchFanout(NOTIFICATION_FANOUT_EVENT)
              │
              ▼
     NotificationFanoutListener  (apps/api)
              │
              ├─► UserNotificationSubscriptionService.resolvePlan()
              │       registry ▸ subscription ▸ org default ▸ event default
              │       ▸ category mute ▸ quiet hours                       (EXISTING)
              │
              ├─► AttentionBudgetService.admit(plan)                      (NEW, P2)
              │       per (user, class) rolling-24h count from the
              │       delivery log; urgent bypasses; over-limit →
              │       AttentionHold row instead of a target
              │
              └─► NotificationChannelFacadeService.send(targets)          (EXISTING)
                        │
                        ├─ 'in-app'  → inline sentinel, no-op (v1 already wrote it)
                        ├─ 'email'   → NEW sentinel → NotificationEmailSender port
                        └─ <uuid>    → channel plugin, unchanged
                                 all three log to notification_channel_delivery_log
```

The seam is deliberately narrow. **Three** insertion points:

1. a second built-in sentinel (`'email'`) in the facade, beside the one that already exists;
2. one call to a new admission service between the resolver and the facade, in the listener;
3. one extra section builder in digest composition.

Everything else is configuration, data and UI.

### 2.2 Why email is a sentinel and not a plugin

Constitution I requires a plugin package for any **external integration**. Notification email to
the *account address* is not an integration: it is the same first-party transactional mail path
that already sends password resets, magic links, member invitations and budget alerts, behind
`MailService` and its SMTP/Resend/faker providers. Adding a sixth channel plugin would mean the
user has to "connect" their own account address to be emailed by the product that already emails
them — and would duplicate the transport. The two email-provider plugins that do exist
(`packages/plugins/mailgun`, `packages/plugins/mailchimp-transactional`) serve
`EmailFacadeService` and tenant-managed **agent** addresses, which is a different feature
([AW-05](../AW-05-agent-email/)) and stays untouched.

The sentinel is symmetrical with `'in-app'`: a reserved id that is not a `notification_channels`
row, exempted from the ownership check, and handled inline by the facade.

### 2.3 Why the budget counts from the delivery log

The delivery log already records one row per attempt, with `messageRef` (unique per delivery) and
`createdAt`. Adding a denormalised `userId` (Tier-C, matching the `tenantId`/`organizationId`
columns already on that table) plus an index on `(userId, createdAt)` turns "how many interrupting
deliveries has this user had in 24 hours" into one indexed aggregate over
`COUNT(DISTINCT "messageRef")`. No counter table, no cache, no drift. The alternative — a
dedicated counter row — needs its own reset job and can disagree with what was actually sent.

### 2.4 Why the hold is released by the digest and nothing else

A second delivery mechanism ("send the overflow at midnight") would reintroduce exactly the
unbounded interruption the budget exists to stop. The digest already exists, already runs on a
cron, already composes deterministic sections, and is already the product's answer to "what
happened while I was not looking". Releasing holds there costs one section and zero new jobs, and
gives the budget card an honest thing to say when a user has no digest: turn one on.

### 2.5 Target classes

Two, and only two, are budgeted:

| Class | Members | Default ceiling |
| --- | --- | --- |
| `email` | the built-in email sentinel | 10 / 24 h |
| `channel` | every `notification_channels` row, all providers together | 20 / 24 h |

`in-app` is not a class and is never counted. The spec's open question about per-channel ceilings
is deliberately left unimplemented.

---

## 3. Data model

Two migrations, one per phase, each shipping in the PR that changes the entity
(Constitution V). Timestamps are chosen to sort after
`apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts` and to avoid the ranges other
Agent-Workspace epics have claimed.

### 3.1 P1 — `apps/api/src/migrations/1789500000000-AttentionMatrixFoundations.ts`

**a. `notifications` — one additive column**

`packages/agent/src/entities/notification.entity.ts`:

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `isSilent` | `boolean` | no | `false` | FR-21. The row is written, but excluded from the unread count and the bell's default list. |

Plus an index `idx_notifications_user_silent_read` on `("userId", "isSilent", "isRead")`, created
`CONCURRENTLY`, to keep the unread-count query on an index after the extra predicate.

**b. `notification_channel_delivery_log` — widen for built-in targets**

`packages/agent/src/entities/notification-channel-delivery-log.entity.ts`:

| Change | Statement shape | Why |
| --- | --- | --- |
| `channelId` becomes nullable | `ALTER COLUMN "channelId" DROP NOT NULL` | A built-in target has no channel row. Forward-only and non-destructive: existing rows are untouched and the FK stays. |
| new `builtInChannel` | `varchar(16) NULL` | `'email'` (and `'in-app'` if we ever log it). Exactly one of `channelId` / `builtInChannel` is set. |
| new `userId` | `uuid NULL` | Tier-C denormalisation, matching `tenantId`/`organizationId` already on this table. **No FK** — same cycle-avoidance convention those two columns follow. |
| index | `idx_ncdl_user_created` on `("userId", "createdAt")`, `CONCURRENTLY` | The budget count (§2.3). |

The entity's `@ManyToOne(() => NotificationChannel)` becomes optional; `channelId` becomes
`string | null`.

**c. `notification_event_types` — data only, no shape change**

The migration performs three idempotent data operations, each `INSERT … ON CONFLICT DO UPDATE` or
a targeted `UPDATE`, mirroring what `CORE_EVENTS` will now assert at bootstrap:

1. **Insert 8 missing rows** — `credits_balance_exhausted`, `payg_cap_80`, `payg_cap_100`,
   `payg_past_due`, `budget_threshold_warning`, `budget_threshold_reached`,
   `memory_consolidation_ready`, `digest_ready`.
2. **Correct 2 categories** — `git_auth_expired`: `integrations` → `security`;
   `agent_run_finished`: `agents` → `agent`.
3. **Correct 4 urgency flags and all 23 `defaultChannels`** to the table in
   [spec §4.5 FR-26](./spec.md#45-the-event-catalogue-and-its-defaults). `defaultChannels`
   becomes `['in-app']`, `['in-app','email']`, `['email']` or `[]` per row.

`source` stays `'core'`; plugin-contributed rows are never touched.

**d. `user_notification_subscriptions` — data only**

Backfill for FR-28: for every user with `users."emailBudgetAlerts" = false`, insert (on conflict
do nothing) two subscription rows — `budget_threshold_warning` and `budget_threshold_reached` —
with `channelIds = '["in-app"]'`, so their existing opt-out survives the move onto the matrix.
Users with the column `true` (the default) get no row and inherit the new defaults.

**e. `users` — nothing.** `emailBudgetAlerts` is retained and deprecated in a doc comment;
`digestFrequency`'s default is changed in P3 (§3.3), not here.

### 3.2 P2 — `apps/api/src/migrations/1789510000000-CreateAttentionHolds.ts`

**a. `user_notification_preferences` — three additive columns**

`packages/agent/src/entities/user-notification-preference.entity.ts`:

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `attentionBudgetEnabled` | `boolean` | no | `true` |
| `emailDailyBudget` | `int` | no | `10` |
| `channelDailyBudget` | `int` | no | `20` |

Both integers are constrained `0 <= n <= 200` at the DTO layer (a CHECK constraint is avoided
because the SQLite fallback used by CI does not carry it consistently).

Because this table has one row per user *created lazily*, a user with no row uses the code-side
defaults — the same numbers. No backfill.

**b. New table `attention_holds`** — entity
`packages/agent/src/entities/attention-hold.entity.ts`:

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` PK | no | generated |
| `userId` | `uuid` | no | FK to `users`, `ON DELETE CASCADE` |
| `eventTypeKey` | `varchar(120)` | no | soft FK to the registry, same convention as subscriptions |
| `targetClass` | `varchar(16)` | no | `email` \| `channel` |
| `title` | `varchar(200)` | no | copied from the notification, already sanitised by the producer |
| `message` | `varchar(500)` | no | copied, already capped and secret-redacted by the producer |
| `actionUrl` | `varchar(255)` | yes | copied |
| `heldAt` | portable timestamp | no | default now |
| `releasedAt` | portable timestamp | yes | set when a digest lists it |
| `expiresAt` | portable timestamp | no | `heldAt + 7 days`, written at insert |

Indexes: `idx_attention_hold_user_open` on `("userId", "releasedAt", "heldAt")` for the digest
read and the "how many held" counter; `idx_attention_hold_expires` on `("expiresAt")` for the
sweeper.

The timestamp columns use the repo's `PortableDateColumn` helper
(`packages/agent/src/entities/_types.ts`), as the delivery-log entity already does, so the SQLite
test driver keeps working.

Repository: `packages/agent/src/database/repositories/attention-hold.repository.ts`, exported from
`packages/agent/src/database/index.ts` beside the other notification repositories.

### 3.3 P3 — `apps/api/src/migrations/1789520000000-DigestDefaultWeekly.ts`

One statement: `ALTER TABLE "users" ALTER COLUMN "digestFrequency" SET DEFAULT 'weekly'`, plus the
matching change to the entity's `@Column({ default: 'off' })`. **No `UPDATE`** — FR-40 says
existing rows are untouched, and the migration says so in a comment so a future reader does not
"fix" it.

### 3.4 Contracts

New shared types in `packages/contracts/src/notifications/`, re-exported from
`packages/contracts/src/index.ts` (which currently exports 18 sub-modules and has no notifications
entry):

- `attention.types.ts` — `AttentionTargetClass`, `ATTENTION_TARGET_CLASSES`,
  `AttentionBudgetSnapshot` (`{ class, used, limit, held, resetsAt, enabled }`).
- `notification-matrix.dto.ts` — `MatrixColumnDto` (`{ id, kind: 'in-app'|'email'|'channel',
  label, pluginId?, disabled, disabledReason? }`), `MatrixEventDto` (`{ key, group, category,
  title, description, alternativeSurface?, urgent, locked, defaultTargets, selectedTargets,
  muteUntil? }`), `MatrixGroup` (`'needsYou'|'signals'|'routine'|'digest'`), `NotificationMatrixDto`
  (columns + events + quiet hours + budget snapshots + limits).

Keeping the group in the DTO (derived server-side per FR-1) means the web never re-derives the
rule and the two cannot drift.

> **DTS gotcha.** Per the repo's known issues, do not build these with conditional spreads
> (`...cond && { k: v }`) — declaration emit breaks. Use explicit `if` blocks.

---

## 4. API

All new routes are session-guarded, owner-scoped, and mounted on the existing
`api/notifications` controller base so the surface stays one thing. New controller
`apps/api/src/notifications/notification-matrix.controller.ts` with base
`Controller('api/notifications')`, registered in
`apps/api/src/notifications/notifications.module.ts`.

| Method | Path | Body / query | Returns | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/notifications/matrix` | — | `NotificationMatrixDto` | FR-6. One read: registry + subscriptions + channels + quiet hours + mutes + budget snapshot. Parallel repository reads, single response. `Cache-Control: private, no-store`. |
| `POST` | `/api/notifications/matrix/reset` | `{ eventKeys?: string[] }` | `{ changed: number }` | FR-14. Omitting `eventKeys` resets all. Deletes the user's subscription rows for those keys so the fallback chain re-applies the shipped defaults. |
| `GET` | `/api/notifications/attention-budget` | — | `{ budgets: AttentionBudgetSnapshot[], expiringHolds: number }` | FR-36 polling target. Deliberately light — no registry read. |
| `PUT` | `/api/notifications/attention-budget` | `{ enabled: boolean, emailDailyBudget: number, channelDailyBudget: number }` | the new snapshot | FR-30. `@IsInt() @Min(0) @Max(200)` on both integers. |
| `GET` | `/api/notifications/held` | `?limit` (≤50) | `{ holds: [...], total }` | Powers the "N held" disclosure. |
| `POST` | `/api/notifications/test-email` | — | `{ status, address?, error? }` | FR-20. Throttled `@Throttle({ default: { limit: 3, ttl: 600_000 } })`. Sends through the same sender as a real notification so a green test proves the real path. |

**Changed, not replaced:**

- `PUT /api/notifications/preferences/event/:eventKey` — `notification-preferences.service.ts`
  gains `'email'` in `BUILT_IN_CHANNEL_IDS` so the ownership loop skips it (FR-16), and keeps
  rejecting unknown or foreign channel ids identically (FR-47). `MAX_SUBSCRIPTION_CHANNELS` stays
  20 (FR-5).
- `GET /api/notifications` and `GET /api/notifications/unread-count`
  (`notifications.controller.ts`) gain an `includeSilent` query flag, default `false`; the
  repository filters `isSilent = false` unless asked (FR-21). The unread count never includes
  silent rows.

**Web BFF.** The settings page is a server component, so reads go through the typed server-side
client in `apps/web/src/lib/api/notification-preferences.ts` (extended with `getMatrix`,
`resetMatrix`, `getAttentionBudget`, `setAttentionBudget`, `listHolds`, `sendTestEmail`). Writes
from the client component go through a new server action file
`apps/web/src/app/actions/notification-preferences.ts`, following the `ensureAuth()` +
`revalidatePath('/', 'layout')` pattern already used by
`apps/web/src/app/actions/notification-channels.ts`. No new Next.js route handlers are needed.

**The orphaned action.** `updateNotificationPreferences` in
`apps/web/src/app/actions/settings.ts` validates a shape that does not exist and returns a
simulated success after a 500 ms sleep. It is dead — nothing in the UI calls it. This epic does
**not delete it** (removal needs explicit sign-off); it marks it `@deprecated` with a pointer to
the new action file and adds a comment stating it is unreachable, so the next reader does not wire
it up by mistake.

---

## 5. Web

### 5.1 Route and shell

`apps/web/src/app/[locale]/(dashboard)/settings/notifications/page.tsx` keeps its route, its
server-component shape and the optional Novu widget. Its four parallel fetches collapse to two:
`getMatrix()` and the profile read that computes the Novu subscriber hash. It passes the matrix
DTO to a client component and keeps `Promise.allSettled` semantics so a Novu failure cannot blank
the page.

### 5.2 Components — `apps/web/src/components/settings/notifications/`

| File | Type | Responsibility |
| --- | --- | --- |
| `NotificationMatrix.tsx` | client | The grid. Owns optimistic state, the per-row debounce map, roving-tabindex focus management, refetch-on-focus (FR-15). |
| `MatrixGroup.tsx` | client | One of the four headings plus its rows; renders the group's explanatory line. |
| `MatrixRow.tsx` | client | Title, description, alternative-surface line, the switches, the save-state region, the muted/quiet/locked badges. |
| `MatrixSwitch.tsx` | client | One `role="switch"` button. Accessible name "{column} delivery for {event}". Disabled + reason for the email-unavailable cases. |
| `MatrixColumnHeader.tsx` | client | Column label, provider label resolved from the DTO (never a local map — FR-7), the unverified / not-configured states. |
| `MatrixOverflowPicker.tsx` | client | The `+N more` popover (FR-4), with the 20-target counter. |
| `AttentionBudgetCard.tsx` | client | Two meters, reset countdown, 60 s poll, edit-limits dialog, off/zero/over copy. |
| `QuietHoursRow.tsx` | client | Existing quiet-hours write, surfaced here with the 22:00–07:00 preset. |
| `HeldItemsDisclosure.tsx` | client | "N held" → list, and the expiring-without-a-digest nudge. |
| `ResetDefaultsDialog.tsx` | client | Counts the rows that will change client-side before confirming. |

`apps/web/src/components/settings/NotificationPreferencesSettings.tsx` is **kept** as the page's
entry component and rewritten to compose the above. Keeping the file name means no import churn
and no removal.

### 5.3 State and data fetching

- Server-rendered initial data; no client fetch on first paint.
- One `Map<eventKey, { timer, pending, lastConfirmed }>` drives FR-9 (400 ms debounce), FR-10
  (8 s timeout via `AbortSignal.timeout`), FR-11 (per-row isolation) and FR-15.
- Optimistic apply → server action → on success stamp `lastConfirmed`; on failure or timeout
  restore `lastConfirmed` and set the row's error. No global toast.
- Refetch-on-focus uses a single `visibilitychange` listener with a 30 s staleness check.
- The budget meter polls `GET /api/notifications/attention-budget` every 60 s **only while the tab
  is visible**, matching the discipline the bell dropdown already follows.
- Column set is server-derived; when a save fails with "unknown or unauthorized channel" the
  component triggers one refetch, which drops the dead column (S16).

### 5.4 The bell

`apps/web/src/components/dashboard/NotificationDropdown.tsx` gains exactly two things: a footer
link to `ROUTES.DASHBOARD_SETTINGS_NOTIFICATIONS` (already defined in
`apps/web/src/lib/constants.ts`), and a **Muted** filter toggle that passes `includeSilent=true`.
Its 30 s poll, its toast behaviour and its lazy list fetch are unchanged.

### 5.5 The digest page

`apps/web/src/components/settings/DigestSettings.tsx` — correct the false `enabledHelper` string
(FR-42) and add a link to the matrix's digest row. No behaviour change.

---

## 6. Background work

**Zero new job types.** That is a design goal, not an accident.

| Work | How it runs | Why not a new job |
| --- | --- | --- |
| Email delivery + retry | The **existing** `notification-channel-delivery` Trigger task, enqueued through the already-bound `NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER` symbol, with `channelId: 'email'`. The task calls `deliverToChannelOrThrow`, which hits the new sentinel branch. | The retry policy, the quiet-hours `delay`, the dead-letter row and the in-process fallback all already exist and are exactly what email needs. |
| Quiet-hours deferral for email | Same path — the resolver already returns `deferUntil`, and the facade already passes it as the run `delay`. | Nothing to add. |
| Releasing holds | Inside `DigestService` composition, which already runs on the `digest-dispatcher` schedule (`15 7 * * *`). | A separate release job would be a second interruption mechanism (§2.4). |
| Expiring holds | Folded into the **existing** `NotificationCleanupService` daily 03:00 cron, inside the same `DistributedTaskLockService.runExclusive` block. | It is the same shape of work (delete rows past a threshold) in the same subsystem, already multi-instance safe. |
| Counting the budget | Synchronous, one indexed aggregate, inside the fan-out listener. | Sub-millisecond on an indexed count; a job would make the decision arrive after the delivery. |

No call site imports `@trigger.dev/sdk`. The only vendor-SDK import in this epic's blast radius is
the one that already exists inside `packages/tasks/src/tasks/trigger/`, which is where it belongs.

---

## 7. Plugin boundaries

- **No new plugin package**, because no new external integration is introduced (§2.2).
- **No hard-coded plugin id anywhere in this epic's code.** The matrix's channel columns come from
  the user's `notification_channels` rows; each column's label is the row's own `name`, and the
  provider label rides in the DTO from a server-side lookup through
  `PluginRegistryService`, not from a local map. Note that
  `apps/web/src/components/settings/NotificationChannelsSettings.tsx` **does** carry a hard-coded
  `PROVIDERS` array today; this epic must not add a second copy of it, and the matrix must not
  import it.
- **Plugin-contributed events** already appear in the registry namespaced `<pluginId>:<key>` and
  therefore appear in the matrix automatically (FR-7). Their `defaultChannels` come from the
  plugin manifest and are not overridden by this epic's default table.
- The five channel plugins, `EmailFacadeService`, and the tenant email-address feature are
  untouched.

---

## 8. i18n

One new namespace, `dashboard.settings.notifications`, in
`apps/web/messages/en.json`. Leaf names are camelCase and contain no literal `.` (a next-intl
runtime error, and the one that reds several e2e shards at once). English values are the exact
copy in [spec §6.9](./spec.md#69-exact-user-visible-copy).

```
dashboard.settings.notifications.title
dashboard.settings.notifications.subtitle
dashboard.settings.notifications.groups.needsYou
dashboard.settings.notifications.groups.needsYouHint
dashboard.settings.notifications.groups.signals
dashboard.settings.notifications.groups.signalsHint
dashboard.settings.notifications.groups.routine
dashboard.settings.notifications.groups.routineHint
dashboard.settings.notifications.groups.digest
dashboard.settings.notifications.columns.inApp
dashboard.settings.notifications.columns.email
dashboard.settings.notifications.columns.overflow
dashboard.settings.notifications.columns.emailUnverified
dashboard.settings.notifications.columns.emailNotConfigured
dashboard.settings.notifications.columns.channelDisabled
dashboard.settings.notifications.rowState.saving
dashboard.settings.notifications.rowState.saved
dashboard.settings.notifications.rowState.failed
dashboard.settings.notifications.rowState.retry
dashboard.settings.notifications.rowState.locked
dashboard.settings.notifications.rowState.muted
dashboard.settings.notifications.rowState.unmute
dashboard.settings.notifications.rowState.quietDeferred
dashboard.settings.notifications.switchLabel
dashboard.settings.notifications.budget.title
dashboard.settings.notifications.budget.meter
dashboard.settings.notifications.budget.resetsIn
dashboard.settings.notifications.budget.off
dashboard.settings.notifications.budget.over
dashboard.settings.notifications.budget.zero
dashboard.settings.notifications.budget.edit
dashboard.settings.notifications.budget.dialogTitle
dashboard.settings.notifications.budget.dialogBody
dashboard.settings.notifications.budget.dialogNote
dashboard.settings.notifications.budget.emailLabel
dashboard.settings.notifications.budget.channelLabel
dashboard.settings.notifications.budget.range
dashboard.settings.notifications.budget.holdsExpiring
dashboard.settings.notifications.budget.turnOnDigest
dashboard.settings.notifications.quietHours.empty
dashboard.settings.notifications.quietHours.preset
dashboard.settings.notifications.quietHours.set
dashboard.settings.notifications.reset.button
dashboard.settings.notifications.reset.dialogTitle
dashboard.settings.notifications.reset.dialogBody
dashboard.settings.notifications.reset.confirm
dashboard.settings.notifications.testEmail.link
dashboard.settings.notifications.testEmail.sent
dashboard.settings.notifications.testEmail.failed
dashboard.settings.notifications.testEmail.throttled
dashboard.settings.notifications.links.connectChannel
dashboard.settings.notifications.links.changeCadence
dashboard.settings.notifications.links.verifyEmail
dashboard.settings.notifications.errors.load
dashboard.settings.notifications.errors.tooManyTargets
dashboard.settings.notifications.errors.channelRemoved
dashboard.settings.notifications.empty.title
dashboard.settings.notifications.empty.body
dashboard.settings.notifications.empty.openFeed
dashboard.settings.notifications.events.<eventKey>.title
dashboard.settings.notifications.events.<eventKey>.description
dashboard.settings.notifications.events.<eventKey>.alternativeSurface
```

**Event titles are translated on the web side, not stored in the registry.** The registry's
`title`/`description` remain the source for anything server-rendered (the email subject, the
digest) and are corrected by the P1 migration; the matrix prefers a translation when
`dashboard.settings.notifications.events.<key>.title` exists and falls back to the registry string
otherwise. That fallback is what makes plugin-contributed events render without a web deploy
(FR-7). Because the event key becomes a message key segment, keys containing a `:` (the
plugin-namespaced form) are normalised to `_` before lookup — and the fallback covers them anyway.

Two existing namespaces also change:

- `dashboard.header.notifications` — add `settingsLink`, `mutedFilter`.
- `dashboard.settings.digest.fields.enabledHelper` — corrected value (FR-42).

The 20 sibling locale files under `apps/web/messages/` receive the same keys. English values are
acceptable placeholders for non-English locales in the same PR; the catalogue must be
structurally complete in every file so next-intl does not throw.

---

## 9. Telemetry and failure modes

### 9.1 Telemetry (through `@ever-works/monitoring`'s `AnalyticsService`, as the budget alert
handler already does)

| Event | Properties | Answers |
| --- | --- | --- |
| `notifications.matrix.viewed` | `eventCount`, `channelCount` | Is anyone finding the page now that it is linked? |
| `notifications.matrix.toggled` | `eventKey`, `targetClass`, `on` | Which defaults are wrong. |
| `notifications.matrix.saveFailed` | `eventKey`, `reason` | Is the autosave reliable. |
| `notifications.matrix.reset` | `changed` | How often the defaults are rejected wholesale. |
| `notifications.budget.exceeded` | `targetClass` | How many users hit the ceiling, and at what default. |
| `notifications.hold.created` / `.released` / `.expired` | `targetClass`, `eventKey` | Is the release valve working, or are holds dying unread. |
| `notifications.email.delivered` / `.failed` | `eventKey`, `reason` | Email health, separate from chat health. |
| `notifications.eventKey.unregistered` | `eventKey` | **The regression guard for the defect in §1.2 item 2.** A non-zero value means a producer shipped a key with no registry row. |

### 9.2 Failure modes

| Failure | Behaviour | Rationale |
| --- | --- | --- |
| Registry lookup misses | In-app row already written; no external delivery; counter incremented (S26) | Never lose the notification; make the gap visible. |
| Budget count query fails | **Admit** the delivery | A metering fault must not silence an alert. Fail open, log a warning. |
| Hold insert fails | Deliver instead of holding | Same reasoning: over-delivering is recoverable, silence is not. |
| Email send fails | Retried by the existing task policy; terminal failure leaves a `failed` delivery-log row | Matches chat delivery exactly; the log is the dead-letter. |
| Mail transport unconfigured | Sender reports `not-configured`; the matrix disables the column (S19); no retries are scheduled | Retrying a misconfiguration 5 times helps nobody. |
| Digest composition fails | Holds are **not** marked released | A hold is released only when it has actually been rendered into a delivered digest. |
| Matrix read fails | Page renders the load-error state; nothing is written | Read-only failure must never look like a preference change. |
| Save request times out | Row reverts to last confirmed value (FR-10) | The UI must never claim a preference the server does not hold. |
| Two tabs disagree | Last write wins; the stale tab reconciles on focus (S14) | One watermark, no merge algorithm. |
| Novu widget fails | The matrix still renders | Existing behaviour, preserved by `Promise.allSettled`. |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest)

- `packages/agent/src/notifications/__tests__/attention-budget.service.spec.ts` — admission under
  and over the ceiling; urgent bypass with counter increment (FR-31); ceiling `0`; budget disabled;
  count-query failure fails open; the rolling window boundary at exactly 24 h.
- `packages/agent/src/notifications/user-notification-subscription.service.spec.ts` (extend) — an
  **empty** stored selection resolves to no targets and does **not** fall through (FR-13); `'email'`
  survives the plan; quiet hours defers `'email'` for non-urgent and not for urgent.
- `packages/agent/src/facades/__tests__/notification-channel.facade.email-sentinel.spec.ts` —
  `'email'` never touches the channel repository; a delivery-log row is written with
  `builtInChannel = 'email'` and `channelId = null`; `deliverToChannelOrThrow('email', …)` throws
  on sender failure so the task retries; a missing sender port fails with a stated reason rather
  than silently succeeding.
- `packages/agent/src/notifications/notification.service.spec.ts` (extend) — `isSilent` is set from
  the resolved plan; a persistent notification is never silent (FR-23);
  `notifyBudgetThresholdCrossed` now dispatches a fan-out with the right key for each threshold.
- `packages/agent/src/digest/__tests__/digest-holds.spec.ts` — the **Held for you** section renders
  at most 20 named items plus a remainder count; holds are marked released only after a successful
  compose; a window with only held items is **not** treated as quiet.
- `packages/agent/src/notifications/__tests__/event-registry-coverage.spec.ts` — **the regression
  guard**: every literal passed as `eventKey` by `notification.service.ts` has a matching entry in
  `CORE_EVENTS`, and every `CORE_EVENTS.category` is a member of `NotificationCategory`. This test
  fails when someone adds a producer without a registration (§1.2 items 2 and 3).

### 10.2 Controller specs — API (Jest)

- `apps/api/src/notifications/notification-matrix.controller.spec.ts` — the six routes: shape of
  `GET /matrix`; reset returns a count and deletes only this user's rows; budget PUT rejects
  `-1` and `201`; `GET /held` caps at 50; test-email throttling at the 4th call in 10 minutes;
  every route rejects an unauthenticated caller.
- `apps/api/src/notifications/notification-preferences.service.spec.ts` (extend) — `'email'` is
  accepted without an ownership lookup; a foreign channel id is still refused with the same
  message as an unknown one; the 21st target is refused with the limit in the message; an empty
  array persists.
- `apps/api/src/notifications/notification-email-sender.service.spec.ts` — renders the template,
  includes the "you get this because" line and the deep link, reports `not-configured` when the
  transport is absent, and never logs the recipient address at info level.
- `apps/api/src/notifications/notifications.controller.spec.ts` (extend) — the unread count
  excludes silent rows; `includeSilent=true` returns them.
- `apps/api/src/budgets/budget-alert.handler.spec.ts` (new) — the handler no longer calls
  `MailService` directly and instead relies on the fan-out; the in-app row and the analytics event
  are unchanged.

### 10.3 Web unit (Vitest, `*.unit.spec.ts(x)`)

- `apps/web/src/components/settings/notifications/NotificationMatrix.unit.spec.tsx` — four rapid
  clicks produce one write (FR-9); a rejected write reverts only its row (FR-11, FR-13); the grid
  exposes one tab stop and arrow keys move focus (FR/§6.10); `Shift+Space` toggles a row.
- `apps/web/src/components/settings/notifications/AttentionBudgetCard.unit.spec.tsx` — the over,
  zero and off states render their exact copy; the poll stops while the tab is hidden.
- `apps/web/src/app/actions/notification-preferences.unit.spec.ts` — unauthenticated calls
  redirect; the action forwards exactly the target list it was given.

### 10.4 e2e (Playwright, `apps/web/e2e/`)

New specs, named to sit beside the existing notification suite:

- `flow-notification-matrix-autosave.spec.ts` — toggle, reload, assert persistence; toggle to
  empty, reload, assert still empty; reset-to-recommended.
- `flow-notification-matrix-email-target.spec.ts` — subscribe an event to `email`, trigger it,
  assert the message lands in MailHog (the suite's existing helper,
  `apps/web/e2e/helpers/mailhog.ts`) with the deep link and the reason line.
- `flow-attention-budget.spec.ts` — set the email budget to 1, fire two non-urgent events, assert
  one mail and one hold; fire an urgent event, assert it still sends.
- `flow-notification-matrix-a11y.spec.ts` — keyboard traversal, one tab stop, accessible names,
  the live region announcing "Saved".

Regression guards over the existing suite (must stay green untouched):
`notifications-preferences.spec.ts`, `notifications-channel-toggle.spec.ts`,
`flow-notification-email-channel.spec.ts`, `flow-notifications-digest.spec.ts`,
`flow-notifications-event-preferences-digest-chain.spec.ts`,
`flow-concurrency-notifications-matrix.spec.ts`, `notifications-bell-ui.spec.ts`,
`flow-profile-budget-alerts.spec.ts` (the budget-alert opt-out backfill must not change what this
spec observes for a user who never opted out).

### 10.5 Migration checks

- `apps/api/src/migrations/__tests__/` already exists; add a case asserting the P1 migration is
  idempotent (running it twice leaves 23 core registry rows, not 46) and that it performs no
  `DROP`, no `NOT NULL` addition and no `UPDATE` against `users`.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green on its own.

### P1 — the matrix works (the epic's whole point)

Registry completion and correction (§3.1c), the empty-selection fix, `'email'` as a built-in
target end to end (sentinel, sender port, delivery-log widening), `isSilent`, the `GET /matrix`
and `POST /matrix/reset` routes, the rebuilt matrix UI with autosave, the full i18n namespace, the
bell footer link, the budget-alert move onto the matrix with its opt-out backfill, and the
regression-guard test. Migration `1789500000000-AttentionMatrixFoundations.ts`.

Shipping P1 alone already closes every defect in §1.2 and delivers the scope brief's first four
clauses (matrix, independent in-app/email switches, defaults, autosave).

### P2 — the attention budget

The three preference columns, the `attention_holds` table and repository, the admission service in
the fan-out listener, the budget card with its meters and dialog, `GET`/`PUT /attention-budget`,
`GET /held`, the digest's two new sections, and hold expiry folded into the existing cleanup cron.
Migration `1789510000000-CreateAttentionHolds.ts`.

P2 depends on P1's delivery-log `userId` column (it is what the count reads) and on the registry
being complete (it is what `urgent` means).

### P3 — the edges

Weekly digest default for new accounts (§3.3), the test-email route and link, the bell's Muted
filter, the corrected Digest page copy, the user-facing documentation page, and the tracker
update.

Sequencing: **P1 → P2 → P3**, with no work in a later phase required for an earlier one to ship.

---

## 12. Constitution compliance

| Gate | Status | Justification |
| --- | --- | --- |
| **I — Plugin-first** | ✅ | No external integration is added. Notification email rides the platform's existing first-party transactional mail path — the same one that already sends password resets and budget alerts — and is modelled as a built-in sentinel, symmetrical with the in-app sentinel that already exists (§2.2). The five channel plugins are untouched and no sixth is needed. |
| **II — Capability-driven, no hardcoded plugin ids** | ✅ | The matrix's columns are derived from the user's channel rows; provider labels are resolved server-side through the plugin registry and travel in the DTO. This epic adds no plugin-id branch and explicitly must not import the existing hard-coded provider array from the Channels page (§7). |
| **III — Source-of-truth repositories** | ✅ N/A | Nothing here touches work content. Everything read and written is platform preference metadata. |
| **IV — Job runtime via `*_DISPATCHER`** | ✅ | **Zero new job types.** Email delivery reuses the existing `notification-channel-delivery` task through the already-bound `NOTIFICATION_CHANNEL_DELIVERY_DISPATCHER` symbol; hold release rides digest composition on its existing schedule; hold expiry folds into the existing daily cleanup cron. No call site imports a vendor SDK (§6). |
| **V — Forward-only migrations, same PR** | ✅ | Three migrations, each in the PR that changes the entity: `1789500000000-AttentionMatrixFoundations` (one additive boolean, one nullability relaxation, two additive columns, two concurrent indexes, idempotent registry data), `1789510000000-CreateAttentionHolds` (three additive columns + one new table), `1789520000000-DigestDefaultWeekly` (a column default only). No `DROP COLUMN`, no `NOT NULL` on an existing populated column, no rename, no `UPDATE` against `users` (§3). |
| **VI — Tests are a prerequisite** | ✅ | Six Jest suites in the agent package, five in the API, three Vitest web units, four new Playwright specs, plus a named regression suite that must stay green — and a coverage test that fails when a producer gains an unregistered event key (§10). |
| **VII — Privacy & secret hygiene** | ✅ | No new secret is introduced. Notification email bodies are composed from producer strings that are already sanitised and secret-redacted before storage; the sender adds no raw error text. The recipient address is never logged above debug. The encrypted channel `targetConfig` column is neither read nor rendered by the matrix — columns are labelled by `name` only. |
| **VIII — Single source of truth for plugin lists** | ✅ N/A | No plugin is added or removed, so `docs/plugin-system/built-in-plugins.md` does not change. |
| **IX — Behaviour-first spec** | ✅ | [spec.md](./spec.md) contains no path, class or code; every implementation decision lives in this file. |
| **X — Backwards compatibility** | ✅ | Every existing endpoint keeps its shape; `includeSilent` and the `'email'` target are additive and default to today's behaviour. `users.emailBudgetAlerts` is retained and read once for the backfill rather than dropped, so account export/import keeps working. The dead server action is deprecated in place, not deleted. |

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Turning on email defaults for eleven events makes the platform noisier for existing users overnight. | The defaults only apply to users with **no stored subscription** for that event, and the attention budget (P2) caps the result at 10 emails a day. If P1 ships before P2, the eleven default-on rows are all urgent events that are, by construction, rare. Watch `notifications.email.delivered` after P1 and hold P2 close behind it. |
| The budget-alert email moves from an unconditional send to a matrix-governed one, so a misconfigured matrix could silence a real spend alert. | The migration backfills the existing opt-out exactly, the two budget keys ship with Email **on** by default, and the "cap reached" key is urgent, so it bypasses the budget and quiet hours. |
| `channelId` becoming nullable weakens a constraint that has held since the table was created. | The FK stays; exactly one of `channelId` / `builtInChannel` is set, enforced in the repository write path and asserted by a unit test. Reads that assume a channel row are audited in the same task. |
| Counting distinct `messageRef` per user gets slow for a very loud workspace. | The new `("userId", "createdAt")` index bounds it; the window is 24 h and the ceiling is ≤ 200, so the scan is small. If it ever is not, the count moves behind a 60 s memo — noted, not built. |
| The matrix grows to hundreds of rows once many plugins contribute events. | Grouping plus per-category collapse is already in the layout; beyond 200 registry rows the page paginates by category. Called out in the spec's limits. |
| Translating event titles on the web while the registry also holds titles invites drift. | The web prefers a translation and falls back to the registry string, and the registry is the sole source for server-rendered surfaces (email subject, digest). One direction only, stated in §8. |

---

## 14. References

- Spec: [./spec.md](./spec.md) · Tasks: [./tasks.md](./tasks.md)
- Program: [../README.md](../README.md) · [../TRACKER.md](../TRACKER.md)
- Upstream: [AW-04 Live Feed](../AW-04-live-feed/) — the surface that makes the Routine defaults
  honest
- Downstream: [AW-17 Costs & caps](../AW-17-costs-caps/), [AW-19 Home](../AW-19-home/)
- Constitution: [.specify/memory/constitution.md](../../../../../.specify/memory/constitution.md)
- House style reference: [docs/specs/features/schedules/spec.md](../../schedules/spec.md)
