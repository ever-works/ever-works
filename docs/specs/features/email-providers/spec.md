# Feature Specification: Email Providers

**Feature ID**: `email-providers`
**Branch**: `feat/email-providers`
**Status**: `Draft (v1.1)`
**Jira Epic**: [EW-650](https://evertech.atlassian.net/browse/EW-650)
**Created**: 2026-05-26
**Last updated**: 2026-10-15
**Version**: v1.2 — added §14 email fixes for the Gauzy integration (EW-P4-3). v1.1 added §11 React-Email/composer UI, §12 agent-to-agent communication, §13 sibling-spec cross-references. v1 sections 0–10 unchanged except where §14 says so.
**Owner**: Product (Ruslan)
**Related code today**:

- AI provider plugin pattern: `packages/agent/src/facades/ai.facade.ts`, `packages/plugin/src/abstract/base-ai-provider.ts`
- Pluggable capability registry: `packages/agent/src/plugins/services/plugin-registry.service.ts`, `packages/plugin/src/contracts/capabilities/`
- Tenant settings + secrets pipeline: `apps/api/src/settings/`, `packages/agent/src/plugins/services/plugin-settings.service.ts`
- Agent entity (per-Agent committer email column): `packages/agent/src/entities/agent.entity.ts`
- Existing one-off transactional mail surface: `packages/agent/src/notifications/email/` (single hardcoded provider — Postmark in early phases, Resend later — not pluggable today)
- AGENT_GIT_FACADE binding (consumes `Agent.committerEmail`): `apps/api/src/agents/agents.module.ts`

> **Scope of this document:** product behavior — what users see and do, how Email addresses get registered at the tenant level, how an Agent gets bound to one or more inbound + outbound addresses, what the plugin contract looks like, and how it integrates with the agent-run path. Implementation details live in `plan.md` (TBW); architecture context references `agents-skills-tasks.md` (Email surface is additive to the same plugin registry).
>
> **Hard rule (additive only):** existing one-off mail surfaces (password-reset emails, mission notifications, etc.) keep working unchanged. The new Email Providers surface adds a tenant-managed inbox layer on top of that, plus per-Agent assignment.

---

## 0. Why this exists

Today the platform sends a handful of transactional emails (password resets, OAuth notifications, mission-failure alerts) through a single hardcoded provider. There is no concept of:

1. **Tenant-managed addresses.** An operator can't say "register `agents@example.com` as an outbound address" — the from-address is whatever the platform's default provider sends as.
2. **Inbound email.** Nothing in the platform receives email today. Replies bounce or get black-holed.
3. **Per-Agent email identity.** When an Agent commits to a Work's git repo, the commit author email is a placeholder (`<slug>@agents.ever.works`) because there's nowhere to put a real address. The FU-13 follow-up (this PR) added a `committerEmail` column on the Agent — that column wants a managed inbox to back it.
4. **Multi-provider redundancy.** The product wants choice + failover across Mailchimp, Mailgun, Postmark, Resend, Sendgrid (et al.). One hardcoded provider can't deliver that.

This spec defines the tenant-level Email Addresses surface, the plugin contract for sending + receiving, the Agent assignment model, and the agent-run integration that brings them all together.

---

## 1. Personas + use cases

| Persona  | Use case                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator | Registers `pm@acme.com` as an outbound address backed by Postmark; assigns it to the "Project Manager" Agent so its standups land in inboxes that look human. |
| Operator | Registers `support@acme.com` as an inbound address backed by Mailgun routes; assigns it to a "Support Triage" Agent so incoming emails become Tasks.          |
| Agent    | Sends a daily summary to a Task's watchers from its assigned outbound address. The commit author email on its git commits matches.                            |
| Agent    | Receives a reply on its inbound address, parses it as a chat message on the originating Task, posts back.                                                     |
| Operator | A provider has an outage. Drains traffic to a secondary provider on the same address without touching Agent configuration.                                    |

---

## 2. Surfaces — what the user sees

### 2.1 Tenant Settings → Email Addresses

A new sub-page under Settings → Integrations:

- **Outbound addresses** list. Each row: `address` · `provider` · `fromName?` · `verified?` · `defaultForReplies?` · per-row spend rollup · "Edit" / "Disable" / "Remove".
- **Inbound addresses** list. Same shape minus `fromName` + `defaultForReplies`; gains `routingRule` (regex over subject/from for routing into Mission/Idea/Work/Task scopes).
- **Add address** wizard:
    - Step 1: pick direction (Outbound / Inbound / Both).
    - Step 2: pick provider (filtered by capability — see §3.1).
    - Step 3: address + provider-specific settings (domain, sending-domain DNS check, webhook URL the operator must register at the provider, etc.).
    - Step 4: verification — outbound sends a confirmation email; inbound asks the user to send a test email to the address.
- **Bulk-import** from existing provider account (Postmark / Resend / Sendgrid API — list addresses already configured at the provider and offer to claim them).

### 2.2 Per-Agent assignment

Agent detail page → "Identity" section gains an "Email addresses" panel:

- **Outbound (1 default + N additional)**. Default is what `from:` resolves to for Agent-originated emails. Operator can pick a different default per Agent.
- **Inbound (0..N)**. Incoming mail on these addresses dispatches a Task / Chat message via the agent-run path (§4).

Both are searchable dropdowns over the tenant's registered addresses (analogous to FU-8's skill-binding picker).

