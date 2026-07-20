# Tasks: Connectors (First-Party Communication-Channel Plugins)

**Feature ID:** `connectors` · **Spec:** [`spec.md`](./spec.md) · **Plan:** [`plan.md`](./plan.md)
**Status:** Draft v1 · **Date:** 2026-07-18

Checklist form of [plan.md](plan.md). Each `[entity]`/`[migration]` pair ships in the same PR. Kebab-case files, tabs width 4, single quotes, no trailing commas.

---

## Phase 1 — Category, contract, facade, Slack outbound

### Contract + capabilities

- [ ] Add `'connector'` to `PLUGIN_CATEGORIES` (`packages/plugin/src/contracts/plugin-manifest.types.ts`)
- [ ] Add `CONNECTOR`, `CONNECTOR_SLACK`, `CONNECTOR_DISCORD`, `CONNECTOR_WHATSAPP`, `CONNECTOR_NOTION`, `CONNECTOR_MICROSOFT_365` to `PLUGIN_CAPABILITIES` (`facade-capabilities.ts`)
- [ ] `connector.interface.ts` — `IConnectorPlugin` + DTOs + `isConnectorPlugin` (reuse `ChannelSendInput`/`Result`/`TargetConfig`/`Verification`)
- [ ] Export `connector.interface` from the `@ever-works/plugin` barrel
- [ ] `BaseConnectorPlugin` (`packages/plugin/src/abstract/base-connector.ts`) — idempotency cache, SSRF fetch, HMAC/ed25519 verify toolkit
- [ ] Contract unit tests (`packages/plugin`) — type guard + base-class verify helpers

### Data + facade

- [ ] `connector.entity.ts` (Tier A) + `connector.repository.ts`
- [ ] Register `Connector` in `packages/agent/src/database/database.config.ts` `ENTITIES`
- [ ] Migration `<unix>-AddConnectorsTable.ts`
- [ ] `PluginUsageCapability.CONNECTOR` enum value
- [ ] `ConnectorFacadeService` (`packages/agent/src/facades/connector.facade.ts`) — `send`, `verifyConnection`, owner-scope, redaction, usage event
- [ ] `connector-delivery` Trigger.dev task + dispatcher binding (in-process fallback)
- [ ] Jest: facade outbound + IDOR owner-scope + error redaction

### REST + UI

- [ ] `connectors.controller.ts` / `connectors.service.ts` / `connectors.module.ts` — CRUD + `/verify` + `/test`
- [ ] DTO whitelist + `targetConfig` byte cap + `ParseUUIDPipe` + `@Throttle`
- [ ] Wire `ConnectorsModule` into the API app module
- [ ] Web: `settings/integrations/connectors/` list + Add-Connector wizard (schema-driven, `x-secret` inputs, verify + test steps)
- [ ] Web: "Connectors" group on `/settings/plugins`
- [ ] Bridge connectors into the `event-subscriptions` matrix (resolver in `NotificationChannelFacadeService`, no data copy)
- [ ] API e2e: connector CRUD + test-send

### slack-connector (outbound)

- [ ] Scaffold `packages/plugins/slack-connector/` (`package.json` w/ `@slack/web-api`, `tsup.config.ts`, `tsconfig.json`, `vitest.config.ts`)
- [ ] `everworks.plugin` block: `id: 'slack-connector'`, `category: 'connector'`, `capabilities: ['connector', 'connector-slack']`, `distribution: 'registry'`
- [ ] `src/slack-connector-plugin.ts` — `settingsSchema` (`botToken`/`signingSecret` `x-secret` + `x-envVar`), outbound `send` (`chat.postMessage`, idempotent), `verifyConnection` (`auth.test`)
- [ ] `src/index.ts` singleton export `slackConnectorPlugin`
- [ ] Vitest: send happy-path, idempotency cache key, `verifyConnection`
- [ ] `pnpm build:plugins` discovers it; select in Settings → Connectors

---

## Phase 2 — Discord, inbound, pairing, chat-everything routing

### Inbound entities

