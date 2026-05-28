# Feature Specification: Notification Channels

**Feature ID**: `notification-channels`
**Branch**: `feat/notifications-v2-multichannel` (umbrella)
**Status**: `Draft`
**Jira Epic**: TBD (sibling of [EW-650](https://evertech.atlassian.net/browse/EW-650))
**Created**: 2026-05-28
**Last updated**: 2026-05-28
**Owner**: Product (Ruslan)
**Related code today**:

- Existing in-app notifications: `apps/api/src/notifications/`, `packages/agent/src/notifications/notification.service.ts` (kept as the in-app channel, see [`../notifications/spec.md`](../notifications/spec.md))
- Email channel: [`../email-providers/spec.md`](../email-providers/spec.md)
- Plugin registry: `packages/agent/src/plugins/services/plugin-registry.service.ts`
- AI provider plugin pattern (mirror): `packages/agent/src/facades/ai.facade.ts`

> **Scope of this document:** define a generic Notification Channel plugin contract that covers Discord, Slack, Telegram, WhatsApp, Novu (meta-router) and future chat-style channels. The existing in-app `notifications` v1 surface keeps working unchanged; it now coexists as **one channel among many**, addressable by the same fan-out router this spec defines. Email is its own surface (it has tenant-managed addresses + inbound webhooks) and is covered separately by [`email-providers`](../email-providers/spec.md). Per-user _which-channel-when_ preferences live in [`event-subscriptions`](../event-subscriptions/spec.md).
>
> **Hard rule (additive only):** the in-app notification panel keeps rendering the same notifications it does today. Channels add **additional** delivery surfaces, not replacements.

---

## 1. Personas + use cases

| Persona  | Use case                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Operator | Connects a Discord workspace via webhook; subscribes "Work generation finished" events so the team channel pings on every success.   |
| User     | Adds personal Telegram bot; routes "AI credits depleted" alerts to Telegram only (silences email + in-app for that event).           |
| Operator | Enables Novu as a meta-router; all platform events flow through Novu's workflow engine for advanced batching + DND windows.          |
| Operator | A channel provider has an outage. Fanout to remaining configured channels continues; failed channel queues for retry.                |
| Agent    | Posts a status update via `notifyChannel` tool descriptor — pings the user on whatever channel(s) they've configured for that event. |

---

## 2. Surfaces — what the user sees

### 2.1 Tenant Settings → Notification Channels

A new sub-page under Settings → Integrations:

- **Channels** list. Each row: `channel name` · `provider` · `targetSummary` (e.g. "Discord · #ops-alerts") · `verified?` · per-row delivery rollup · "Test" / "Edit" / "Disable" / "Remove".
- **Add channel** wizard:
    - Step 1: pick provider (Discord / Slack / Telegram / WhatsApp / Novu).
    - Step 2: pick target (webhook URL, channel id, bot token, novu workflow id, …).
    - Step 3: send a test message + confirm receipt.

### 2.2 Per-user channel preferences

Lives under the [`event-subscriptions`](../event-subscriptions/spec.md) surface: for each event type the user can pick zero-or-more channels (in-app, email, Discord, Slack, …). This spec only owns the channel registry + send mechanics; the subscription matrix lives next door.

### 2.3 Plugins page

`/settings/plugins` gains a new "Notification Channels" group listing each enabled channel plugin alongside the existing AI / search / etc. groups.

---

## 3. Plugin contract

### 3.1 Capability declaration

Five new plugin capabilities:

- `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_DISCORD`
- `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_SLACK`
- `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_TELEGRAM`
- `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_WHATSAPP`
- `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_NOVU`

Plus a generic umbrella for plugin discovery: `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL` (all of the above declare this too).

### 3.2 Interface — `INotificationChannelPlugin`

```typescript
interface INotificationChannelPlugin extends IPlugin {
	/** Channel-shape: 'broadcast' (Discord/Slack channels) | 'direct' (Telegram/WhatsApp DMs) | 'workflow' (Novu) */
	readonly shape: 'broadcast' | 'direct' | 'workflow';

	/** Validate the per-tenant connection config (webhook URL, bot token, …). */
	verifyTarget(config: ChannelTargetConfig, options: ChannelOptions): Promise<ChannelVerification>;

	/** Deliver one notification payload. MUST be idempotent on payload.messageRef. */
	send(payload: ChannelSendInput, options: ChannelOptions): Promise<ChannelSendResult>;

	/** Optional: surface delivery events (read receipts, click-throughs) if the channel supports them. */
	listDeliveryEvents?(filter: ChannelEventFilter, options: ChannelOptions): AsyncGenerator<ChannelDeliveryEvent>;
}

interface ChannelSendInput {
	/** Plain-text fallback (always set). */
	text: string;
	/** Channel-specific rich content (Discord embeds, Slack blocks, Telegram MarkdownV2, …). */
	rich?: {
		kind: 'discord-embeds' | 'slack-blocks' | 'telegram-markdown' | 'whatsapp-template' | 'novu-payload';
		payload: unknown;
	};
	/** Idempotency key (required). */
	messageRef: string;
	/** Source attribution for spend rollups. */
	attribution: { userId: string; agentId?: string; taskId?: string; eventType?: string };
}

interface ChannelSendResult {
	provider: string;
	providerMessageId: string;
	deliveredAt?: Date;
}
```

### 3.3 NotificationChannelFacadeService

A new facade in `packages/agent/src/facades/notification-channel.facade.ts` (parallel to `EmailFacadeService` / `AiFacadeService`):

- **`send(userId, eventType, payload)`** — resolves the user's enabled channels for the event (via [`event-subscriptions`](../event-subscriptions/spec.md)), and fans out to each in parallel.
- **`sendDirect(channelId, payload)`** — bypass the subscription resolver; send to one specific channel (used for "Test" button, direct ad-hoc notifications).
- **Failover**: per-channel attempt with exponential-backoff retry (3 attempts, 1s/4s/15s); on terminal failure, enqueue a BullMQ `notification-channel-retry` job (24h dead-letter).
- **Attribution**: emits a `PluginUsageEvent` per send with `capability='notification-channel'` and `channelId` in metadata.

### 3.4 In-app channel (special-cased)

The existing `notifications` v1 surface counts as a built-in "in-app" channel. It implements `INotificationChannelPlugin` with `shape: 'direct'` but is wired internally (not a separate plugin package) since it has no external provider.

---

## 4. Data model

### 4.1 New tables

```
notification_channels
  id              uuid PK
  userId          uuid FK users
  pluginId        varchar(64) NOT NULL          -- 'discord' | 'slack' | 'telegram' | 'whatsapp' | 'novu' | 'in-app'
  name            varchar(120)                  -- user-friendly label
  targetConfig    jsonb NOT NULL                -- per-plugin: webhook URL, channel id, bot token, …
  verified        boolean DEFAULT false
  disabledAt      timestamp NULL
  createdAt       timestamp
  updatedAt       timestamp
  UNIQUE(userId, pluginId, name)

notification_channel_delivery_log
  id              uuid PK
  channelId       uuid FK notification_channels ON DELETE CASCADE
  messageRef      varchar(120) NOT NULL         -- caller-supplied idempotency key
  eventType       varchar(120) NULL             -- from event-subscriptions, NULL for ad-hoc
  status          varchar(16) NOT NULL          -- 'pending' | 'delivered' | 'failed' | 'retrying' | 'dropped'
  providerMessageId varchar(200) NULL
  errorMessage    text NULL
  attemptCount    int NOT NULL DEFAULT 0
  deliveredAt     timestamp NULL
  createdAt       timestamp
  INDEX (channelId, createdAt)
  INDEX (messageRef)                            -- idempotency lookup
```

### 4.2 Reuses

- `PluginUsageEvent` — adds rows with `capability='notification-channel'`.
- BullMQ — adds `notification-channel-retry` queue (3 attempts, exponential backoff).

---

## 5. Webhook surface

For channels that support delivery events (Discord/Slack via interactivity webhooks, Novu's webhook surface, etc.):

```
POST /api/notification-channels/events/:pluginId    -- inbound delivery/interaction events
GET  /api/notification-channels/verify/:tokenId     -- "click here to confirm this channel" link target
```

Same signature-verification + rate-limit treatment as the email webhooks.

---

## 6. Providers — initial list

| Plugin             | Shape     | Auth                                 | Notes                                                  |
| ------------------ | --------- | ------------------------------------ | ------------------------------------------------------ |
| `discord-channel`  | broadcast | Webhook URL (preferred) or bot token | Webhook is simpler; bot token enables interactivity    |
| `slack-channel`    | broadcast | Incoming Webhook URL or bot token    | Block Kit for rich content                             |
| `telegram-channel` | direct    | Bot token + chat id                  | One channel per chat; ChatId discovery via /start ping |
| `whatsapp-channel` | direct    | WhatsApp Business API credentials    | Template-only outbound (24h window rule)               |
| `novu-channel`     | workflow  | Novu API key + workflow id           | Delegates to Novu's own multi-channel workflows        |

The in-app channel is built-in (no plugin package).

---

## 7. Out of scope (v1)

- **Interactive responses** (Slack slash-commands, Discord button clicks) — receive only; reply lives in v2.
- **SMS / voice** — separate `voice-providers` spec.
- **Per-channel template management** (Discord embed builders, Slack Block Kit editor in UI). v1 sends text + optional pre-built `rich` payload; UI authoring lands in v2.
- **WhatsApp template authoring** — operators register WhatsApp templates with Meta themselves; v1 just references the template name.

---

## 8. Acceptance criteria

- [ ] Operator can connect Discord via webhook URL; "Test" button delivers a message within 5s.
- [ ] Operator can connect Slack via incoming webhook; same.
- [ ] Operator can connect Telegram via bot token + chat id; same.
- [ ] Per-user channel preferences (from [`event-subscriptions`](../event-subscriptions/spec.md)) resolve correctly when `NotificationChannelFacadeService.send` is called.
- [ ] Failed delivery on one channel does not block delivery on others (fan-out).
- [ ] Retry policy fires correctly (3 attempts → dead-letter row in delivery log).
- [ ] All channel plugins declare `NOTIFICATION_CHANNEL` capability + their specific channel constant.
- [ ] `PluginUsageEvent` rows carry `capability='notification-channel'` + `channelId` for spend rollups.

---

## 9. Constitution gates

- [x] **I** Plugin-first — each channel ships as its own package under `packages/plugins/`.
- [x] **II** Capability-driven — selection via `PLUGIN_CAPABILITIES.NOTIFICATION_CHANNEL_*`.
- [x] **III** Database — new tables go through TypeORM migrations per repo rules.
- [x] **IV** Trigger.dev / BullMQ — retry queue uses BullMQ (already in use).
- [x] **V** Forward-only migrations — additive tables only.
- [x] **VI** Tests — Vitest unit tests per plugin + Jest integration tests for the facade.
- [x] **VII** Secret hygiene — bot tokens / API keys marked `x-secret` in the plugin manifest.
- [x] **VIII** Plugin counts — adds 5 new plugins (Discord/Slack/Telegram/WhatsApp/Novu).
- [x] **IX** Behaviour-first — spec covers user-observable delivery semantics.
- [x] **X** Backwards-compat — existing in-app notifications keep working; new code is purely additive.

---

## 10. References

- Sibling specs: [`email-providers`](../email-providers/spec.md), [`event-subscriptions`](../event-subscriptions/spec.md), [`agent-inbox-ui`](../agent-inbox-ui/spec.md)
- Existing in-app surface: [`notifications`](../notifications/spec.md) (v1 retrospective)
- Existing transactional mail: [`mail-providers`](../mail-providers/spec.md) (v1 retrospective)
- Plan: [`plan.md`](./plan.md)
- Tasks: [`tasks.md`](./tasks.md)