### 2.3 Plugins page

The existing Plugins page (`/settings/plugins`) lists every plugin grouped by capability. Email providers join the grid under a new "Email Providers" group:

- Mailchimp Transactional (Mandrill)
- Mailgun
- Postmark
- Resend
- Sendgrid
- (any future provider plugin that declares the capability)

Each plugin is enabled / disabled / configured per-tenant the same way AI providers are today. Settings include API keys, sending domains, webhook secrets, default sender, etc.

---

## 3. Plugin contract

### 3.1 Capability declaration

Email Providers register against two new plugin capabilities:

- `PLUGIN_CAPABILITIES.EMAIL_OUTBOUND` — provider can send mail.
- `PLUGIN_CAPABILITIES.EMAIL_INBOUND` — provider exposes inbound webhooks / IMAP / API polling.

A provider may declare one or both. Mailchimp Transactional + Mailgun + Postmark + Sendgrid declare both; Resend currently declares outbound only.

Manifest `everworks.plugin` block:

```json
{
	"id": "postmark",
	"name": "Postmark",
	"category": "email-provider",
	"capabilities": ["email-outbound", "email-inbound"],
	"settings": {
		"apiKey": { "type": "string", "x-secret": true, "x-envVar": "POSTMARK_API_KEY" },
		"defaultSenderDomain": { "type": "string" },
		"inboundStreamId": { "type": "string", "optional": true }
	}
}
```

### 3.2 Interface — `IEmailOutboundPlugin`

```typescript
interface IEmailOutboundPlugin extends IPlugin {
	sendEmail(input: EmailSendInput, options: EmailOptions): Promise<EmailSendResult>;
	verifyAddress(address: string, options: EmailOptions): Promise<EmailVerification>;
	listDeliveryEvents(filter: EmailEventFilter, options: EmailOptions): AsyncGenerator<EmailDeliveryEvent>;
}

interface EmailSendInput {
	from: string; // canonical address (tenant-registered)
	fromName?: string;
	to: readonly string[];
	cc?: readonly string[];
	bcc?: readonly string[];
	subject: string;
	bodyText: string;
	bodyHtml?: string;
	replyTo?: string;
	attachments?: readonly EmailAttachment[];
	metadata?: Record<string, string>; // forwarded to provider tags
	/** Idempotency key for retries — required when called from agent-run path. */
	messageRef: string;
}

interface EmailSendResult {
	provider: string;
	providerMessageId: string;
	accepted: readonly string[]; // RFC 5321 mailbox addresses the provider accepted
	rejected: readonly { address: string; reason: string }[];
}
```

### 3.3 Interface — `IEmailInboundPlugin`

```typescript
interface IEmailInboundPlugin extends IPlugin {
	/**
	 * Server-side webhook handler exposed at `/api/email/inbound/:pluginId`.
	 * The platform decodes provider-specific webhook payloads (Mailgun
	 * signed forms, Postmark JSON, Sendgrid Event Webhook, etc.) into a
	 * canonical `EmailInboundMessage` shape.
	 */
	parseInboundWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<EmailInboundMessage>;
	/**
	 * Verify a webhook signature so a third party can't spoof inbound mail.
	 * MUST throw on signature mismatch.
	 */
	verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): void;
}

interface EmailInboundMessage {
	provider: string;
	providerMessageId: string;
	from: string;
	to: readonly string[];
	subject: string;
	bodyText: string;
	bodyHtml?: string;
	attachments?: readonly EmailAttachment[];
	receivedAt: Date;
	/** Provider-specific metadata (spam score, DKIM result, etc.) */
	metadata: Record<string, unknown>;
}
```

### 3.4 EmailFacade

A new `EmailFacadeService` in `packages/agent/src/facades/email.facade.ts` follows the existing facade pattern (mirrors `AiFacadeService`):

- Resolution priority: tenant address override → user default → first-enabled provider for the capability.
- Settings resolution via the existing 4-level hierarchy (Work → User → Admin → Plugin defaults).
- Per-call `EmailFacadeOptions` carries `userId`, `workId?`, `agentId?`, `taskId?` for attribution (same shape as `FacadeOptions`).
- Records a `PluginUsageEvent` per send with capability `EMAIL` so the per-Agent + per-Task spend rollups work without additional plumbing.

---

## 4. Data model

### 4.1 New tables

