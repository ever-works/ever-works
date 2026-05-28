# Task Breakdown: Per-Agent Inbox UI

**Feature ID**: `agent-inbox-ui`
**Last updated**: 2026-05-28

Each task = one Jira child issue. Target ~10 min per task.

## Phase 1 — Dependencies

- [ ] **T1** Install `@react-email/components` + `@react-email/render` in `apps/web`.
- [ ] **T2** Install `@novu/react` (gated, only when novu plugin enabled).

## Phase 2 — Settings routes

- [ ] **T3** `/settings/integrations/emails` page shell (list view).
- [ ] **T4** Add-address wizard (4-step Sheet).
- [ ] **T5** `/settings/integrations/channels` page shell.
- [ ] **T6** Add-channel wizard (3-step Sheet).
- [ ] **T7** `/settings/notifications` page shell (subscriptions matrix).
- [ ] **T8** Sidebar update to include new entries.

## Phase 3 — Per-Agent inbox tab

- [ ] **T9** Add Inbox tab to agent detail layout.
- [ ] **T10** Inbox list page (table + filters).
- [ ] **T11** Message detail page.
- [ ] **T12** Composer page.

## Phase 4 — Components

- [ ] **T13** `AddressList` component.
- [ ] **T14** `AddAddressWizard` (4 steps + verification poll).
- [ ] **T15** `MessageList` (virtualised when >500 rows).
- [ ] **T16** `MessageDetail`.
- [ ] **T17** `Composer` form (subject + to/cc/bcc chips + body).
- [ ] **T18** `Composer` React-Email template mode toggle.
- [ ] **T19** `Composer` live preview iframe.
- [ ] **T20** `ChannelList` + `AddChannelWizard`.
- [ ] **T21** `PreferencesMatrix` (event × channel checkbox grid).
- [ ] **T22** Quiet-hours + category-mute panels.

## Phase 5 — Data hooks

- [ ] **T23** `useEmailAddresses`.
- [ ] **T24** `useAgentInbox`.
- [ ] **T25** `useEmailMessage`.
- [ ] **T26** `useNotificationChannels`.
- [ ] **T27** `useNotificationPreferences`.
- [ ] **T28** `useInboxStream` (SSE + SWR fallback).

## Phase 6 — i18n

- [ ] **T29** English strings for all new surfaces.

## Phase 7 — Testing

- [ ] **T30** Composer state-machine unit tests.
- [ ] **T31** Playwright E2E: add address → assign → send message round-trip.
- [ ] **T32** axe-core accessibility pass on new routes.

## Phase 8 — Polish

- [ ] **T33** Empty states.
- [ ] **T34** Virtualised message list for >1000 rows.
- [ ] **T35** Provider-error chip + retry action.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
