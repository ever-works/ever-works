# Implementation Plan: Event Subscriptions

**Feature ID**: `event-subscriptions`
**Spec**: [`spec.md`](./spec.md)
**Branch**: `feat/notifications-v2-multichannel`
**Status**: `Draft`
**Last updated**: 2026-05-28

## Phase 1 — Event registry

- **P1.1** `notification-event-type.entity.ts` + repository.
- **P1.2** Bootstrap seed of core event types (mirrors v1 dedup keys + Work/Agent/Mission lifecycle).
- **P1.3** Plugin manifest extension: `events: [{key, category, urgent, defaultChannels}]` parsed at plugin-load time + upserted into the registry.

## Phase 2 — Subscription resolver

- **P2.1** `UserNotificationSubscriptionService` with `resolveChannels(userId, eventType)`.
- **P2.2** Quiet-hours evaluation (user timezone-aware).
- **P2.3** Category-mute evaluation.
- **P2.4** Organisation defaults fallback.
- **P2.5** Delayed-delivery scheduling for non-urgent events caught in quiet windows (BullMQ delayed job).

## Phase 3 — Data model

- **P3.1** Migrations for: `notification_event_types`, `user_notification_subscriptions`, `user_notification_preferences`, `user_notification_category_mutes`, `organization_notification_defaults`.
- **P3.2** Entities + repositories.

## Phase 4 — Producer fanout

- **P4.1** Update v1 producer methods (`notifyAiCreditsDepleted`, …) to call `resolveAndDispatch` after creating the in-app notification.
- **P4.2** Generic `Notifier.dispatch(userId, eventType, payload)` helper for new producers to use directly.

## Phase 5 — REST API

- **P5.1** `NotificationPreferencesController` — GET preferences, PUT event/quiet-hours, POST/DELETE category mute.
- **P5.2** `GET /api/notifications/event-types` — list registered events for UI matrix.

## Phase 6 — UI

- **P6.1** `/settings/notifications` page — event-type matrix with channel-column checkboxes.
- **P6.2** Quiet-hours editor (time-range picker + timezone autodetect).
- **P6.3** Category mute panel.

## Phase 7 — Testing

- **P7.1** Resolver unit tests (channel selection, quiet hours, mutes, org defaults).
- **P7.2** Integration test through v1 producer → in-app + multichannel delivery.

## Phase 8 — Docs

- **P8.1** "Configure your notification preferences" user-facing guide.
- **P8.2** Operator guide for setting org defaults.

## Dependencies

- **Depends on**: [`notification-channels`](../notification-channels/plan.md) (channels are the columns of the matrix).
- **Independent of**: [`email-providers`](../email-providers/plan.md) — email is just one channel.
- **Extends**: [`../notifications`](../notifications/spec.md) v1 (additive — v1 behaviour preserved).
