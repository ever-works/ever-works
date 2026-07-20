# Connectors — First-Party Communication-Channel Plugins — Product Spec

**Status:** Draft v1 · **Owner:** Product (Ruslan) · **Date:** 2026-07-18
**Audience:** Product, Engineering (backend + plugin + AI + frontend), Design
**Internal codename:** "Connector fabric"
**Related code today:**

- Plugin contracts + manifest: [`packages/plugin/src/contracts/plugin-manifest.types.ts`](../../../../packages/plugin/src/contracts/plugin-manifest.types.ts) (`PLUGIN_CATEGORIES`, `PluginManifest`), [`packages/plugin/src/contracts/facade-capabilities.ts`](../../../../packages/plugin/src/contracts/facade-capabilities.ts) (`PLUGIN_CAPABILITIES`)
- Plugin settings + secret extensions: `packages/plugin/src/settings/json-schema.types.ts` (`x-secret`, `x-envVar`, `x-scope`), `packages/plugin/src/settings/settings.types.ts` (`ConfigurationMode`)
- Plugin base classes: `packages/plugin/src/abstract/` (`BasePlugin`, `BaseAiProvider`, …)
- Plugin discovery/registry: `packages/agent/src/plugins/services/plugin-loader.service.ts` (`DEFAULT_PLUGIN_PATHS`), `plugin-registry.service.ts` (`getByCapability`)
- Notification-channel contract (outbound comms today): [`packages/plugin/src/contracts/capabilities/notification-channel.interface.ts`](../../../../packages/plugin/src/contracts/capabilities/notification-channel.interface.ts) (`INotificationChannelPlugin`, `ChannelSendInput`, `ChannelSendResult`)
- Reference channel plugins: [`packages/plugins/slack-channel/src/slack-channel-plugin.ts`](../../../../packages/plugins/slack-channel/src/slack-channel-plugin.ts), [`packages/plugins/discord-channel/src/discord-channel-plugin.ts`](../../../../packages/plugins/discord-channel/src/discord-channel-plugin.ts)
- Notification facade + entity + API: [`packages/agent/src/facades/notification-channel.facade.ts`](../../../../packages/agent/src/facades/notification-channel.facade.ts), `packages/agent/src/entities/notification-channel.entity.ts`, [`apps/api/src/notification-channels/notification-channels.controller.ts`](../../../../apps/api/src/notification-channels/notification-channels.controller.ts)
- Inbound-routing precedent (email → Agent): `packages/agent/src/entities/agent-email-assignment.entity.ts` (`dispatchMode`), `packages/agent/src/entities/email-conversation.entity.ts` (per-Agent thread + Tier C scope columns)
- Third-party aggregators (contrast set): `packages/plugins/composio/`, `apps/api/src/plugins/composio-triggers/composio-triggers.controller.ts` (inbound webhook + SDK signature verify), `packages/plugins/{make,sim-ai,zapier,activepieces}/`
- SSRF guard helpers: `packages/plugin/src/helpers/ssrf-guard.ts` (`isSafeWebhookUrl`, `safeFetchWithDnsPin`)
- Scope-column conventions: EW-651 / EW-657 (Tier A / Tier C), see `docs/specs/features/tenants-and-organizations/spec.md` §2.3
- Chat engine: `docs/specs/features/chat-everything/spec.md`; untrusted-content fencing: `apps/mcp/src/api-client/{fence-untrusted.ts,sanitize.ts}`

> **Scope of this document:** define a NEW first-party **connector** plugin category — bidirectional communication-channel plugins that both send outbound (messages / records) AND accept inbound control (a message arrives → routes to an Agent/Team → replies). This is distinct from the existing outbound-only notification channels and from the third-party aggregators (Composio / Make / SIM / Zapier / Activepieces). The phased execution plan lives in the sibling [plan.md](plan.md); the task checklist in [tasks.md](tasks.md).
>
> **Hard rule (additive by default):** this feature **EXTENDS** the plugin system and the comms surface; it removes/renames nothing internal. The existing `*-channel` notification plugins, `INotificationChannelPlugin`, the `notification_channels` table + `NotificationChannelFacadeService`, the Composio/Make/SIM/Zapier/Activepieces aggregators, and `apps/mcp` all keep working unchanged. Every new column is nullable on insert; every new table is additive; every new capability string is added to the existing arrays without touching the old ones. A connector plugin is a **superset** of an outbound channel — a channel is not deprecated by it.

---

## 0. TL;DR

A **connector** is a first-party plugin that owns both directions of one external surface (Slack, Discord, WhatsApp, Notion, Microsoft 365). Outbound reuses the proven notification-channel `send` mechanics. Inbound is new: a verified webhook (or poll) turns an external message into a normalized event, a **pairing code** authorizes the first contact from an external identity, and each external conversation becomes an isolated chat session (`user:channel:conversation`) that the **chat-everything** engine drives against a routed Agent/Team, replying back through the same connector.

```
                        ┌───────────────────────────── Ever Works ─────────────────────────────┐
 OUTBOUND (send)        │                                                                        │
 Agent / event  ───────►│ ConnectorFacadeService.send() ─► IConnectorPlugin.send() ──────────────┼─► Slack / Discord / …
                        │        (Trigger.dev delivery task, idempotent on messageRef)           │
                        │                                                                        │
 INBOUND (control)      │ POST /api/connectors/inbound/:connectorId          (@Public, fail-closed)│
 Slack / Discord ──────►│   │ verifyInbound(signature)  ── invalid ─► 401                          │
  message               │   │ handleChallenge()         ── Slack url_verification / Discord PING   │
                        │   │ parseInbound() ─► ConnectorInboundEvent                              │
                        │   ▼                                                                      │
                        │ ConnectorRoutingService                                                  │
                        │   ├─ identity paired?  ── no ─► reply "send pairing code XXXX to link"    │
                        │   └─ yes ─► session (user:channel:conversation) ─► chat-everything engine ┼─► Agent/Team
                        │                                                    (Agent permission clamp)│   reply()
                        └────────────────────────────────────────────────────────────────────────┘

 Contrast: *-channel plugins = outbound-only notifications · Composio/Make/SIM = third-party aggregators (pipeline)
```