```
tenant_email_addresses
  id              uuid PK
  userId          uuid FK users               -- tenant-scoped for now (multi-tenant lands later)
  address         varchar(254) NOT NULL       -- RFC 5321 mailbox max
  direction       varchar(16) NOT NULL        -- 'outbound' | 'inbound' | 'both'
  pluginId        varchar(64) NOT NULL        -- 'postmark' | 'mailgun' | ...
  providerSettings jsonb NOT NULL             -- per-plugin shape: from-name, routing-tag, webhook secret, etc.
  verified        boolean DEFAULT false
  verificationToken varchar(64) NULL
  defaultForReplies boolean DEFAULT false
  disabledAt      timestamp NULL
  createdAt       timestamp
  updatedAt       timestamp
  UNIQUE(userId, address, direction)

agent_email_assignments
  id              uuid PK
  agentId         uuid FK agents ON DELETE CASCADE
  emailAddressId  uuid FK tenant_email_addresses ON DELETE CASCADE
  direction       varchar(16) NOT NULL        -- 'outbound' | 'inbound'
  priority        int NOT NULL DEFAULT 100    -- lower = higher precedence; default outbound = lowest priority among outbound assignments
  createdAt       timestamp
  UNIQUE(agentId, emailAddressId, direction)

email_messages
  id              uuid PK
  userId          uuid FK users
  agentId         uuid NULL FK agents          -- attribution (Phase 15.6 mirror)
  taskId          uuid NULL FK tasks
  emailAddressId  uuid FK tenant_email_addresses
  direction       varchar(16) NOT NULL        -- 'outbound' | 'inbound'
  providerMessageId varchar(200)
  from            varchar(254)
  toAddresses     jsonb
  subject         varchar(998)                 -- RFC 5322 line max
  bodyText        text
  bodyHtml        text NULL
  metadata        jsonb
  sentAt          timestamp NULL              -- outbound only
  receivedAt      timestamp NULL              -- inbound only
  deliveryStatus  varchar(16) NULL            -- 'accepted' | 'delivered' | 'bounced' | 'complained' | 'open' | 'click'
  createdAt       timestamp
  INDEX (userId, agentId, createdAt)
  INDEX (taskId, createdAt)
```

### 4.2 Reuses

- `PluginUsageEvent` gains no new columns — Email usage rows use the existing shape with `capability='email'`.
- Attachments reuse the existing `work_knowledge_upload` table (same path as Task attachments, FU-5).

---

## 5. Agent-run integration

### 5.1 Outbound

A new Agent tool `sendEmail` registers when:

- the Agent has at least one outbound `agent_email_assignments` row, AND
- `permissions.canCallExternalTools` is true (mirrors searchWeb/screenshot/extractContent gate)

The descriptor's `invoke(args)` routes through `EmailFacadeService.send` with the Agent's default outbound address (or a specific assigned address if the model passed `args.from`). Sent messages persist to `email_messages` with `agentId` set; the existing Activity log gets a new `EMAIL_SENT` action.

### 5.2 Inbound → Task

A new dispatcher contract `AGENT_INBOUND_EMAIL_DISPATCHER` (mirrors the existing `AGENT_CHAT_REPLY_DISPATCHER`) gets invoked when an inbound webhook lands.

