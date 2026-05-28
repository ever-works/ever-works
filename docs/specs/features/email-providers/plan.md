# Implementation Plan: Email Providers

**Feature ID**: `email-providers`
**Jira Epic**: [EW-650](https://evertech.atlassian.net/browse/EW-650)
**Branch**: `feat/notifications-v2-multichannel` (umbrella branch for the 4-spec rollout)
**Spec**: [`spec.md`](./spec.md) (v1.1)
**Status**: `In Progress`
**Last updated**: 2026-05-28

---

## Phase 1 — Plugin contracts & capabilities

- **P1.1** Declare `PLUGIN_CAPABILITIES.EMAIL_OUTBOUND` and `PLUGIN_CAPABILITIES.EMAIL_INBOUND` in `packages/plugin/src/contracts/capabilities/`.
- **P1.2** Define `IEmailOutboundPlugin` and `IEmailInboundPlugin` interfaces (see spec §3.2/§3.3).
- **P1.3** Define canonical DTOs: `EmailSendInput`, `EmailSendResult`, `EmailInboundMessage`, `EmailDeliveryEvent`, `EmailVerification`, `EmailAttachment`.
- **P1.4** Add capability discovery helpers to `plugin-registry.service.ts` (`getOutboundEmailProviders()`, `getInboundEmailProviders()`).

## Phase 2 — Data model

- **P2.1** Entities under `packages/agent/src/entities/`:
    - `tenant-email-address.entity.ts`
    - `agent-email-assignment.entity.ts`
    - `email-message.entity.ts`
    - `email-conversation.entity.ts` (v1.1)
- **P2.2** Migration `apps/api/src/migrations/<unix-millis>-AddEmailProvidersTables.ts`. Includes the partial unique indexes called out in spec §4.1.
- **P2.3** Repositories in `packages/agent/src/database/repositories/`.

## Phase 3 — EmailFacadeService

- **P3.1** `packages/agent/src/facades/email.facade.ts` mirroring `AiFacadeService` shape.
- **P3.2** Resolution priority: explicit address override → Agent default → first-enabled provider for the capability.
- **P3.3** Settings resolution via the 4-level hierarchy (Work → User → Admin → Plugin defaults).
- **P3.4** Per-call `EmailFacadeOptions` with `userId`, `workId?`, `agentId?`, `taskId?` for attribution.
- **P3.5** `PluginUsageEvent` emission on every send (`capability='email'`).
- **P3.6** React-Email rendering path: when `template.kind === 'react'`, render via `@react-email/render` before handoff to plugin.

## Phase 4 — REST API surface

- **P4.1** `apps/api/src/email/email.controller.ts` — tenant address CRUD, list, verify.
- **P4.2** Webhook routes: `POST /api/email/inbound/:pluginId`, `POST /api/email/events/:pluginId`, `GET /api/email/verify/:tokenId`.
- **P4.3** Webhook signature verification per plugin; 401 with no body on mismatch (don't leak which secret is wrong).
- **P4.4** Rate-limit webhook endpoints (default 600/min per plugin id) via `@nestjs/throttler`.

## Phase 5 — Agent integration

- **P5.1** `sendEmail` tool descriptor in `packages/agent/src/agents/tools/` gated on `canCallExternalTools` + ≥1 outbound assignment.
- **P5.2** `AGENT_INBOUND_EMAIL_DISPATCHER` injection token with default binding that resolves Agent → Task or Agent → EmailConversation per assignment mode.
- **P5.3** `messageAgent` tool descriptor (spec §12.4) — resolves target Agent's primary inbound address.
- **P5.4** AGENT_GIT_FACADE updates: read `Agent.committerEmail`, fall back to `<slug>@agents.ever.works` placeholder.
- **P5.5** New `EMAIL_SENT` / `EMAIL_RECEIVED` activity-log actions.

## Phase 6 — Provider plugins (one PR per provider — see [tasks.md](./tasks.md))

- **P6.1** `packages/plugins/postmark/` — reference implementation, outbound + inbound.
- **P6.2** `packages/plugins/resend/` — outbound only (Resend inbound still private beta).
- **P6.3** `packages/plugins/mailgun/` — outbound + inbound.
- **P6.4** `packages/plugins/sendgrid/` — outbound + inbound.
- **P6.5** `packages/plugins/mailchimp-transactional/` — outbound + inbound.
- **P6.6** `packages/plugins/local-smtp/` — dev/self-host fallback via `nodemailer`, outbound only.

## Phase 7 — Web UI (handed off to [`agent-inbox-ui`](../agent-inbox-ui/plan.md))

The settings UI (`/settings/integrations/emails`) and the per-Agent inbox surfaces live in the sibling `agent-inbox-ui` spec. This epic only owns the API surface they consume.

## Phase 8 — React-Email templates

- **P8.1** `pnpm add @react-email/components @react-email/render` to `apps/api`.
- **P8.2** Template directory `apps/api/src/email/templates/react/` with at least one reference template (`agent-summary.tsx`).
- **P8.3** Zod schemas co-located with each template export the typed `Props` shape so the composer UI can build a form for them.

## Phase 9 — Testing

- **P9.1** Unit tests for `EmailFacadeService` covering resolution + attribution.
- **P9.2** Unit tests per provider plugin (Vitest) covering happy path + signature failure.
- **P9.3** E2E test: register Postmark outbound address → trigger verification → assign to Agent → trigger `sendEmail` from agent run → assert `PluginUsageEvent` row.
- **P9.4** E2E test: inbound webhook (mocked Postmark POST) → message lands in `email_messages` → Task spawned.

## Phase 10 — Docs

- **P10.1** Update `apps/docs/` with operator-facing "Connect an email provider" guide.
- **P10.2** Add per-provider setup notes (Postmark/Mailgun/Sendgrid/Resend webhook URLs operators must register).
- **P10.3** Update `docs/specs/architecture/database.md` with the new tables.

## Dependencies & cross-spec coordination

- **Independent of**: [`notification-channels`](../notification-channels/plan.md) — both share the plugin-capabilities foundation but ship on separate timelines.
- **Consumed by**: [`event-subscriptions`](../event-subscriptions/plan.md) — once email is a registered delivery channel, the subscriptions surface treats it like any other channel.
- **UI implemented by**: [`agent-inbox-ui`](../agent-inbox-ui/plan.md).

## Out of scope (mirrors spec §8)

Reply-by-email SMTP threading (v2), template management UI (v2), S/MIME / PGP (no plan), multi-tenant routing (waits for multi-tenancy track).