Continuous effort: the durable platform is the **category + `IConnectorPlugin` contract + routing/pairing/session machinery**. Individual providers land one at a time — Slack outbound (P1), Discord + inbound/pairing (P2), WhatsApp / Notion / Microsoft 365 + the `ever-works/connectors` catalog repo (P3), and onward.

---

## 1. Concepts

### 1.1 The plugin system today (what we build on)

Every plugin is a standalone ESM package under `packages/plugins/*` (or `@ever-works/*` in `node_modules`). Metadata is declared **twice and must agree**: the `everworks.plugin` block in `package.json` (read at boot by the filesystem scanner) and the runtime class props (`id`, `name`, `category`, `capabilities`, `settingsSchema`). Discovery is presence-on-disk + valid manifest — `plugin-loader.service.ts` scans `DEFAULT_PLUGIN_PATHS`; there is no autoload array. Plugins are validated, registered, and looked up by capability via `PluginRegistryService.getByCapability`.

- **Categories** — `PLUGIN_CATEGORIES` (`plugin-manifest.types.ts`): `git-provider`, `deployment`, `screenshot`, `search`, `content-extractor`, `data-source`, `ai-provider`, `pipeline`, `form`, `integration`, `utility`, `theme`, `storage`, `email-provider`, **`notification-channel`**, `vector-store`, `dns`, `secret-store-resolver`, `job-runtime`. **This spec adds `connector`.**
- **Capabilities** — `PLUGIN_CAPABILITIES` (`facade-capabilities.ts`) is the finer-grained selector superset (includes `NOTIFICATION_CHANNEL[_SLACK|_DISCORD|_TELEGRAM|_WHATSAPP|_NOVU]`, `EMAIL_OUTBOUND/INBOUND`, `OAUTH`, …). **This spec adds `CONNECTOR` + per-provider constants.**
- **Base classes** — `packages/plugin/src/abstract/` (`BasePlugin` gives `onLoad/onUnload/healthCheck`, `context`, `getSettings`, `emitEvent`). Most capability interfaces are implemented directly. **This spec adds `BaseConnectorPlugin`.**
- **Settings + secrets** — JSON-schema (JSONSchema7) + `PluginSchemaExtensions`: `x-secret` (encrypted, never returned, password input), `x-envVar` (env fallback for self-host), `x-scope` (`global|tenant|user|work`), `x-widget`, `x-adminOnly`, `x-hidden`, `x-showIf`. `ConfigurationMode` = `admin-only | user-required | hybrid`.
- **Distribution (EW-693)** — `distribution: 'core' | 'registry'`; `registry` plugins install on first enable via `plugin-installer.service.ts` + `lazy-plugin-proxy.ts`.

### 1.2 The comms surface today (what a connector supersedes for its outbound leg)

- **Notification channels (outbound only).** `INotificationChannelPlugin` (`notification-channel.interface.ts`): `shape: 'broadcast'|'direct'|'workflow'`, `verifyTarget()`, `send(ChannelSendInput)` (MUST be idempotent on `messageRef`), optional `listDeliveryEvents`, `getPricing`. Live plugins: `slack-channel` (`@slack/webhook`, incoming-webhook broadcast), `discord-channel` (webhook), `telegram-channel`, `whatsapp-channel`, `novu-channel`, plus the built-in `in-app` sentinel. Per-tenant creds live in `notification_channels.targetConfig` (`@EncryptedJsonColumn`); non-secret defaults live in the plugin `settingsSchema`. Delivery runs through the Trigger.dev `notification-channel-delivery` task (retries + quiet-hours `deferUntil`), owner-scoped (IDOR-guarded), with secret redaction on errors. API: `apps/api/src/notification-channels/notification-channels.controller.ts` — CRUD + `POST /:id/test` + a **currently ack-only** `POST /events/:pluginId` (no signature verification yet; see §7.2).
- **Inbound → Agent precedent (email).** The email surface already does inbound routing: `agent_email_assignments` (`direction: 'inbound'`, `dispatchMode: 'task-spawn' | 'conversation'`, `priority`) binds an Agent to an inbound address, and `email_conversations` (`agentId`, `threadKey`, `participants`, Tier C `tenantId`/`organizationId`) holds a per-Agent thread. Connectors generalize this pattern from email to chat surfaces.
- **Third-party aggregators (a different thing).** Composio (500+ apps, per-user brokered OAuth) is category `pipeline` + `form-schema-provider` + `skills-provider`; its inbound side is `composio_trigger_subscriptions` + a `@Public` webhook that resolves the subscription by `tg_*` id then verifies via the vendor SDK (`triggers.verifyWebhook`) — the canonical fail-closed pattern we mirror. Make / SIM AI / Zapier / Activepieces are also `pipeline`. **Aggregators broker other people's integrations; connectors are our own first-party two-way surfaces.** Both stay.
- **MCP server (`apps/mcp`).** A thin proxy that _exposes_ Ever Works to external MCP clients — not a plugin host, orthogonal to connectors.

### 1.3 What a connector is

A **connector** is a first-party plugin declaring category `connector` that implements `IConnectorPlugin` — a **bidirectional** contract:

- **Outbound.** `send()` a message (reuses the `ChannelSendInput`/`ChannelSendResult` DTO shapes) and, optionally, `createRecord()` a structured object (a Notion page, a CRM row).
- **Inbound.** `verifyInbound()` a signed HTTP delivery (fail-closed), `handleChallenge()` provider handshakes, `parseInbound()` into normalized `ConnectorInboundEvent`s, or `poll()` for transports without webhooks; then `reply()` into the originating conversation.
- **Authorization.** First inbound contact from an external identity requires a **pairing code** before any Agent is reachable.
- **Isolation.** Each external conversation is a distinct chat session keyed `user:channel:conversation`.

A connector with only the outbound leg (P1 Slack) is a strict superset of an outbound channel; the inbound leg (P2+) is what makes it a connector rather than a channel.