- [ ] `connector-identity.entity.ts` (Tier C) + repository
- [ ] `connector-pairing-code.entity.ts` (Tier C) + repository (hashed code)
- [ ] `connector-conversation.entity.ts` (Tier C) + repository
- [ ] `connector-message-log.entity.ts` (Tier C) + repository
- [ ] Register all four in `database.config.ts` `ENTITIES`
- [ ] Migration `<unix>-AddConnectorInboundTables.ts` (+ indexes/uniques)

### Inbound pipeline

- [ ] `ConnectorFacadeService.handleInbound` — verify → challenge → parse
- [ ] `POST /api/connectors/inbound/:connectorId` (`@Public`, `rawBody`, resolve-by-id, fail-closed 401)
- [ ] `ConnectorRoutingService` — dedupe, identity/pairing resolution, session resolve/create, dispatch to chat-everything engine, reply
- [ ] Untrusted-content fencing on inbound text (reuse `apps/mcp` fence/sanitize)
- [ ] Agent-permission clamp on inbound turns (run as paired user, routed Agent's `AgentPermissions`)

### Pairing + management

- [ ] `POST /:id/pairing-codes` (mint; hashed; ≤15-min TTL; single-use; throttled)
- [ ] Pairing redeem inside `ConnectorRoutingService` (bind identity, consume code, confirm)
- [ ] `GET /:id/identities`, `DELETE /:id/identities/:identityId`, `GET /:id/conversations`
- [ ] Web: inbound URL (copyable), default Agent/Team + routing-mode selector, pairing panel, identities + conversations tabs

### discord-connector

- [ ] Scaffold `packages/plugins/discord-connector/` (`@discordjs/rest`, `discord-interactions`)
- [ ] `everworks.plugin`: `id: 'discord-connector'`, `capabilities: ['connector', 'connector-discord']`
- [ ] `settingsSchema` — `botToken`/`applicationId`/`publicKey` (+ `x-secret`/`x-envVar`)
- [ ] Outbound `send` (`Routes.channelMessages`), inbound `verifyInbound` (`verifyKey` ed25519), `handleChallenge` (PING→PONG), `parseInbound`, `reply`
- [ ] Vitest: ed25519 verify (valid/invalid), PING challenge, parse

### slack-connector inbound

- [ ] `verifyInbound` (v0 HMAC + 5-min skew clamp + constant-time compare)
- [ ] `handleChallenge` (`url_verification`), `parseInbound` (`message`/`app_mention`), `reply` (threaded)

### Tests

- [ ] Signature verify: valid / invalid / replayed / skewed (per plugin)
- [ ] Pairing: mint / redeem / expiry / single-use / revoke
- [ ] Routing: unpaired→prompt, paired→agent reply, session isolation, inbound dedupe
- [ ] E2E: Discord Interactions round-trip + Slack Events round-trip → delivery log rows

---

## Phase 3 — WhatsApp / Notion / Microsoft 365 + catalog repo

- [ ] `whatsapp-connector` (Cloud API, `X-Hub-Signature-256`, template outbound + 24h window, metered pricing)
- [ ] `notion-connector` (`transport: 'poll'`, Trigger.dev scheduled `poll()`, `createRecord`, verification token)
- [ ] `microsoft-365-connector` (Graph subscriptions + `clientState` + renewal loop; mail / Teams / files)
- [ ] Discord Gateway `socket` transport (free-form messages) — worker + poll-vs-socket decision
- [ ] `ever-works/connectors` catalog repo — manifests + icons + setup guides + npm refs; wire plugin-catalog service (ADR-011 analog) + EW-693 dynamic distribution
- [ ] Per-provider operator setup docs

---

## Phase n — Continuous

- [ ] Additional providers (Telegram bidirectional, Linear, GitHub, CRM) as increments
- [ ] Team-based inbound routing (Org-scoped Agent group resolver)
- [ ] OAuth identity linking (replace typed pairing code)
- [ ] Multi-workspace resolution (resolve connector by payload `team_id`/`guild_id`)
