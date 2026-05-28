# Task Breakdown: Email Providers

**Feature ID**: `email-providers`
**Jira Epic**: [EW-650](https://evertech.atlassian.net/browse/EW-650)
**Last updated**: 2026-05-28

Each task = one Jira child issue under EW-650. Approximate target: ~10 min of focused work per task (some larger items decomposed further).

## Phase 1 — Contracts & capabilities

- [ ] **T1** Declare `EMAIL_OUTBOUND` + `EMAIL_INBOUND` capability constants.
- [ ] **T2** Define `IEmailOutboundPlugin` + `IEmailInboundPlugin` interfaces.
- [ ] **T3** Canonical email DTOs: `EmailSendInput`, `EmailSendResult`, `EmailInboundMessage`, `EmailDeliveryEvent`, `EmailVerification`, `EmailAttachment`.
- [ ] **T4** Plugin registry helpers (`getOutboundEmailProviders`, `getInboundEmailProviders`).

## Phase 2 — Data model

- [ ] **T5** `tenant-email-address.entity.ts` + repository.
- [ ] **T6** `agent-email-assignment.entity.ts` + repository (with `dispatchMode: 'task-spawn' | 'conversation'` column from spec §12.2).
- [ ] **T7** `email-message.entity.ts` + repository (nullable `conversationId` FK).
- [ ] **T8** `email-conversation.entity.ts` + repository.
- [ ] **T9** Migration `<unix>-AddEmailProvidersTables.ts` including partial unique indexes.

## Phase 3 — EmailFacadeService

- [ ] **T10** Facade skeleton + resolution priority logic.
- [ ] **T11** 4-level settings hierarchy resolution.
- [ ] **T12** Per-call attribution (`PluginUsageEvent` emission).
- [ ] **T13** React-Email rendering integration (`@react-email/render` server-side).
- [ ] **T14** Unit tests for facade resolution + attribution.

## Phase 4 — REST API

- [ ] **T15** `EmailController` — list/create/update/delete tenant addresses.
- [ ] **T16** Address verification endpoint + token persistence.
- [ ] **T17** Webhook route `POST /api/email/inbound/:pluginId`.
- [ ] **T18** Webhook route `POST /api/email/events/:pluginId`.
- [ ] **T19** Webhook signature verification + 401 on mismatch.
- [ ] **T20** `@nestjs/throttler` rate limits on webhook routes.

## Phase 5 — Agent integration

- [ ] **T21** `sendEmail` tool descriptor.
- [ ] **T22** `messageAgent` tool descriptor (resolves target Agent → primary inbound).
- [ ] **T23** `AGENT_INBOUND_EMAIL_DISPATCHER` token + default binding (task-spawn mode).
- [ ] **T24** Conversation-mode dispatcher (appends to `email_conversations`, invokes chat-reply path).
- [ ] **T25** AGENT_GIT_FACADE updates for committer email resolution.
- [ ] **T26** `EMAIL_SENT` + `EMAIL_RECEIVED` activity-log actions.

## Phase 6 — Provider plugins

- [ ] **T27** `packages/plugins/postmark/` reference implementation (outbound + inbound) + Vitest tests.
- [ ] **T28** `packages/plugins/resend/` (outbound only) + tests.
- [ ] **T29** `packages/plugins/mailgun/` (outbound + inbound) + tests.
- [ ] **T30** `packages/plugins/sendgrid/` (outbound + inbound) + tests.
- [ ] **T31** `packages/plugins/mailchimp-transactional/` (outbound + inbound) + tests.
- [ ] **T32** `packages/plugins/local-smtp/` (nodemailer fallback) + tests.

## Phase 7 — Templates

- [ ] **T33** Install `@react-email/components` + `@react-email/render` in `apps/api`.
- [ ] **T34** Reference template `agent-summary.tsx` with Zod props schema.
- [ ] **T35** Reference template `agent-message.tsx` for agent-to-agent comms.

## Phase 8 — E2E

- [ ] **T36** Playwright E2E: register Postmark address → verification → assign to Agent.
- [ ] **T37** Playwright E2E: agent `sendEmail` tool call → `PluginUsageEvent` row.
- [ ] **T38** Playwright E2E: inbound webhook → `email_messages` row → Task spawn.

## Phase 9 — Docs

- [ ] **T39** Operator guide: "Connect an email provider".
- [ ] **T40** Per-provider setup notes (webhook URLs, DNS records).
- [ ] **T41** Update `docs/specs/architecture/database.md` with new tables.

## Status legend

- `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Cross-spec follow-ups

- UI surfaces (settings page + per-Agent inbox) are tracked under [`agent-inbox-ui/tasks.md`](../agent-inbox-ui/tasks.md), not here.
- Multi-channel notification orchestration (Discord/Slack/etc.) is tracked under [`notification-channels/tasks.md`](../notification-channels/tasks.md).