### 1.4 Connector vs channel vs aggregator (one table)

| Dimension       | `*-channel` (notification)   | `connector` (this spec)            | aggregator (Composio/Make/…)     |
| --------------- | ---------------------------- | ---------------------------------- | -------------------------------- |
| Category        | `notification-channel`       | `connector`                        | `pipeline`                       |
| Direction       | Outbound only                | **Bidirectional**                  | Broker (varies)                  |
| Ownership       | First-party                  | **First-party**                    | Third-party broker               |
| Inbound → Agent | No                           | **Yes (paired, session-isolated)** | Trigger → fanout (no chat reply) |
| Contract        | `INotificationChannelPlugin` | **`IConnectorPlugin`**             | `IPipelinePlugin` (+form/skills) |
| Status          | Ships today, unchanged       | New                                | Ships today, unchanged           |

---

## 2. Data model

Follows EW-651 / EW-657 scope-column conventions. **Tier A** rows (top-level business objects owned by a user/org) carry `tenantId` + `organizationId`; **Tier C** children denormalize the same two columns with **no `@ManyToOne` on the scope FKs** (cycle-avoidance rule from `user.entity.ts` EW-654). All scope columns are nullable UUIDs (legacy/pre-Tenant rows stay `NULL`). Per repo rule, **every entity change ships a TypeORM migration in the same PR** (`apps/api/src/migrations/<unix>-*.ts`).

### 2.1 `connectors` (Tier A) — `packages/agent/src/entities/connector.entity.ts`

The per-user connection instance. Mirrors `notification_channels` but bidirectional.

```
connectors
  id               uuid PK
  userId           uuid FK users
  pluginId         varchar(64)  NOT NULL     -- 'slack-connector' | 'discord-connector' | …
  name             varchar(120) NOT NULL     -- user-friendly label
  direction        varchar(16)  NOT NULL     -- 'outbound' | 'inbound' | 'bidirectional'
  targetConfig     text         NOT NULL     -- @EncryptedJsonColumn: bot token, signing secret, workspace/app id, defaultChannelId, …
  verified         boolean      DEFAULT false
  routingMode      varchar(16)  DEFAULT 'agent'   -- 'agent' | 'team' | 'chat' (how inbound is dispatched, §4)
  defaultAgentId   uuid NULL FK agents           -- inbound target when routingMode='agent'
  defaultTeamId    uuid NULL                      -- inbound target when routingMode='team' (Org-scoped agent group; §8)
  disabledAt       timestamp NULL
  tenantId         uuid NULL                      -- Tier A scope
  organizationId   uuid NULL                      -- Tier A scope
  createdAt        timestamp
  updatedAt        timestamp
  UNIQUE(userId, pluginId, name)
```

- `targetConfig` is envelope-encrypted (same `@EncryptedJsonColumn` treatment as `notification_channels.targetConfig`) and never returned by the API (redacted). The connector's `settingsSchema` is the JSON-schema for this blob — it drives the Add-Connector wizard, `x-secret` masking, `x-envVar` self-host fallback, and server-side validation.
- `defaultAgentId` uses `onDelete: 'SET NULL'` so archiving an Agent disables inbound routing rather than cascading.

### 2.2 `connector_identities` (Tier C) — `connector-identity.entity.ts`

A pairing binding: one external identity ↔ one platform user, per connector.

```
connector_identities
  id                 uuid PK
  connectorId        uuid FK connectors ON DELETE CASCADE
  externalUserId     varchar(200) NOT NULL     -- Slack 'U…' / Discord author id / WhatsApp wa_id
  externalUserHandle varchar(200) NULL
  platformUserId     uuid NOT NULL FK users    -- who this external identity acts as
  pairingState       varchar(16) NOT NULL      -- 'pending' | 'paired' | 'revoked'
  pairedAt           timestamp NULL
  tenantId           uuid NULL
  organizationId     uuid NULL
  createdAt          timestamp
  UNIQUE(connectorId, externalUserId)
  INDEX(connectorId, pairingState)
```

### 2.3 `connector_pairing_codes` (Tier C) — `connector-pairing-code.entity.ts`

Short-lived, single-use codes minted in the Web UI and redeemed from the external channel.

```
connector_pairing_codes
  id            uuid PK
  connectorId   uuid FK connectors ON DELETE CASCADE
  codeHash      varchar(128) NOT NULL     -- HMAC/scrypt hash; never store the plaintext code
  platformUserId uuid NOT NULL FK users   -- the user the code will bind the external identity to
  expiresAt     timestamp NOT NULL        -- ≤ 15 min after mint
  consumedAt    timestamp NULL
  tenantId      uuid NULL
  organizationId uuid NULL
  createdAt     timestamp
  INDEX(connectorId, expiresAt)
```

### 2.4 `connector_conversations` (Tier C) — `connector-conversation.entity.ts`

Per-external-conversation session — the isolation unit. Mirrors `email_conversations`.

```
connector_conversations
  id                     uuid PK
  connectorId            uuid FK connectors ON DELETE CASCADE
  externalConversationId varchar(200) NOT NULL   -- Slack 'channel[:thread_ts]' / Discord channel id / wa_id
  sessionKey             varchar(320) NOT NULL    -- composite: '{platformUserId}:{connectorId}:{externalConversationId}'
  identityId             uuid NULL FK connector_identities
  agentId                uuid NULL FK agents      -- resolved responder for this session
  conversationId         uuid NULL FK conversations  -- link to the chat-everything Conversation that backs the session
  lastMessageAt          timestamp NULL
  tenantId               uuid NULL
  organizationId         uuid NULL
  createdAt              timestamp
  updatedAt              timestamp
  UNIQUE(connectorId, externalConversationId)
  INDEX(sessionKey)
```

### 2.5 `connector_message_log` (Tier C) — `connector-message-log.entity.ts`

Unified inbound + outbound audit / idempotency ledger (one table, `direction`-discriminated — keeps us from sprawling into two).

