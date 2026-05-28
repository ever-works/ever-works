# Feature Specification: Event Subscriptions

**Feature ID**: `event-subscriptions`
**Branch**: `feat/notifications-v2-multichannel` (umbrella)
**Status**: `Draft`
**Jira Epic**: TBD (sibling of [EW-650](https://evertech.atlassian.net/browse/EW-650))
**Created**: 2026-05-28
**Last updated**: 2026-05-28
**Owner**: Product (Ruslan)
**Related code today**:

- Existing in-app notifications (kept unchanged): [`../notifications/spec.md`](../notifications/spec.md), `packages/agent/src/notifications/notification.service.ts`
- Channel registry consumed by this spec: [`../notification-channels/spec.md`](../notification-channels/spec.md)
- Email as a channel: [`../email-providers/spec.md`](../email-providers/spec.md)

> **Scope of this document:** add a **user-configurable preferences matrix** that decides _which_ events trigger delivery to _which_ channels for _which_ user. Today (notifications v1) every relevant user gets every notification, in-app only. This spec extends that with per-event-type per-channel opt-in/opt-out plus mute, quiet hours, and category-level controls. The existing notifications v1 surface keeps working as the **default delivery channel** when no preferences are set.
>
> **Hard rule (additive only):** the v1 producer convenience methods (`notifyAiCreditsDepleted`, `notifyAiProviderError`, …) continue to emit in-app notifications. This spec adds a fanout layer on top: when producers emit, the subscription resolver decides which channels (beyond in-app) the user has opted into for that event type.

---

## 1. Personas + use cases

| Persona  | Use case                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| User     | "I want 'AI credits depleted' on email + Telegram, but 'New version available' only in-app."                             |
| User     | Sets quiet hours 22:00–07:00 (local timezone) — non-urgent events queue until 07:00; `urgent: true` events bypass.       |
| User     | Mutes the entire `subscription` category for 7 days while on vacation.                                                   |
| Operator | Defines a per-organisation default subscription map; new users inherit until they customise.                             |
| Admin    | Registers a new event type from a plugin; the user-facing preferences UI picks it up automatically without code changes. |

---

## 2. Surfaces — what the user sees

### 2.1 Settings → Notifications

A new sub-page under Settings → Notifications:

- **Event matrix.** Rows = event types (grouped by category). Columns = the user's enabled channels (in-app always present; email/Discord/Slack/etc. appear once configured under `notification-channels`). Cells = checkbox.
- **Defaults bar.** "Set all to in-app + email" / "Mute all" quick-action chips.
- **Quiet hours.** Per-user `quietHoursStart` + `quietHoursEnd` + `timezone` (read from user profile).
- **Mute category until.** Per-category date-time picker.

### 2.2 First-time setup

On a user's first visit to the page, the matrix is pre-filled from:

1. Organisation default (if set by operator), else
2. Built-in defaults: every event delivers to **in-app** only (matches v1 behaviour, so nothing changes for existing users).

---

## 3. Event registry

Event types live in a registry, not as ad-hoc strings, so the UI can render them by name + category + description:

```typescript
interface NotificationEventType {
	key: string; // 'ai_credits_depleted', 'work_generation_finished', …
	category: string; // matches NotificationCategory: 'ai_credits' | 'subscription' | 'generation' | 'system' | 'security' | 'work' | 'agent'
	title: string; // human-readable
	description: string; // 1-2 sentences for the UI
	urgent: boolean; // true → bypass quiet hours
	defaultChannels: readonly string[]; // ['in-app'] today; can be ['in-app', 'email'] for transactional events
	source: 'core' | 'plugin'; // plugin-contributed events get prefix `plugin:<pluginId>:`
}
```

Bootstrap registry seeded from existing v1 notification dedup keys + a small expansion set (Work-generation lifecycle, Agent-run lifecycle, Mission events). Plugins can register new event types via the `everworks.plugin` manifest:

```json
{
	"id": "stripe",
	"name": "Stripe",
	"events": [{ "key": "stripe_invoice_paid", "category": "subscription", "urgent": false }]
}
```

---

## 4. Subscription resolver

A new service `UserNotificationSubscriptionService` answers the question: **"For this `(userId, eventType)`, which channels should we deliver to right now?"**

Resolution:

1. Load `user_notification_subscriptions` rows for `(userId, eventType)`.
2. If none, fall back to the organisation default → built-in default → `['in-app']`.
3. Filter out channels the user has disabled.
4. Apply quiet hours: if now ∈ quiet window AND event.urgent === false AND channel is not `in-app`, queue delivery for end-of-quiet-window via BullMQ delayed job.
5. Apply category mute: if `(userId, category)` has an active mute, drop all non-`in-app` channels (in-app still records the notification for retrospective viewing).

Output: a list of `channelId`s. The caller fans out via `NotificationChannelFacadeService.send(channelIds, payload)`.

---

## 5. Data model

### 5.1 New tables

```
notification_event_types
  key             varchar(120) PK              -- 'ai_credits_depleted'
  category        varchar(64) NOT NULL
  title           varchar(200)
  description     text
  urgent          boolean DEFAULT false
  defaultChannels jsonb DEFAULT '["in-app"]'   -- ['in-app', 'email', …]
  source          varchar(16) NOT NULL DEFAULT 'core'  -- 'core' | 'plugin'
  pluginId        varchar(64) NULL             -- when source='plugin'
  createdAt       timestamp
  updatedAt       timestamp

user_notification_subscriptions
  id              uuid PK
  userId          uuid FK users
  eventTypeKey    varchar(120) NOT NULL        -- FK soft-ref to notification_event_types.key
  channelIds      jsonb NOT NULL               -- ['<channel-uuid>', '<channel-uuid>', 'in-app']
  updatedAt       timestamp
  UNIQUE(userId, eventTypeKey)

user_notification_preferences
  userId          uuid PK FK users             -- one row per user
  quietHoursStart time NULL                    -- '22:00:00'
  quietHoursEnd   time NULL                    -- '07:00:00'
  timezone        varchar(64) NULL             -- 'Europe/Kyiv' (else falls back to user.timezone)
  updatedAt       timestamp

user_notification_category_mutes
  id              uuid PK
  userId          uuid FK users
  category        varchar(64) NOT NULL
  mutedUntil      timestamp NULL               -- NULL = indefinite
  createdAt       timestamp
  UNIQUE(userId, category)

organization_notification_defaults
  organizationId  uuid PK FK organizations     -- single-row-per-org via PK
  defaults        jsonb NOT NULL               -- {eventTypeKey: [channelIds, …]}
  updatedAt       timestamp
```

### 5.2 Reuses

- `notifications` (v1) — in-app delivery still writes to this table. No schema change.
- `notification_channels` (from sibling spec) — channels are referenced by FK from `user_notification_subscriptions.channelIds[]`.

---

## 6. Producer-side integration

Existing v1 producer methods (`notifyAiCreditsDepleted`, etc.) gain an internal **fanout step** after creating the in-app notification:

```typescript
async notifyAiCreditsDepleted(userId: string, provider: string) {
  const notification = await this.create({ ... });  // unchanged v1 behavior
  await this.subscriptionResolver.resolveAndDispatch({
    userId,
    eventType: 'ai_credits_depleted',
    payload: { title: notification.title, message: notification.message, actionUrl: notification.actionUrl }
  });
}
```

`resolveAndDispatch` is a no-op for users who haven't opted into any non-in-app channel for that event, so the existing behaviour is preserved.

---

## 7. REST API

```
GET    /api/notifications/event-types                  -- list registered event types (for UI matrix)
GET    /api/notifications/preferences                  -- current user's matrix + quiet hours + mutes
PUT    /api/notifications/preferences/event/:eventKey  -- update channel selection for one event
PUT    /api/notifications/preferences/quiet-hours      -- update quiet hours
POST   /api/notifications/preferences/mute             -- mute a category (body: {category, untilTs?})
DELETE /api/notifications/preferences/mute/:category   -- unmute
```

All behind `AuthSessionGuard`.

---

## 8. Out of scope (v1)

- **Per-event quiet hours.** Quiet hours are user-global, not per-event-type.
- **Per-channel rate limits.** If a user opts every event into Telegram, Telegram gets flooded. Operator-side throttling lands in v2.
- **Subscription import/export** — no JSON dump in v1.
- **Cross-user subscription delegation** ("notify my assistant on my behalf") — out of scope.

---

## 9. Acceptance criteria

- [ ] Existing users see no behaviour change unless they visit Settings → Notifications.
- [ ] User can opt 'ai_credits_depleted' into email + Telegram; the next firing delivers to both within 30s.
- [ ] Quiet hours queue non-urgent events; `urgent: true` events bypass.
- [ ] Category mute drops non-`in-app` channels for that category; in-app still records.
- [ ] New event types registered by a plugin appear in the preferences UI without a deploy.
- [ ] Organisation defaults seed new users' matrices on first save.

---

## 10. Constitution gates

- [x] **I** Plugin-first — event registry accepts plugin-contributed event types.
- [x] **II** Capability-driven — subscription resolver depends only on the `INotificationChannelPlugin` contract; doesn't care which channel concretely runs.
- [x] **III–V** Standard schema migration rules.
- [x] **VI** Tests — unit tests for the resolver, integration tests through the producer methods.
- [x] **VII** Secret hygiene — no secrets stored; channel configs live in the channel tables.
- [x] **VIII** Plugin counts — no new plugins; consumes notification-channels.
- [x] **IX** Behaviour-first — the matrix is user-observable behaviour.
- [x] **X** Backwards-compat — no opt-in change from v1 means no behavioural change for existing users.

---

## 11. References

- Sibling specs: [`notification-channels`](../notification-channels/spec.md), [`email-providers`](../email-providers/spec.md), [`agent-inbox-ui`](../agent-inbox-ui/spec.md)
- v1 retrospective: [`notifications`](../notifications/spec.md)
- Plan: [`plan.md`](./plan.md)
- Tasks: [`tasks.md`](./tasks.md)
