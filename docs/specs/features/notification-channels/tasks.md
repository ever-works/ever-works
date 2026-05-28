# Task Breakdown: Notification Channels

**Feature ID**: `notification-channels`
**Last updated**: 2026-05-28

Each task = one Jira child issue. Target ~10 min per task.

## Phase 1 — Contracts + facade

- [ ] **T1** Declare `NOTIFICATION_CHANNEL` umbrella + 5 channel-specific capability constants.
- [ ] **T2** Define `INotificationChannelPlugin` interface + canonical DTOs.
- [ ] **T3** `NotificationChannelFacadeService` scaffold (resolve user channels → fanout).
- [ ] **T4** Per-channel retry policy (3 attempts exp-backoff).
- [ ] **T5** In-app channel built-in adapter (wraps existing notifications v1 service).
- [ ] **T6** BullMQ `notification-channel-retry` queue + dead-letter handler.

## Phase 2 — Data model

- [ ] **T7** `notification-channel.entity.ts` + repository.
- [ ] **T8** `notification-channel-delivery-log.entity.ts` + repository.
- [ ] **T9** Migration `<unix>-AddNotificationChannelsTables.ts` with idempotency index.

## Phase 3 — REST API

- [ ] **T10** `NotificationChannelsController` — list/create/update/delete.
- [ ] **T11** `POST /api/notification-channels/:id/test` test-send endpoint.
- [ ] **T12** `POST /api/notification-channels/events/:pluginId` webhook ingestion.
- [ ] **T13** Signature verification + 401 on mismatch.
- [ ] **T14** `@nestjs/throttler` rate limit.

## Phase 4 — Agent integration

- [ ] **T15** `notifyChannel` tool descriptor.
- [ ] **T16** Activity-log actions for channel notifications.

## Phase 5 — Provider plugins

- [ ] **T17** `packages/plugins/discord-channel/` — webhook send + signature verify.
- [ ] **T18** `packages/plugins/discord-channel/` — Vitest tests.
- [ ] **T19** `packages/plugins/slack-channel/` — incoming webhook + Block Kit.
- [ ] **T20** `packages/plugins/slack-channel/` — Vitest tests.
- [ ] **T21** `packages/plugins/telegram-channel/` — bot API sendMessage.
- [ ] **T22** `packages/plugins/telegram-channel/` — Vitest tests.
- [ ] **T23** `packages/plugins/whatsapp-channel/` — Business API template send.
- [ ] **T24** `packages/plugins/whatsapp-channel/` — Vitest tests.
- [ ] **T25** `packages/plugins/novu-channel/` — trigger API integration.
- [ ] **T26** `packages/plugins/novu-channel/` — Vitest tests.

## Phase 6 — UI

- [ ] **T27** `/settings/integrations/channels` page — list view.
- [ ] **T28** Add-channel wizard (provider picker → target config → test).
- [ ] **T29** Per-channel "Test" button + delivery log preview.

## Phase 7 — Testing

- [ ] **T30** Facade unit tests (fan-out, failover, retry).
- [ ] **T31** Playwright E2E: connect Discord webhook → test message → delivery log assertion.

## Phase 8 — Docs

- [ ] **T32** "Connect a notification channel" guide.
- [ ] **T33** Per-provider setup notes (5 providers).

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