```
connector_message_log
  id                     uuid PK
  connectorId            uuid FK connectors ON DELETE CASCADE
  direction              varchar(8)  NOT NULL      -- 'inbound' | 'outbound'
  dedupeKey              varchar(200) NOT NULL      -- inbound: providerEventId; outbound: messageRef
  externalConversationId varchar(200) NULL
  externalUserId         varchar(200) NULL
  agentId                uuid NULL
  status                 varchar(16) NOT NULL       -- inbound: 'accepted'|'rejected'|'unpaired'|'routed'|'failed'
                                                    -- outbound: 'delivered'|'failed'|'queued'
  providerMessageId      varchar(200) NULL
  errorMessage           text NULL                  -- redacted + length-capped (mirror notification facade)
  attemptCount           int NOT NULL DEFAULT 1
  tenantId               uuid NULL
  organizationId         uuid NULL
  createdAt              timestamp
  INDEX(connectorId, direction, createdAt)
  UNIQUE(connectorId, direction, dedupeKey)          -- inbound dedupe + outbound idempotency
```

### 2.6 Reuses (no new tables)

- `PluginUsageEvent` — connector sends/receives emit rows (new `PluginUsageCapability.CONNECTOR`), for spend/volume roll-ups.
- Trigger.dev — outbound reuses a `connector-delivery` task (same retry/backoff shape as `notification-channel-delivery`); poll-mode inbound uses a scheduled Trigger task.
- `conversations` / `conversation_messages` — the chat-everything Conversation that a `connector_conversations` row links to (no schema change; `connector_conversations.conversationId` FK).

---

## 3. API surface

New controller `apps/api/src/connectors/connectors.controller.ts`, namespace `/api/connectors` (mirrors `notification-channels` shape, guards, `ParseUUIDPipe`, throttles, DTO whitelist + `targetConfig` byte cap).

**Owner-scoped CRUD + verify + test (auth required):**

```
GET    /api/connectors                       -- list my connectors (targetConfig redacted)
POST   /api/connectors                        -- create { pluginId, name, targetConfig, direction, routingMode?, defaultAgentId? }
PATCH  /api/connectors/:id                     -- partial update
DELETE /api/connectors/:id                     -- remove
POST   /api/connectors/:id/verify              -- verifyConnection (outbound creds + inbound reachability)
POST   /api/connectors/:id/test                -- send a test outbound message
```

**Pairing + identities + sessions (auth required):**

```
POST   /api/connectors/:id/pairing-codes       -- mint a code { code, expiresAt }  (throttled; code returned once)
GET    /api/connectors/:id/identities          -- list paired external identities
DELETE /api/connectors/:id/identities/:identityId  -- revoke a pairing
GET    /api/connectors/:id/conversations       -- list active conversation sessions
```

**Inbound webhook (`@Public`, resolves connector by path id, fail-closed):**

```
POST   /api/connectors/inbound/:connectorId    -- provider delivery; verifyInbound → 401 on bad signature;
                                                  handleChallenge for handshakes; else parse + route (202)
```

- The inbound route is `@Public` (providers carry no Ever Works auth token) and resolves the connector by the path `:connectorId`, then verifies the signature against that connector's stored secret — exactly the composio-triggers pattern (`findByComposioTriggerId` → `verifyWebhook`, fail-closed when no secret). Operators paste the generated per-connector URL into the provider's app config.
- Raw body is required for signature verification (register the route for `rawBody` capture like `composio-triggers`).
- Poll-mode connectors (Notion) have **no** HTTP route; a Trigger.dev scheduled task calls `poll()` per enabled connector.

---

## 4. Chat-everything relationship (inbound routing)

Inbound is where connectors meet the **chat-everything** engine (the initiative that makes the platform AI chat run every UI/API op, auth-scoped, confirm-destructive, canvas-rendering). A verified inbound message becomes a chat turn on a non-web transport:

