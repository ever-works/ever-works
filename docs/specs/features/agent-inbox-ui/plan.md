# Implementation Plan: Per-Agent Inbox UI

**Feature ID**: `agent-inbox-ui`
**Spec**: [`spec.md`](./spec.md)
**Branch**: `feat/notifications-v2-multichannel`
**Status**: `Draft`
**Last updated**: 2026-05-28

## Phase 1 — Dependencies

- **P1.1** `pnpm add @react-email/components @react-email/render -F @ever-works/web` (preview pane only).
- **P1.2** Consider `pnpm add @novu/react -F @ever-works/web` behind a feature flag (only when the `novu-channel` plugin is enabled).

## Phase 2 — Settings routes

- **P2.1** `apps/web/src/app/[locale]/(app)/settings/integrations/emails/page.tsx` — addresses list + add wizard.
- **P2.2** `apps/web/src/app/[locale]/(app)/settings/integrations/channels/page.tsx` — channels list + add wizard.
- **P2.3** `apps/web/src/app/[locale]/(app)/settings/notifications/page.tsx` — event-type subscription matrix (consumes `event-subscriptions` API).
- **P2.4** Update the `settings/layout.tsx` sidebar to include the three new entries.

## Phase 3 — Per-Agent inbox tab

- **P3.1** Add `Inbox` tab to `apps/web/src/app/[locale]/(app)/agents/[id]/layout.tsx`.
- **P3.2** `apps/web/src/app/[locale]/(app)/agents/[id]/inbox/page.tsx` — list view.
- **P3.3** `apps/web/src/app/[locale]/(app)/agents/[id]/inbox/[messageId]/page.tsx` — message detail.
- **P3.4** `apps/web/src/app/[locale]/(app)/agents/[id]/inbox/compose/page.tsx` — composer.

## Phase 4 — Components

- **P4.1** `components/email/AddressList.tsx` (used by settings page).
- **P4.2** `components/email/AddAddressWizard.tsx` (4-step Sheet).
- **P4.3** `components/email/MessageList.tsx` (per-agent inbox).
- **P4.4** `components/email/MessageDetail.tsx` (right-pane preview + full-page detail).
- **P4.5** `components/email/Composer.tsx` (form + template-mode toggle + React-Email preview iframe).
- **P4.6** `components/notification-channel/ChannelList.tsx` + `AddChannelWizard.tsx`.
- **P4.7** `components/notifications/PreferencesMatrix.tsx` (event-subscriptions UI).

## Phase 5 — Data hooks (SWR)

- **P5.1** `useEmailAddresses(filter)`.
- **P5.2** `useAgentInbox(agentId, opts)`.
- **P5.3** `useEmailMessage(messageId)`.
- **P5.4** `useNotificationChannels()`.
- **P5.5** `useNotificationPreferences()` + per-event PUT helpers.
- **P5.6** SSE hook `useInboxStream(agentId)` with SWR fallback.

## Phase 6 — i18n strings

- **P6.1** Add all new strings under `apps/web/src/i18n/messages/en.json` (next-intl); locale fallbacks inherit.

## Phase 7 — Testing

- **P7.1** Component-level Vitest tests for the composer state machine.
- **P7.2** Playwright E2E: settings → add address → assign to agent → open inbox → send message.

## Phase 8 — Polish

- **P8.1** Empty states + error chips per spec §5.
- **P8.2** Accessibility pass (axe-core in Playwright).
- **P8.3** Performance: virtualised message list (>1000 messages).

## Dependencies

- **Depends on**: API surface from [`email-providers`](../email-providers/plan.md) (Phases 1-4 of that plan).
- **Depends on**: API surface from [`notification-channels`](../notification-channels/plan.md) (Phases 1-3 of that plan).
- **Depends on**: API surface from [`event-subscriptions`](../event-subscriptions/plan.md) (Phase 5 of that plan).
