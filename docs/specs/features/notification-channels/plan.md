# Implementation Plan: Notification Channels

**Feature ID**: `notification-channels`
**Spec**: [`spec.md`](./spec.md)
**Branch**: `feat/notifications-v2-multichannel`
**Status**: `Draft`
**Last updated**: 2026-05-28

## Phase 1 — Plugin contract + facade

- **P1.1** Declare `NOTIFICATION_CHANNEL` umbrella + 5 channel-specific capability constants in `packages/plugin/src/contracts/capabilities/`.
- **P1.2** Define `INotificationChannelPlugin` interface + DTOs (`ChannelSendInput`, `ChannelSendResult`, `ChannelTargetConfig`, `ChannelVerification`, `ChannelDeliveryEvent`).
- **P1.3** `NotificationChannelFacadeService` in `packages/agent/src/facades/notification-channel.facade.ts`.
- **P1.4** In-app channel built-in implementation (wraps existing `notifications` v1 — no external send).
- **P1.5** BullMQ retry queue `notification-channel-retry` (3 attempts exp-backoff, 24h dead-letter).

## Phase 2 — Data model

- **P2.1** `notification-channel.entity.ts` + repository.
- **P2.2** `notification-channel-delivery-log.entity.ts` + repository.
- **P2.3** Migration `<unix>-AddNotificationChannelsTables.ts`.

## Phase 3 — REST API

- **P3.1** `NotificationChannelsController` — CRUD + test-send endpoint.
- **P3.2** Webhook routes (delivery events, channel verification click-through).
- **P3.3** Signature verification + rate limits.

## Phase 4 — Agent integration

- **P4.1** `notifyChannel` tool descriptor (gated on `canCallExternalTools` + ≥1 enabled channel).
- **P4.2** Activity-log actions: `CHANNEL_NOTIFICATION_SENT`, `CHANNEL_NOTIFICATION_FAILED`.

## Phase 5 — Provider plugins

- **P5.1** `packages/plugins/discord-channel/` — webhook + optional bot mode.
- **P5.2** `packages/plugins/slack-channel/` — incoming webhook + Block Kit support.
- **P5.3** `packages/plugins/telegram-channel/` — bot API send.
- **P5.4** `packages/plugins/whatsapp-channel/` — WhatsApp Business API (template messages).
- **P5.5** `packages/plugins/novu-channel/` — Novu trigger API + workflow id mapping.

## Phase 6 — UI

The settings UI for "Notification Channels" lives in `apps/web/src/app/[locale]/(app)/settings/integrations/channels/`. The per-channel-per-event preference matrix is implemented by [`event-subscriptions`](../event-subscriptions/plan.md).

- **P6.1** `/settings/integrations/channels` page — list + add wizard.
- **P6.2** Per-channel "Test" button → calls `POST /api/notification-channels/:id/test`.

## Phase 7 — Testing

- **P7.1** Unit tests per plugin (Vitest) — happy path, signature failure, idempotency.
- **P7.2** Facade unit tests — fan-out, failover, retry queueing.
- **P7.3** E2E test: connect Discord webhook → trigger test message → assert delivery log row.

## Phase 8 — Docs

- **P8.1** "Connect a notification channel" operator guide.
- **P8.2** Per-provider setup notes (Discord webhook creation, Telegram BotFather, WhatsApp Business setup, …).

## Dependencies

- **Depends on**: plugin-registry foundation (already shipped).
- **Independent of**: [`email-providers`](../email-providers/plan.md) — both consume the plugin registry but ship independently.
- **Consumed by**: [`event-subscriptions`](../event-subscriptions/plan.md) — the channel registry feeds the per-user-per-event preference matrix.