1. `ConnectorFacadeService.handleInbound(connectorId, rawReq)` → `verifyInbound()` (fail-closed) → `handleChallenge()` (short-circuit handshakes) → `parseInbound()` → `ConnectorInboundEvent[]`.
2. `ConnectorRoutingService` (`packages/agent/src/connectors/connector-routing.service.ts`) for each event:
    - Dedupe on `providerEventId` (`connector_message_log` unique).
    - Resolve `connector_identities` by `(connectorId, externalUserId)`.
        - **Unpaired** → treat the message text as a possible pairing code (§6). If it matches a live `connector_pairing_codes` row, bind the identity and `reply()` a confirmation. Otherwise `reply()` the pairing prompt and log `status='unpaired'`. **No Agent is reached.**
        - **Paired** → resolve/create the `connector_conversations` session by composite key `{platformUserId}:{connectorId}:{externalConversationId}`, linking (or creating) a `conversations` row.
    - Dispatch by `routingMode`:
        - `agent` → the connector's `defaultAgentId`.
        - `team` → a Team resolver picks an Agent from the Org-scoped group (`defaultTeamId`); v1 falls back to a single default (§8 open question).
        - `chat` → a general chat session with no bound Agent (tool access clamped to the paired user's own scope).
3. The chat-everything engine runs the turn **as the paired platform user**, under the routed **Agent's `AgentPermissions`** (`canCallExternalTools`, confirm-destructive, no-bulk) — inbound never elevates. The engine's reply text (and any canvas/tool summaries flattened to text) is returned via `IConnectorPlugin.reply()` into the same external conversation/thread.
4. Outbound-only usage is unchanged: an Agent tool or an event-subscription fan-out calls `ConnectorFacadeService.send()`; the connector's outbound leg is also selectable in the [`event-subscriptions`](../event-subscriptions/spec.md) preference matrix via the bridge in §5.

**Untrusted content.** Inbound message text is data, never instructions to the platform. It is fenced the same way `apps/mcp` fences tool output (`fence-untrusted.ts` / `sanitize.ts`) before it reaches the engine, and the engine's destructive-action confirmation still applies.

---

## 5. Connectors ↔ NotificationChannel — reuse vs new

A deliberate split so we neither fork the outbound path nor overload the notifications contract:

- **REUSE (do not re-invent):** the outbound DTOs `ChannelSendInput` / `ChannelSendResult` / `ChannelRichPayload`; the SSRF guards (`isSafeWebhookUrl`, `safeFetchWithDnsPin`); the `@EncryptedJsonColumn` `targetConfig` pattern; the Trigger.dev delivery task shape (retries, quiet-hours `deferUntil`); the owner-scoped IDOR lookups; the error redaction + length cap; the `PluginUsageEvent` roll-up.
- **NEW:** the `connector` category + `CONNECTOR*` capabilities; the `IConnectorPlugin` superset interface + `BaseConnectorPlugin`; the five `connector*` tables; `ConnectorFacadeService` + `ConnectorRoutingService`; pairing; per-conversation sessions; the inbound verify/parse/reply machinery.
- **BRIDGE (additive, opt-in):** a connector whose metadata sets `capabilities.outboundMessage` exposes its outbound leg to the existing notifications fan-out **without duplicating config**. Concretely, `NotificationChannelFacadeService.send` gains an optional resolver that can target a `connectors` row (by `pluginId` + `targetConfig`) as if it were a channel, so the [`event-subscriptions`](../event-subscriptions/spec.md) matrix lists connectors alongside `*-channel` plugins. No auto-created `notification_channels` row; the bridge is a resolver, not a data copy. The existing `slack-channel` (incoming-webhook) and `slack-connector` (bot-token, bidirectional) coexist — a user may run either or both.

---

## 6. Pairing (first-inbound authorization)

The problem: anyone in a shared Slack workspace or Discord guild could message the bot. Pairing ensures inbound only ever acts for an Ever Works user who proved control of the external identity.

- **Mint.** In Settings → Connectors → a connector → "Pair a channel", the operator mints a code: `POST /api/connectors/:id/pairing-codes` returns a plaintext code once; the server stores only `codeHash`, `expiresAt` (≤ 15 min), and the `platformUserId` to bind.
- **Redeem.** The operator (or an invited teammate) sends the code as a message/DM to the bot from the external channel. The inbound handler, seeing an **unpaired** identity, checks the text against live codes for that connector; on match it writes a `connector_identities` row (`pairingState='paired'`, `platformUserId` from the code), marks the code `consumedAt`, and replies a confirmation.
- **Thereafter.** Messages from that external identity route to the Agent/Team per §4. Operators see and can revoke identities (`DELETE /identities/:identityId`).
- **Hardening:** codes are single-use, hashed at rest, high-entropy (≥ 10^8 space), expiry-bounded; mint and redeem attempts are rate-limited; a revoked identity must re-pair.

Pairing is a P2 concern (ships with inbound). A future enhancement is provider-OAuth identity linking (Slack/Discord OAuth) instead of a typed code (§8).

---

## 7. Plugin points

### 7.1 New category + capabilities

- `PLUGIN_CATEGORIES` (`plugin-manifest.types.ts`) gains `'connector'`.
- `PLUGIN_CAPABILITIES` (`facade-capabilities.ts`) gains the umbrella + per-provider constants:

```ts
CONNECTOR: 'connector',
CONNECTOR_SLACK: 'connector-slack',
CONNECTOR_DISCORD: 'connector-discord',
CONNECTOR_WHATSAPP: 'connector-whatsapp',
CONNECTOR_NOTION: 'connector-notion',
CONNECTOR_MICROSOFT_365: 'connector-microsoft-365'
```

Per the notification-channel convention, every connector declares `CONNECTOR` (umbrella, for discovery/grouping) plus its `CONNECTOR_<provider>` constant.

### 7.2 `IConnectorPlugin` contract — `packages/plugin/src/contracts/capabilities/connector.interface.ts`

```ts
import type { IPlugin } from '../plugin.interface.js';
import type { PluginPricing } from '../pricing.types.js';
import type {
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification
} from './notification-channel.interface.js';

/** How inbound events arrive for a connector. */
export type ConnectorInboundTransport = 'webhook' | 'poll' | 'socket';

/** Static capability flags a connector advertises (drives UI + routing). */
export interface ConnectorCapabilityFlags {
	readonly outboundMessage: boolean; // can send a chat/message (reuses ChannelSendInput)
	readonly outboundRecord: boolean; // can createRecord() (Notion page, CRM row)
	readonly inbound: boolean; // can receive + route inbound
	readonly reply: boolean; // can reply into an inbound conversation/thread
	readonly pairing: boolean; // first inbound contact needs a pairing code
	readonly richOutbound: boolean; // supports ChannelRichPayload
}

export interface ConnectorMetadata {
	readonly direction: 'outbound' | 'inbound' | 'bidirectional';
	readonly transport: ConnectorInboundTransport;
	readonly flags: ConnectorCapabilityFlags;
}

/** A raw inbound HTTP delivery handed to verify/parse. */
export interface ConnectorInboundRequest {
	readonly rawBody: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
}

export interface ConnectorInboundVerification {
	readonly valid: boolean;
	readonly reason?: string;
}

/** Provider handshake (Slack url_verification, Discord PING) short-circuit. */
export interface ConnectorChallengeResponse {
	readonly status: number;
	readonly body: unknown;
}

/** Normalized inbound event (provider-agnostic). */
export interface ConnectorInboundEvent {
	readonly kind: 'message' | 'command' | 'reaction' | 'record-changed' | 'membership';
	readonly externalConversationId: string; // Slack 'channel[:thread_ts]', Discord channel id, wa_id
	readonly externalUserId: string;
	readonly externalUserHandle?: string;
	readonly text: string;
	readonly providerEventId: string; // idempotency key for inbound dedupe
	readonly receivedAt: Date;
	readonly rich?: unknown;
	readonly raw?: Readonly<Record<string, unknown>>;
}

/** Threaded reply back into an inbound conversation. */
export interface ConnectorReply {
	readonly externalConversationId: string;
	readonly text: string;
	readonly rich?: ChannelSendInput['rich'];
	readonly inReplyToProviderEventId?: string;
}

/** Structured record write (Notion/CRM). */
export interface ConnectorRecordInput {
	readonly collection: string; // Notion database id / CRM object type
	readonly fields: Readonly<Record<string, unknown>>;
	readonly idempotencyKey: string;
}
export interface ConnectorRecordResult {
	readonly provider: string;
	readonly recordId: string;
}

/** Poll-mode pull for transports without webhooks. */
export interface ConnectorPollResult {
	readonly events: readonly ConnectorInboundEvent[];
	readonly cursor: string | null;
}

export interface IConnectorPlugin extends IPlugin {
	readonly connector: ConnectorMetadata;

	// --- OUTBOUND ---
	verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification>;
	send(message: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult>; // idempotent on messageRef
	createRecord?(record: ConnectorRecordInput, options: ConnectorCallOptions): Promise<ConnectorRecordResult>;

	// --- INBOUND (omit for outbound-only connectors) ---
	verifyInbound?(req: ConnectorInboundRequest, options: ConnectorCallOptions): Promise<ConnectorInboundVerification>;
	handleChallenge?(req: ConnectorInboundRequest): ConnectorChallengeResponse | null;
	parseInbound?(
		req: ConnectorInboundRequest,
		options: ConnectorCallOptions
	): Promise<readonly ConnectorInboundEvent[]>;
	poll?(cursor: string | null, options: ConnectorCallOptions): Promise<ConnectorPollResult>;
	reply?(reply: ConnectorReply, options: ConnectorCallOptions): Promise<ChannelSendResult>;

	getPricing?(): PluginPricing | Promise<PluginPricing>;
}

/** Per-call attribution + facade-resolved settings (mirrors ChannelOptions). */
export interface ConnectorCallOptions {
	readonly userId?: string;
	readonly connectorId?: string;
	readonly agentId?: string;
	readonly target?: ChannelTargetConfig; // resolved from connectors.targetConfig by the facade
	readonly settings?: Readonly<Record<string, unknown>>;
}

export function isConnectorPlugin(plugin: IPlugin): plugin is IConnectorPlugin {
	return plugin.capabilities.includes('connector');
}
```

- **Auth/secret declaration** lives in the plugin `settingsSchema` (JSON-schema for `targetConfig`): credential fields marked `x-secret` (+ `x-envVar` for self-host); the facade resolves and injects `options.target` so the plugin never touches the DB.
- **Idempotency** is the plugin's responsibility on both legs (outbound on `messageRef`, inbound on `providerEventId`), scoped to `connectorId` + conversation (mirrors the slack/discord channel cache-key hardening — key on `connectorId\0externalConversationId\0key`, never on the bare ref).

### 7.3 `BaseConnectorPlugin` — `packages/plugin/src/abstract/base-connector.ts`

Optional base offering: a per-`connectorId` idempotency cache with the NUL-separated composite key, SSRF-guarded fetch wrappers, an HMAC/ed25519 signature-verify toolkit (constant-time compare + timestamp-skew clamp), and default no-op `onLoad/onUnload`. Providers may implement `IConnectorPlugin` directly (like the channel plugins do) if they prefer.

### 7.4 `ConnectorFacadeService` + `ConnectorRoutingService`

- `packages/agent/src/facades/connector.facade.ts` — parallels `NotificationChannelFacadeService`: `send`/`reply` (via the Trigger.dev `connector-delivery` task; in-process fallback when unbound), `verifyConnection`, and `handleInbound` (verify → challenge → parse). Owner-scoped, secret-redacting, usage-emitting.
- `packages/agent/src/connectors/connector-routing.service.ts` — pairing resolution, session resolve/create, dispatch to the chat-everything engine (§4). Kept out of the facade so the facade has no hard dep on the chat engine (same decoupling as the notification facade's `resolveChannelIds` callback).

### 7.5 First batch — providers to scaffold under `packages/plugins/*`

New packages are named `<provider>-connector` to sit **beside** (not replace) the existing `<provider>-channel` notification plugins. P1–P2 scaffolds **`slack-connector`** and **`discord-connector`**; **`whatsapp-connector`**, **`notion-connector`**, **`microsoft-365-connector`** follow in P3.

#### 7.5.1 `slack-connector` (`packages/plugins/slack-connector/`)

- **Package.** `name: '@ever-works/slack-connector-plugin'`, `type: 'module'`, deps `@ever-works/plugin` (`workspace:*`) + `@slack/web-api` (bot-token `chat.postMessage`, the vendor SDK — distinct from `slack-channel`'s `@slack/webhook`). `everworks.plugin`: `{ id: 'slack-connector', category: 'connector', capabilities: ['connector', 'connector-slack'], distribution: 'registry' }`.
- **Metadata.** `connector: { direction: 'bidirectional', transport: 'webhook', flags: { outboundMessage: true, outboundRecord: false, inbound: true, reply: true, pairing: true, richOutbound: true } }`.
- **`settingsSchema` (⇒ `targetConfig` shape).**

```ts
{
	type: 'object',
	required: ['botToken', 'signingSecret'],
	properties: {
		botToken: { type: 'string', 'x-secret': true, 'x-envVar': 'SLACK_BOT_TOKEN' }, // xoxb-…
		signingSecret: { type: 'string', 'x-secret': true, 'x-envVar': 'SLACK_SIGNING_SECRET' },
		appId: { type: 'string' },
		defaultChannelId: { type: 'string' } // optional broadcast target for outbound test
	}
}
```

- **Outbound `send`.** `new WebClient(botToken).chat.postMessage({ channel, text, blocks })`; `blocks` from a `slack-blocks` rich payload. Idempotent on `messageRef` (cache key `connectorId\0channel\0messageRef`). Host is fixed by the SDK (no SSRF surface).
- **Inbound (Events API).** `verifyInbound`: recompute Slack's `v0` HMAC-SHA256 over `v0:{x-slack-request-timestamp}:{rawBody}` with `signingSecret`; reject timestamp skew > 5 min; constant-time compare against `x-slack-signature` (fail-closed). `handleChallenge`: `type: 'url_verification'` → `{ status: 200, body: { challenge } }`. `parseInbound`: `event.type ∈ {message, app_mention}` → `ConnectorInboundEvent { externalConversationId: channel(+':'+thread_ts), externalUserId: event.user, text: event.text, providerEventId: envelope.event_id }`.
- **Reply.** `chat.postMessage({ channel, thread_ts, text })` into the originating thread.
- **Inbound → Agent.** Routing service pairs by `(connectorId, event.user)`, sessions by `{platformUserId}:{connectorId}:{channel:thread_ts}`, dispatches to `defaultAgentId` (§4).

#### 7.5.2 `discord-connector` (`packages/plugins/discord-connector/`)

- **Package.** `name: '@ever-works/discord-connector-plugin'`, deps `@ever-works/plugin` + `@discordjs/rest` (`Routes.channelMessages` outbound) + `discord-interactions` (`verifyKey` ed25519 inbound). `everworks.plugin`: `{ id: 'discord-connector', category: 'connector', capabilities: ['connector', 'connector-discord'], distribution: 'registry' }`. (Distinct from `discord-channel`'s webhook mode.)
- **Metadata.** `connector: { direction: 'bidirectional', transport: 'webhook', flags: { …, inbound: true, reply: true, pairing: true } }`. (Free-form message events beyond slash-commands require the Gateway — a `socket` transport deferred to P3+, §8.)
- **`settingsSchema` (⇒ `targetConfig`).**

```ts
{
	type: 'object',
	required: ['botToken', 'publicKey', 'applicationId'],
	properties: {
		botToken: { type: 'string', 'x-secret': true, 'x-envVar': 'DISCORD_BOT_TOKEN' }, // 'Bot …'
		publicKey: { type: 'string' }, // ed25519 app public key (for inbound verify; not a secret)
		applicationId: { type: 'string' },
		defaultChannelId: { type: 'string' }
	}
}
```

- **Outbound `send`.** `new REST().setToken(botToken).post(Routes.channelMessages(channelId), { body: { content, embeds } })`; `embeds` from a `discord-embeds` rich payload. Idempotent on `messageRef`. Host fixed to `discord.com` by the SDK.
- **Inbound (Interactions endpoint).** `verifyInbound`: `verifyKey(rawBody, headers['x-signature-ed25519'], headers['x-signature-timestamp'], publicKey)` (fail-closed). `handleChallenge`: interaction `type === 1` (PING) → `{ status: 200, body: { type: 1 } }` (PONG). `parseInbound`: `type === 2` (APPLICATION_COMMAND) / message-component → `ConnectorInboundEvent`.
- **Reply.** `POST Routes.channelMessages(channelId)` (or the interaction callback/follow-up) into the originating channel.

#### 7.5.3 Next (P3) — noted, not scaffolded yet

- **`whatsapp-connector`** — WhatsApp Cloud API; inbound verified via `X-Hub-Signature-256`; outbound is template-only within the 24-hour window (metered `getPricing`). Supersedes `whatsapp-channel`'s outbound leg via the §5 bridge.
- **`notion-connector`** — `transport: 'poll'` (Trigger.dev scheduled `poll()`); `outboundRecord` via `createRecord` (pages / database rows); inbound verified via Notion's verification token.
- **`microsoft-365-connector`** — Microsoft Graph; mail / Teams messages / files; inbound via Graph change-notification subscriptions with `clientState` verification.

### 7.6 `ever-works/connectors` catalog repo (future)

A Git-rooted catalog repo — the connector analog of [`ever-works/agents`](https://github.com/ever-works/agents) (per ADR-011), `ever-works/orgs`, and `ever-works/works`. It holds, per provider: the connector manifest, icon, setup guide (how to create the Slack app / Discord bot / WhatsApp number), default settings, capability declaration, and the npm package name of the published plugin. The plugin catalog service reads it the way agent templates are read today, so **new connectors can be published without a platform redeploy** — dovetailing with EW-693 dynamic plugin distribution (registry npm + GitHub Packages; enable → lazy install-on-use). Lands in P3 alongside the first externally-published connectors.

---

## 8. Security

- **Secret hygiene.** Bot tokens, signing secrets, WhatsApp app secrets are `x-secret` in the connector `settingsSchema`, stored in `connectors.targetConfig` via `@EncryptedJsonColumn`, never returned by the API (redacted), with `x-envVar` fallbacks for self-host. Discord `publicKey` is non-secret but required for inbound verify.
- **Inbound verification is mandatory + fail-closed.** Every inbound delivery is signature-verified before parsing: Slack `v0` HMAC + 5-min timestamp skew clamp + constant-time compare; Discord ed25519 `verifyKey`; WhatsApp `X-Hub-Signature-256`; Notion verification token; M365 `clientState`. This **closes the gap** the current `POST /api/notification-channels/events/:pluginId` explicitly documents as unverified/ack-only (`notification-channels.controller.ts` lines 173-187) — connectors do the verification that TODO defers, per-plugin via `verifyInbound`. The `@Public` inbound route resolves the connector by path id, then fails closed if the connector has no stored secret (composio pattern).
- **Pairing gate.** First inbound from an unknown external identity never reaches an Agent (§6). Codes are single-use, hashed at rest, high-entropy, ≤ 15-min TTL; mint + redeem are rate-limited.
- **Session isolation.** The composite `user:channel:conversation` key means no context bleed across conversations, users, or connectors — a Slack thread, a Slack DM, and a Discord channel are three separate sessions even for the same paired user.
- **Least privilege on inbound.** Inbound turns run **as the paired platform user** and are clamped by the routed **Agent's `AgentPermissions`** (auth-scoped, confirm-destructive, no-bulk). Inbound can never do more than that Agent could in the web app.
- **Untrusted content.** Inbound message text is data, not instructions; it is fenced (`apps/mcp` `fence-untrusted` / `sanitize` pattern) before reaching the chat-everything engine, whose destructive-action confirmation still applies.
- **IDOR.** All connector CRUD, pairing, identity, and conversation reads are owner-scoped (`findByIdForUser`), returning an indistinguishable "not found" for missing vs not-owned, mirroring the notification facade.
- **SSRF.** Outbound uses vendor SDKs pinned to provider hosts; any user-supplied URL (Notion/CRM/custom) passes `isSafeWebhookUrl` + `safeFetchWithDnsPin`.
- **Idempotency / replay.** Inbound dedupe on `providerEventId` and outbound dedupe on `messageRef` (both `UNIQUE(connectorId, direction, dedupeKey)`) stop double-dispatch on provider redelivery and double-post on retry.
- **Rate limits.** Inbound webhook, pairing mint, and pairing redeem are throttled (`@Throttle`, matching the notification-channel controller's posture).

---

## 9. Naming

- **Category:** `connector` (singular, matches the tuple style of `notification-channel`).
- **Capabilities:** umbrella `connector`; per-provider `connector-<provider>` (kebab).
- **Packages:** `packages/plugins/<provider>-connector/` → npm `@ever-works/<provider>-connector-plugin`. Class `<Provider>ConnectorPlugin`; singleton export `<provider>ConnectorPlugin` from `src/index.ts` (mirrors `slackChannelPlugin`).
- **Entities/tables:** `connectors`, `connector_identities`, `connector_pairing_codes`, `connector_conversations`, `connector_message_log`. Files kebab-case: `connector.entity.ts`, `connector-identity.entity.ts`, `connector-pairing-code.entity.ts`, `connector-conversation.entity.ts`, `connector-message-log.entity.ts`.
- **Facade / services:** `ConnectorFacadeService`, `ConnectorRoutingService`. **API:** `/api/connectors`.
- **Disambiguation:** `*-connector` = first-party bidirectional (this spec); `*-channel` = first-party outbound-only notification (unchanged); `composio` / `make` / `sim-ai` / `zapier` / `activepieces` = third-party aggregators (`pipeline`, unchanged). All three families coexist.

---

## 10. Phasing (a continuous effort)

Framed as an ongoing program, not a one-shot. The durable platform is the category + contract + routing/pairing/session machinery; providers land continuously.

- **P1 — Connector category + contract + Slack outbound.** Add `connector` category + `CONNECTOR*` capabilities; ship `IConnectorPlugin` + `BaseConnectorPlugin`; `connectors` entity + migration; `ConnectorFacadeService` (outbound `send`/`verifyConnection` only); `/api/connectors` CRUD + `/verify` + `/test`; Settings → Connectors list + add wizard; **`slack-connector`** outbound (`chat.postMessage`). Bridge the outbound leg into the event-subscriptions matrix (§5).
- **P2 — Discord + inbound + pairing.** Add `connector_identities` / `connector_pairing_codes` / `connector_conversations` / `connector_message_log` + migration; inbound webhook route + `verifyInbound` / `handleChallenge` / `parseInbound` / `reply`; `ConnectorRoutingService` → chat-everything engine; pairing mint + redeem + identity management UI; per-conversation sessions; **`discord-connector`** (Interactions ed25519 inbound + REST outbound) and **Slack Events API inbound** on `slack-connector`.
- **P3 — WhatsApp / Notion / Microsoft 365 + catalog repo.** `whatsapp-connector` (Cloud API, template outbound, `X-Hub` verify); `notion-connector` (`poll` transport + `createRecord`); `microsoft-365-connector` (Graph subscriptions); Discord Gateway `socket` transport for free-form messages; the **`ever-works/connectors`** catalog repo (§7.6) + dynamic-distribution wiring.
- **Pn — Continuous.** Each additional provider (Telegram bidirectional, Linear, GitHub, CRM connectors) is an increment against the stable contract; Team-based routing, OAuth identity linking, and multi-workspace resolution (§11) fold in as demand appears.

---

## 11. Open questions

1. **Team routing.** Does inbound route to a single Agent (`defaultAgentId`) or to a Team (Org-scoped Agent group, `defaultTeamId`) that selects a responder by skills/round-robin? Depends on the final shape of Teams (task #5). v1 routes to a single default; Team resolution is P2.5+.
2. **Multi-workspace per connector.** One connector per Slack workspace / Discord guild (v1), or one connector serving many (resolve by `team_id` / `guild_id` in the payload)? v1 = one-per-workspace; payload-resolution later.
3. **Pairing UX.** Typed code (v1) vs provider-OAuth identity linking (Slack/Discord "Sign in with…"). OAuth is cleaner but heavier; deferred.
4. **Record connectors vs message connectors.** Same `connectors` table + `IConnectorPlugin` with `createRecord` as an optional flag (current design), or a separate surface for pure data connectors (Notion/CRM)? Current decision: one table, one interface, capability-flagged.
5. **Persistent transports.** Discord Gateway and M365 change-notifications need a long-lived worker / renewal loop — Trigger.dev scheduled poll vs a dedicated socket service. Open on operational model.
6. **Connector ↔ notification-channel auto-registration.** v1 bridges via a resolver (no data copy). Should enabling a connector optionally auto-create a linked `notification_channels` row for operators who only think in "channels"? Deferred; the bridge covers the functional need.

---

## 12. Cross-references

- Implementation plan: [plan.md](plan.md) · Task checklist: [tasks.md](tasks.md)
- Sibling comms specs: [`notification-channels`](../notification-channels/spec.md), [`email-providers`](../email-providers/spec.md), [`event-subscriptions`](../event-subscriptions/spec.md)
- Chat engine: [`chat-everything`](../chat-everything/spec.md)
- Scope conventions: [`tenants-and-organizations`](../tenants-and-organizations/spec.md) §2.3
- Aggregator contrast: [`integrations-twenty-crm`](../integrations-twenty-crm/spec.md), Composio triggers (`apps/api/src/plugins/composio-triggers/`)
- Catalog-repo precedent: [`ever-works/agents`](https://github.com/ever-works/agents) (ADR-011), dynamic distribution (`docs/specs/features/dynamic-plugin-distribution/spec.md`)