**Destination = the address the webhook was verified for.** Before verifying, `EmailFacadeService.parseInbound` binds the webhook to the first recipient (from the plugin's `extractInboundRecipients`) that is a registered inbound address of the webhook's plugin, and verifies the signature with the secret at that address owner's scope. That is the owner's own secret when they saved one — it replaces the platform secret at their scope — or the admin/env secret otherwise. The dispatcher delivers to that address (`payload.recipient`) only, and refuses it unless it is still an active inbound address of that plugin and owner. It never re-derives a destination from the payload's `to` list: any tenant can sign a webhook with their own per-user key and list a victim's address beside their own. A webhook with no such recipient is acknowledged but not dispatched.

The default binding:

1. Resolves the destination Agent via `agent_email_assignments.direction='inbound'` on that address.
2. Resolves or creates a Task — either by parsing the subject for a Task slug (`[ACME-123]`) or by spawning a fresh Task with the email as its description.
3. Persists the inbound row to `email_messages`.
4. Enqueues `agent-task-execute` (existing Trigger.dev job) so the Agent processes the email like any other Task.

Spec gap: how do we attribute multi-recipient inbound mail (e.g. one email lands on `triage@` + `manager@`)? Default v1: the first recipient that is a registered address of the webhook's plugin (the one the signature is verified for), then its lowest-priority assignment; future work covers fan-out, which would need each extra address's owner secret verified too.

### 5.3 Per-Agent commit identity (FU-13 closing loop)

When the AGENT_GIT_FACADE binding looks up the Agent's `committerEmail`:

- if set to a tenant-registered outbound email → use as-is.
- if set to a free-form string → use as-is (operator opt-in to deliver to wherever they want).
- if null → synthesize `<slug>@agents.ever.works` (today's behaviour from FU-13).

The Email Addresses dropdown on the Agent identity panel offers the registered addresses as the canonical pick so operators don't have to memorize the column-vs-tenant-address distinction.

---

## 6. Providers — initial list

Each provider lands as its own plugin under `packages/plugins/<name>/`:

| Plugin                    | Capabilities       | Auth                                                       | Notes                                                         |
| ------------------------- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `mailchimp-transactional` | outbound + inbound | API key + webhook secret                                   | Inbound via Mandrill webhooks; outbound via Mandrill Send API |
| `mailgun`                 | outbound + inbound | API key + signing-key (webhook signature) + sending domain | Inbound via "Routes" → HTTP POST to our webhook               |
| `postmark`                | outbound + inbound | server token + inbound webhook secret                      | Inbound via Postmark Inbound Streams                          |
| `resend`                  | outbound only (v1) | API key                                                    | Resend's inbound is in private beta — add when GA             |
| `sendgrid`                | outbound + inbound | API key + Event Webhook signing                            | Inbound Parse Webhook                                         |

Plus a fallback `local-smtp` plugin for dev / self-host that wraps `nodemailer` with no inbound (no public webhook).

### 6.1 Why a separate plugin per provider

- Auth + webhook signature mechanics differ enough that a single "generic SMTP" abstraction would either be lowest-common-denominator (no event tracking) or full of branches.
- Tenant-level enable/disable + per-tenant API keys is the existing plugin-system idiom; no new infrastructure.
- Failover across providers is then a list-of-plugins-in-priority-order at the Email Address level, not a custom config.

---

## 7. Webhook surface

`apps/api/src/email/email.controller.ts` (new):

```
POST /api/email/inbound/:pluginId
POST /api/email/events/:pluginId       -- provider delivery events (bounces, opens, etc.)
GET  /api/email/verify/:tokenId        -- tenant address verification click-through
```

Each `POST` route dispatches to the plugin's `verifyWebhookSignature` + `parseInboundWebhook` / `parseEventWebhook`. Auth: webhook secret stored per plugin instance, and **required** — with no secret configured the webhook is refused too (§14.1); rejection on signature mismatch returns 401 with a generic body (`Invalid webhook signature`) — don't leak which secrets are wrong: the plugin's own reason is only logged (`EmailFacadeService.verifyWebhookSignature`). A plugin that cannot load answers 503, so the provider retries; the webhook is never accepted unverified.

Rate-limited per plugin id (default 600/min — reduces blast radius if a provider mis-routes traffic).

---

## 8. Out of scope (v1)

- **Reply-by-email threading.** Inbound messages create or join Tasks via subject parsing; SMTP-level threading (`In-Reply-To` headers) lands in v2. _(Landed: §14.2, EW-P4-3.)_
- **Templates.** Send paths in v1 use plain text + HTML body inlined by the caller. Template management (Mailchimp templates, Postmark templates, etc.) lands in v2.
- **Calendar / contacts.** Out of scope for this spec — see future `calendar-providers` spec.
- **Multi-tenant routing.** Today addresses are scoped per `userId`. Multi-tenant work groups land later — see the platform's multi-tenancy track.
- **Encryption / S/MIME / PGP.** Plain SMTP / API submission only in v1.

---

## 9. Acceptance criteria

- [ ] Operator can register an outbound address backed by Postmark and send a verification email that lands in their inbox within 60s.
- [ ] Operator can register an inbound address backed by Mailgun and confirm a test email round-trips into an `email_messages` row within 5s of arrival.
- [ ] Operator can assign an outbound address to an Agent; the Agent's git commits surface that address as the committer email.
- [ ] Operator can switch the provider behind an outbound address without changing the Agent's configuration (failover validated).
- [ ] An Agent with the `sendEmail` tool descriptor invokes it from a task run and the resulting `PluginUsageEvent` carries `agentId` + `taskId` for the spend rollup.
- [ ] An inbound message dispatches a Task and the originating Agent picks it up via the existing `agent-task-execute` job.
- [ ] All five v1 providers (Mailchimp, Mailgun, Postmark, Resend, Sendgrid) declare the EMAIL_OUTBOUND capability; four of them declare EMAIL_INBOUND (Resend deferred).

---

## 10. Related future tracks

- **Calendar providers** (separate spec) — same plugin pattern, different verbs (`createEvent`, `listEvents`).
- **Voice / SMS providers** (separate spec) — same pattern, Twilio + MessageBird + Plivo + Vonage.
- **Multi-tenant ownership** — `tenant_email_addresses` is single-tenant per `userId` in v1; promote to organization-owned when the multi-tenancy track lands.

---

## 11. React-Email + composer UI integration (v1.1 — additive)

> **Why this section was added:** the v1 spec defined the data model + plugin contract but left the rendering surface vague. Operators want a rich composer for one-off agent emails, and outbound templates should be authored as React components so designers can iterate without Handlebars. This section is additive — Handlebars templates from the existing `mail-providers/` surface keep working unchanged; React-Email is an _additional_ template medium that the `EmailFacadeService` can render.

### 11.1 React-Email components (server-side render)

The platform adopts [`@react-email/components`](https://react.email/docs/components/html) and [`@react-email/render`](https://react.email/docs/utilities/render) for outbound email composition. Both packages live in **`apps/api`** so rendering happens on the server before handoff to the provider plugin's `sendEmail`.

- Templates live under `apps/api/src/email/templates/react/<slug>.tsx` (TSX). Each exports a default React component that accepts a typed `Props` object.
- The `EmailFacadeService.send` accepts an optional `template: { kind: 'react', slug: string, props: T }` argument. When provided, the facade calls `render(<Template {...props} />, { pretty: false })` to produce the HTML body and `render(<Template {...props} />, { plainText: true })` for the text fallback. The provider plugin still receives `bodyHtml` + `bodyText` in the canonical `EmailSendInput` shape — providers never see React.
- Existing Handlebars templates under `apps/api/src/templates/*.hbs` continue to work via `mail-providers`. The two systems coexist; choice is per-call.

### 11.2 Composer UI (web app)

A new in-app composer lives under [`agent-inbox-ui`](../agent-inbox-ui/spec.md) and is referenced here for completeness:

- Rich-text + Markdown editor (operator-facing, _not_ React-Email TSX). On submit, the composed content lands in `email_messages.bodyText` + `bodyHtml`.
- Template picker: drops in any registered React-Email template, pre-fills the form with the template's `Props` shape (via a Zod schema each template co-locates).
- Live preview pane: `iframe srcDoc={render(<Template {...props} />)}` renders the React-Email output as the operator types.

### 11.3 Novu in-app inbox widget (optional)

For tenants that opt in via the `novu` plugin (see [`notification-channels`](../notification-channels/spec.md)), the web app can mount [`@novu/react`](https://docs.novu.co/inbox/react/get-started) as an alternative in-app notification surface alongside the platform's native notifications panel. The native panel from `notifications` v1 remains the default; Novu is **additional**, not a replacement.

---

## 12. Agent-to-agent communication via email (v1.1 — additive)

> **Why this section was added:** v1 framed inbound email as "external mail → Task". v1.1 elevates email to a **first-class peer of Tasks** as a communication medium _between agents_. Tasks remain the canonical work unit; email becomes a parallel addressable channel for inter-agent (and human↔agent) conversation.

### 12.1 Conceptual model

Each Agent with at least one inbound assignment exposes a stable mailbox address. Any sender — another Agent, a human user, or an external system — can reach the agent at that address. The receiving Agent's run loop processes inbound mail with the same scheduling primitives as Task execution.

| Sender                | Receiver | Mechanism                                                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent A → Agent B     | Agent B  | `sendEmail` tool call with `to: ["<agent-b-slug>@inbound.acme.com"]`. Webhook fan-in → Agent B's inbound dispatcher |
| Human → Agent         | Agent    | Standard SMTP send to the agent's address; provider webhook → inbound dispatcher                                    |
| External AI → Agent   | Agent    | Same as human — agent inbox is just an SMTP address                                                                 |
| Agent → Human (reply) | Human    | `sendEmail` from the agent's outbound assignment; threading via `In-Reply-To` (v2)                                  |

### 12.2 Dispatch semantics

The inbound dispatcher gains two modes (set per `agent_email_assignments` row):

- **`task-spawn` (v1 default).** Each inbound message creates or joins a Task. Existing behavior from §5.2.
- **`conversation` (v1.1 new).** Inbound messages append to a per-Agent **EmailConversation** thread (keyed by `(agentId, threadKey)` where `threadKey` is derived from `In-Reply-To` or message subject). The agent's chat-reply path processes the message the same way it processes chat messages — no new Task is created. Use this when the goal is ongoing dialogue, not a discrete unit of work.

The mode is a property of the **assignment**, not the address — one address can serve multiple agents in different modes (rare but supported).

### 12.3 Data model deltas

```
email_conversations
  id              uuid PK
  agentId         uuid FK agents ON DELETE CASCADE
  threadKey       varchar(200)               -- derived from In-Reply-To header or normalized subject
  participants    jsonb                      -- [{address, displayName?}, …]
  lastMessageAt   timestamp
  createdAt       timestamp
  UNIQUE(agentId, threadKey)
```

`email_messages` gains a nullable FK `conversationId` (NULL when the message is bound to a Task instead). One of `taskId` / `conversationId` is always set; the other is NULL.

### 12.4 New `messageAgent` tool descriptor

In addition to `sendEmail` (raw outbound, §5.1), Agents with `canCallExternalTools=true` get a higher-level `messageAgent` tool:

```typescript
interface MessageAgentInput {
	targetAgentId: string; // resolved via agent registry
	subject: string;
	body: string; // plain text; React-Email template optional
	attachReferences?: { workId?: string; taskId?: string; missionId?: string }[];
}
```

The descriptor resolves the target agent's _primary inbound address_ and calls `EmailFacadeService.send` with appropriate routing metadata so the receiving end auto-routes into `conversation` mode. This gives agents a clean "send a message to peer agent" verb without making them assemble RFC 5321 addresses by hand.

### 12.5 Why not just use Tasks for inter-agent messaging?

- Tasks are units of _work_ (have lifecycle: created → in-progress → done → archived). A conversational ping ("FYI, the deploy finished") doesn't fit that shape.
- Email is the universal cross-system addressing scheme. Agents reachable by email are reachable by humans, by external AI agents, by webhooks, and by other Ever Works tenants — all without bespoke integration code.
- The Agent's existing chat-reply path is the right execution model for conversational input; the `conversation` mode reuses it without inventing a new dispatcher.

---

## 13. Cross-references to sibling specs (v1.1)

The notifications/communications track is now decomposed into four sibling specs. This spec (`email-providers`) owns email-specific concerns; the siblings pick up adjacent surfaces:

| Spec                                                        | Owns                                                                                                               | Jira Epic |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| `email-providers` (this doc)                                | Tenant email addresses, per-Agent assignment, Email plugin contract, EmailFacadeService, React-Email templates     | EW-650    |
| [`notification-channels`](../notification-channels/spec.md) | Multi-channel notification plugin contract (Discord/Slack/Telegram/WhatsApp/Novu), channel router, fanout/failover | TBD       |
| [`event-subscriptions`](../event-subscriptions/spec.md)     | Per-user per-event delivery preferences extending `notifications` v1 (mute, quiet hours, channel selection)        | TBD       |
| [`agent-inbox-ui`](../agent-inbox-ui/spec.md)               | Per-agent inbox views, composer with React-Email preview, address-management wizard                                | TBD       |

All four share the same constitution gates and the same plugin-registry foundation. The dependency graph is:

```
agent-inbox-ui ──▶ email-providers ──┐
                                      ├─▶ event-subscriptions ──▶ notifications v1
notification-channels ────────────────┘
```

`email-providers` and `notification-channels` are independent (can ship in either order). `event-subscriptions` is the user-facing aggregator and depends on at least one channel surface (in-app via v1, plus any of email/Discord/Slack/etc.).

---

## 14. Email fixes for the Gauzy integration (EW-P4-3 — additive)

**Added**: 2026-10-15. **Plan item**: EW-P4-3 in the Gauzy ↔ Ever Works integration plan (`ever-co/homelab` →
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/07-ever-works-implementation-plan.md`, Phase 4). The
Gauzy Inbox's agent-mail bridge (plan doc 04 §6) needs these, and each also stands on its own. Shipped as separate small
PRs, security first; status per item in [tasks.md](./tasks.md) Phase 10.

### 14.1 Inbound webhooks are refused when no secret is configured

Before: the shipped `postmark` and `mailgun` plugins **accepted an unsigned inbound webhook** when no secret was
configured at the resolved scope (Postmark logged a warning, Mailgun returned silently). The inbound routes are public, so
anyone who knew `POST /api/email/inbound/<pluginId>` could inject mail into a tenant's scope.

Now **verification is mandatory**:

| Secret at the resolved scope (owner → admin → env) | Request                    | Result                                                  |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------- |
| configured                                         | correctly signed           | accepted (`202`)                                        |
| configured                                         | unsigned / wrong signature | `401 Invalid webhook signature`                         |
| **none**                                           | anything                   | **`401 Invalid webhook signature`** (was: accepted)     |
| none, and `EMAIL_INBOUND_ALLOW_UNSIGNED=true`      | anything                   | accepted, with a loud `console.warn` (operator opt-out) |

- Postmark secret: `inboundWebhookSecret` setting / `POSTMARK_INBOUND_SECRET` (HTTP Basic `postmark:<secret>`).
  Mailgun key: `webhookSigningKey` setting / `MAILGUN_WEBHOOK_SIGNING_KEY` (HMAC-SHA256 over `timestamp + token`).
- The same rule covers the delivery-event route (`POST /api/email/events/<pluginId>`), which verifies with the same
  plugin method at admin/env scope.
- **Opt-out** `EMAIL_INBOUND_ALLOW_UNSIGNED`: only the exact string `true` enables it (a typo, `1`, `TRUE` or an empty
  value stays secure). It is meant for a local stack with no public webhook URL and is never set on a deployed
  environment. It never weakens a configured secret: with a secret set, a missing or wrong signature is still refused.
- The plugin's own reason (`... refusing an unsigned webhook ...`) is logged; the caller only ever sees the generic 401
  (§7), so the response does not reveal whether a secret exists.
- Rollout check (2026-10-15): no deployed environment had an inbound address or an inbound message, so the change broke no
  working path. An operator who adds an inbound address must also configure the provider secret.

### 14.2 RFC threading (`Message-ID`, `In-Reply-To`, `References`)

Before: threading keyed only on the normalized subject (conversation mode); in task-spawn mode **every** inbound message
created a new Task; outbound mail carried no threading headers, so replies did not thread in the recipient's client; and
the Task an inbound message spawned was never written back onto the message.

Now:

- **Columns** on `email_messages` (migration `1795061520000-AddEmailMessageThreadingHeaders`, portable DDL for Postgres,
  MySQL and better-sqlite3): `messageIdHeader varchar(255)`, `inReplyTo varchar(255)`, `references text` (simple-json
  list), all nullable; index `(userId, messageIdHeader)`. Ids are stored **bare** (no angle brackets) via
  `normalizeMessageId` / `parseMessageIdList` in `@ever-works/plugin`; an id over 255 characters is not stored (never
  truncated); `References` keeps the newest 50 ids.
- **Contract** (`@ever-works/plugin`): `EmailSendInput.headers` (extra RFC 5322 header fields, forwarded verbatim —
  Postmark `Headers`, Mailgun `h:<Name>`, Resend / SendGrid / Mandrill `headers`); `EmailInboundMessage.messageIdHeader`,
  `inReplyTo`, `references` (parsed by the Postmark and Mailgun plugins from the original headers).
- **Outbound** (`EmailFacadeService.send`): every send carries a `Message-ID` (`<uuid@sending-domain>`, unless the
  caller set one) and the caller's `In-Reply-To` / `References`; all three are recorded on the row (direct send,
  reservation, or released draft). Header names that are not RFC 5322 field names and values with CR/LF are dropped
  before the plugin sees them (no header injection).
- **Reply in thread**: `POST /api/email/messages` and the Agent `sendEmail` tool accept `inReplyToMessageId` (an
  `email_messages.id` of the caller's own; another account's answers 404). The send gets `In-Reply-To` = that message's
  id and `References` = its chain + its id (RFC 5322 §3.6.4), and inherits its `taskId`. A held draft keeps
  `inReplyTo` / `references` on its row and the release rebuilds the headers.
- **Inbound** (`DefaultInboundEmailDispatcher`): the ids of `In-Reply-To`, then `References` newest-first (never the
  message's own id, at most 20) are matched against the **same owner's and the same Agent's** messages — the headers
  are sender-written, so they can only ever select among that Agent's own mail.
    - `conversation` mode: a match joins the matched message's conversation; else the normalized subject (as before).
    - `task-spawn` mode: a match whose message is linked to a Task is handed to the spawner's optional
      `appendInboundEmailToTask`; the platform binding posts it on that Task's chat (as the address owner, mentioning only
      the receiving Agent so it picks the reply up; the email text is defused — `@` mentions and `[[…]]` links made
      inert, forged closing delimiters neutralized, capped well under the 16 KiB chat limit). If there is no match, the
      adapter cannot append, or appending fails (e.g. the secret scanner rejects the body), a new Task is spawned exactly
      as before — a reply is never lost.
    - After a Task is spawned or joined, the message is linked to it (`email_messages.taskId`, only when still empty).
    - A spawned Task's description ends with the inbound message id and how to reply in thread.

### 14.3 Inbound data: attachments, Cc, metadata, tenant / organization

Before: the inbound webhook handed the dispatcher only from / to / subject / bodies, so **attachments, Cc and the
provider metadata (spam score, headers) were dropped**, and the row written from the public webhook (no request scope)
got NULL tenant / organization.

Now:

- **Contract**: `EmailInboundMessage.cc` (bare mailboxes; Postmark `CcFull` / `Cc`, Mailgun `Cc`). Recorded, never
  routed on — like `to`.
- **Attachments** (`email_messages.attachments`, simple-json; migration `1795061530000-AddEmailMessageAttachments`,
  portable DDL): each inbound attachment is stored through the optional `INBOUND_EMAIL_ATTACHMENT_STORE`, which the
  platform binds to the **same upload pipeline as a user's own uploads** (`UploadsService.saveFile`: MIME allow-list
  checked against magic bytes, size cap, content-hash storage key — the sender's filename never reaches storage),
  owned by the receiving address's owner and recorded in the address's tenant / organization (`user_uploads`). Every
  attachment is listed on the row (`filename`, `mimeType`, `size`, `cid`, `stored`, `uploadId`, `url`, `reason`): one
  the pipeline refused, one over the per-message limits (20 attachments, 25 MB decoded), an empty one, or any when no
  store is bound, is listed with `stored: false` and why. A refused attachment never blocks the message. The list
  itself is bounded for the column (a MySQL `TEXT` holds 65,535 bytes): at most 50 records and 48,000 serialized UTF-8
  bytes; whatever does not fit is summed in one trailing record (`N more attachments`, total size, how many stored).
- **Request size**: the inbound-email webhooks (`/api/email/inbound/*`) get their own body-parser limit, mounted ahead of
  the global 1 MB one (`BODY_LIMIT`, unchanged for every other route): **25 MB** by default — the `proxy-body-size` the
  ingress already allows on every environment — overridable with `INBOUND_EMAIL_BODY_LIMIT` up to a 50 MB ceiling
  (invalid or larger values fall back to the default). Base64 adds a third, so roughly 18 MB of attachments fit in one
  message by default; raising the limit means raising the ingress's `proxy-body-size` too.
- **Cc and metadata**: `ccAddresses` (at most 100) and `metadata` are kept. Metadata is bounded to 32,000 serialized UTF-8 bytes
  (first the raw header list is dropped, marked `headersOmitted`; then only the keys are kept, marked `truncated`).
- **Tenant / organization**: the inbound row — and a conversation it creates — is stamped with the **receiving
  address's** `tenantId` / `organizationId` (explicit values, so the scope-stamping subscriber's empty request scope
  never applies). A Task spawned from it is created in the scope of its assignee, **the receiving Agent** (an
  address may be bound to an Agent of another scope, e.g. the owner's personal Agent on an organization address, and the
  Agent must stay reachable from the Task; an Agent that cannot be resolved keeps the old unscoped create), and its description lists the attachments (names and types defused like the rest of the
  email text) with their upload ids.

### 14.4 Add-address wizard and real verification

Before: Settings → Integrations → Email addresses was a list with an `alert('Add-address wizard: implementation in
follow-up tick')` button and an inert "Edit"; addresses could only be registered through the API. Verification was
cosmetic: `POST /api/email/addresses/:id/verify` asked the provider plugin for a token and **threw it away** — no email
went out — and `verified` was **never checked** for sending.

Now:

- **Wizard** (`AddEmailAddressWizard`, §2.1 steps): (1) direction — send / receive / both; (2) provider, filtered by
  capability (only Postmark and Mailgun receive); (3) address, sender name, "default for replies", and for inbound the
  webhook URL to register at the provider (on the API's public origin) with how that provider's secret is configured
  (§14.1); (4) for sending addresses, "Send confirmation email". Each row gets **Send confirmation** (unverified
  sending addresses), **Disable / Enable** and **Remove** (with a confirmation that names what is lost; disabling keeps
  the history).
- **Verification is real**: `POST /api/email/addresses/:id/verify` rotates a fresh one-time token (24 h) and sends the
  address a confirmation email through **platform mail** (`MailService.sendNotificationEmail`), linking to the public
  web page `/email-address/verify/<token>`. That page confirms only on a **click** (a server action calling the public
  `GET /api/email/verify/:token`), so a mail scanner that prefetches the link confirms nothing; it is in
  `PUBLIC_ROUTES`, since the link is usually opened from the mailbox without a session.
    - Already verified → nothing sent (`alreadyVerified: true`). Disabled → 400. A second email within 60 s → 429
      (the address is the caller's to type; the route is also throttled to 5/min per caller). The send is recorded in
      `tenant_email_addresses.verificationSentAt` (migration `1795061550000-AddTenantEmailAddressVerificationSentAt`)
      and claimed with a compare-and-set, so concurrent clicks send one email; the token `createAddress` mints is never
      mailed and never starts the cooldown. No platform mail, or a mailer that would only log (`MAILER_PROVIDER`
      unset/`none`, Resend without a key) → 503, never a silent "sent". The email is sent `strict`: a provider refusal
      (Resend answers errors without throwing) → 503 and the cooldown is given back. The provider plugin's own
      `verifyAddress` still runs, best-effort.
    - Response (additive): `{ messageRef, sent, alreadyVerified?, expiresAt? }`.
- **`verified` is enforced for sending**: `EmailService.sendMessage` refuses an unverified sending address up front
  (before a draft is held) and `EmailFacadeService.send` refuses it as the backstop every outbound path converges on —
  `403`, `EmailSenderNotVerifiedException`, naming the address and how to confirm it — before the send gate or any
  provider. Sends with no tenant address (system mail through the first enabled provider) are unaffected; receiving
  never requires verification. Operator switch: `EMAIL_SENDER_VERIFICATION_REQUIRED=false` (exact string) turns the
  check off for a self-hosted install with no platform mail to deliver the confirmation; on by default.
- **Grandfathering** (no-breakage): migration `1795061540000-GrandfatherInUseEmailAddressesVerified` marks every
  address **already in use** as verified — assigned to an Agent, already sent mail, or pinned by an Agent inbox — so
  working setups keep sending. Unused, unverified addresses (2 on dev, 0 on stage at rollout) verify through the
  confirmation email before their first send. `down()` is a no-op by design (a grandfathered row is indistinguishable
  from a later real verification).
