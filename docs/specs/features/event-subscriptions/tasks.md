# Task Breakdown: Event Subscriptions

**Feature ID**: `event-subscriptions`
**Last updated**: 2026-05-28

Each task = one Jira child issue. Target ~10 min per task.

## Phase 1 — Event registry

- [ ] **T1** `notification-event-type.entity.ts` + repository.
- [ ] **T2** Seed migration with core event types (v1 dedup keys + Work/Agent/Mission lifecycle).
- [ ] **T3** Plugin manifest parser for `events: [...]` extension.
- [ ] **T4** Plugin-load hook: upsert plugin-contributed event types into registry.

## Phase 2 — Subscription resolver

- [ ] **T5** `UserNotificationSubscriptionService.resolveChannels` happy path.
- [ ] **T6** Quiet-hours evaluation (timezone-aware).
- [ ] **T7** Category mute evaluation.
- [ ] **T8** Organisation defaults fallback chain.
- [ ] **T9** BullMQ delayed-delivery for quiet-hours-caught events.

## Phase 3 — Data model

- [ ] **T10** Migration `<unix>-AddEventSubscriptionsTables.ts`.
- [ ] **T11** Entities + repositories for all 5 new tables.

## Phase 4 — Producer fanout

- [ ] **T12** Add `resolveAndDispatch` call to `notifyAiCreditsDepleted`.
- [ ] **T13** Add to `notifyAiProviderError`.
- [ ] **T14** Add to `notifyGenerationAccountError`.
- [ ] **T15** Add to `notifySchedulePaused`.
- [ ] **T16** Add to `notifyGitAuthExpired`.
- [ ] **T17** Generic `Notifier.dispatch(userId, eventType, payload)` helper.

## Phase 5 — REST API

- [ ] **T18** `NotificationPreferencesController` skeleton.
- [ ] **T19** `GET /api/notifications/preferences`.
- [ ] **T20** `PUT /api/notifications/preferences/event/:eventKey`.
- [ ] **T21** `PUT /api/notifications/preferences/quiet-hours`.
- [ ] **T22** `POST/DELETE /api/notifications/preferences/mute`.
- [ ] **T23** `GET /api/notifications/event-types` (registry list).

## Phase 6 — UI

- [ ] **T24** `/settings/notifications` matrix layout.
- [ ] **T25** Channel-column checkbox grid wired to PUT endpoint.
- [ ] **T26** Quiet-hours editor.
- [ ] **T27** Category-mute panel.
- [ ] **T28** First-visit prefill from org defaults.

## Phase 7 — Testing

- [ ] **T29** Resolver unit tests (8+ cases covering happy path + edge cases).
- [ ] **T30** Producer-fanout integration test.
- [ ] **T31** Playwright E2E: change preference → trigger event → assert delivery to right channels.

## Phase 8 — Docs

- [ ] **T32** User guide.
- [ ] **T33** Operator guide for org defaults.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
