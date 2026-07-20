# Implementation Plan: Connectors (First-Party Communication-Channel Plugins)

**Feature ID:** `connectors`
**Spec:** [`spec.md`](./spec.md)
**Status:** Draft v1
**Owner:** Product (Ruslan)
**Date:** 2026-07-18

> **Additive-only.** Every phase adds category strings, capability constants, tables (nullable scope columns), packages, and services. Nothing in the existing `notification-channel` / aggregator / MCP surfaces is renamed or removed. Each entity change ships its migration in the same PR (`apps/api/src/migrations/<unix>-*.ts`).

This is a **continuous** program. The durable deliverables are the `connector` category, the `IConnectorPlugin` contract, and the routing/pairing/session services. Providers land one at a time against that stable contract.

---

## Phase 1 — Category, contract, facade, Slack outbound

Goal: a first-party bidirectional-capable plugin category exists, and `slack-connector` can send a message end-to-end from the UI.

- **P1.1** Add `'connector'` to `PLUGIN_CATEGORIES` (`packages/plugin/src/contracts/plugin-manifest.types.ts`).
- **P1.2** Add `CONNECTOR` + `CONNECTOR_SLACK` / `_DISCORD` / `_WHATSAPP` / `_NOTION` / `_MICROSOFT_365` to `PLUGIN_CAPABILITIES` (`packages/plugin/src/contracts/facade-capabilities.ts`).
- **P1.3** Define `IConnectorPlugin` + DTOs (`ConnectorMetadata`, `ConnectorCapabilityFlags`, `ConnectorInboundRequest/Event`, `ConnectorReply`, `ConnectorRecordInput/Result`, `ConnectorPollResult`, `ConnectorCallOptions`, `isConnectorPlugin`) in `packages/plugin/src/contracts/capabilities/connector.interface.ts`. Re-use `ChannelSendInput`/`ChannelSendResult`/`ChannelTargetConfig`/`ChannelVerification` from `notification-channel.interface.ts`. Export from the package barrel.
- **P1.4** `BaseConnectorPlugin` (`packages/plugin/src/abstract/base-connector.ts`): per-`connectorId` NUL-keyed idempotency cache, SSRF-guarded fetch, signature-verify toolkit (HMAC + ed25519, constant-time, timestamp-skew clamp), default `onLoad/onUnload`.
- **P1.5** `connectors` entity (`packages/agent/src/entities/connector.entity.ts`, Tier A) + repository + register in `packages/agent/src/database/database.config.ts` `ENTITIES` (no `autoLoadEntities` — explicit registration is mandatory, else `EntityMetadataNotFoundError`). `@EncryptedJsonColumn` for `targetConfig`.
- **P1.6** Migration `<unix>-AddConnectorsTable.ts`.
- **P1.7** `ConnectorFacadeService` (`packages/agent/src/facades/connector.facade.ts`): `send` / `verifyConnection` (outbound only this phase), owner-scoped lookup, secret redaction + length cap, `PluginUsageEvent` (new `PluginUsageCapability.CONNECTOR`). Trigger.dev `connector-delivery` dispatcher interface + in-process fallback (mirror the notification facade's optional dispatcher).
- **P1.8** `PluginUsageCapability.CONNECTOR` enum value (`packages/agent/src/entities/plugin-usage-event.entity.ts`).
- **P1.9** REST: `apps/api/src/connectors/connectors.controller.ts` + `connectors.service.ts` + `connectors.module.ts` — `GET/POST /`, `PATCH/DELETE /:id`, `POST /:id/verify`, `POST /:id/test`. DTO whitelist + `targetConfig` byte cap + `ParseUUIDPipe` + `@Throttle` (copy the notification-channels controller posture).
- **P1.10** `slack-connector` package (`packages/plugins/slack-connector/`): `package.json` (`@slack/web-api`), `tsup.config.ts`, `tsconfig.json`, `vitest.config.ts`, `src/slack-connector-plugin.ts` (outbound `chat.postMessage`, `verifyConnection` = `auth.test`), `src/index.ts` singleton.
- **P1.11** Web UI: `apps/web/.../settings/integrations/connectors/` — connectors list + Add-Connector wizard (schema-driven form, `x-secret` password inputs, verify step, test-send). New "Connectors" group on `/settings/plugins`.
- **P1.12** Bridge: `NotificationChannelFacadeService` optional resolver can target a `connectors` row so connectors appear in the [`event-subscriptions`](../event-subscriptions/plan.md) matrix (no data copy).
- **P1.13** Tests: Vitest for `slack-connector` (send happy-path, idempotency, `verifyConnection`); Jest for `ConnectorFacadeService` (outbound, owner-scope IDOR, redaction); API e2e for CRUD + test-send.

---

## Phase 2 — Discord, inbound, pairing, chat-everything routing

Goal: an external message routes to an Agent and gets a reply, gated by pairing and isolated per conversation.

- **P2.1** Entities (Tier C, no `@ManyToOne` on scope FKs) + repositories + `ENTITIES` registration: `connector_identities`, `connector_pairing_codes`, `connector_conversations`, `connector_message_log`.
- **P2.2** Migration `<unix>-AddConnectorInboundTables.ts` (all four tables + indexes/uniques).
- **P2.3** Extend `IConnectorPlugin` usage: wire `verifyInbound` / `handleChallenge` / `parseInbound` / `reply` through `ConnectorFacadeService.handleInbound`.
- **P2.4** Inbound webhook route `POST /api/connectors/inbound/:connectorId` (`@Public`, `rawBody` capture, resolve-by-id → verify → challenge → parse → 202/401). Mirror `composio-triggers` fail-closed shape.
- **P2.5** `ConnectorRoutingService` (`packages/agent/src/connectors/connector-routing.service.ts`): inbound dedupe, identity/pairing resolution, session resolve/create (composite `user:channel:conversation` key + `conversations` link), dispatch to the chat-everything engine as the paired user under the routed Agent's `AgentPermissions`, reply via the connector.
- **P2.6** Untrusted-content fencing on inbound text before the engine (reuse `apps/mcp` `fence-untrusted`/`sanitize` approach).
- **P2.7** Pairing: `POST /:id/pairing-codes` (mint, hashed at rest, ≤15-min TTL, single-use, throttled), redeem path inside `ConnectorRoutingService`, `GET /:id/identities`, `DELETE /:id/identities/:identityId`, `GET /:id/conversations`.
- **P2.8** `discord-connector` package (`packages/plugins/discord-connector/`): `@discordjs/rest` + `discord-interactions`; outbound `Routes.channelMessages`, inbound Interactions (`verifyKey` ed25519, PING→PONG), `reply`.
- **P2.9** `slack-connector` inbound: Events API `verifyInbound` (v0 HMAC + skew clamp), `handleChallenge` (`url_verification`), `parseInbound` (`message`/`app_mention`), `reply` (threaded `chat.postMessage`).
- **P2.10** Web UI: per-connector inbound URL (copyable), default Agent/Team + routing-mode selector, pairing panel (mint code + instructions), identities + conversations tabs.
- **P2.11** Tests: signature-verify (valid/invalid/replayed/skewed) per plugin; pairing (mint/redeem/expiry/single-use/revoke); routing (unpaired→prompt, paired→agent reply, session isolation, inbound dedupe); e2e Discord Interactions + Slack Events round-trip.

---

## Phase 3 — WhatsApp / Notion / Microsoft 365 + catalog repo

- **P3.1** `whatsapp-connector` — Cloud API; `X-Hub-Signature-256` verify; template-only outbound + 24h window; metered `getPricing`.
- **P3.2** `notion-connector` — `transport: 'poll'`; Trigger.dev scheduled `poll()` per enabled connector; `createRecord` (pages / DB rows); Notion verification token.
- **P3.3** `microsoft-365-connector` — Microsoft Graph; mail / Teams / files; Graph change-notification subscriptions + `clientState` verify + subscription-renewal loop.
- **P3.4** Discord Gateway `socket` transport for free-form (non-slash) messages — a long-lived worker; poll-vs-socket operational decision (§11.5).
- **P3.5** `ever-works/connectors` catalog repo — connector manifests + icons + setup guides + npm package refs; wire the plugin-catalog service to read it (agent-templates/ADR-011 analog) + EW-693 dynamic distribution (registry install-on-use).
- **P3.6** Docs: per-provider operator setup guides (create the Slack app, Discord bot, WhatsApp number, Notion integration, M365 app registration).

---

## Phase n — Continuous

Additional providers (Telegram bidirectional, Linear, GitHub, CRM connectors) as increments against the stable contract. Team-based routing, OAuth identity linking, and multi-workspace resolution fold in per demand (spec §11).

---

## Dependencies

- **Depends on:** plugin registry + loader (shipped); `@EncryptedJsonColumn` + secret resolution (shipped); Trigger.dev job runtime (shipped); notification-channel DTOs + SSRF guards (shipped, reused).
- **Integrates with:** [`chat-everything`](../chat-everything/plan.md) engine (inbound routing target), [`event-subscriptions`](../event-subscriptions/plan.md) (outbound bridge), [`tenants-and-organizations`](../tenants-and-organizations/spec.md) (scope columns), Agents (`AgentPermissions`, routing target).
- **Independent of:** the existing `*-channel` notification plugins and the Composio/Make/SIM/Zapier/Activepieces aggregators — both keep shipping unchanged.

## Constitution gates

- **I** Plugin-first — each connector is its own `packages/plugins/*` package.
- **II** Capability-driven — selection via `PLUGIN_CAPABILITIES.CONNECTOR*`.
- **III** Database — new tables via TypeORM migrations in the same PR; explicit `ENTITIES` registration.
- **IV** Job runtime — outbound delivery + poll via Trigger.dev; no BullMQ.
- **V** Forward-only migrations — additive tables, nullable scope columns.
- **VI** Tests — Vitest per plugin + Jest for facade/routing + e2e for inbound round-trips.
- **VII** Secret hygiene — bot tokens / signing secrets `x-secret` + encrypted `targetConfig` + `x-envVar`.
- **VIII** Additive — `*-channel` plugins, aggregators, MCP untouched; connectors are a superset.
- **IX** Behaviour-first — spec covers observable send/pair/route/reply semantics.
- **X** Security — mandatory fail-closed inbound verification, pairing gate, session isolation, Agent-permission clamp.
