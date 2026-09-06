# AW-12 — Chat, group conversations and the organization channel · Implementation plan

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-12-chat-channels`
**Spec:** [spec.md](./spec.md) · **Tasks:** [tasks.md](./tasks.md)
**Status:** `Draft` · **Last updated:** 2026-09-06
**Repo:** `ever-works/ever-works` (pnpm + Turborepo monorepo)

> Every path in this document was verified to exist before it was cited. Paths marked **(new)** are
> files this epic creates.

---

## 1. Current state in the codebase

### 1.1 The conversation spine — what ships today

| What | Where |
| --- | --- |
| Conversation entity | [`packages/agent/src/entities/conversation.entity.ts`](../../../../../packages/agent/src/entities/conversation.entity.ts) — `@Entity('conversations')`. Columns: `id`, `userId` (FK `users`, `CASCADE`), `title` (varchar 200, nullable), `providerId` (varchar 100, nullable), `model` (varchar 100, nullable — `string \| null` so clearing the pin persists as a real NULL), `metadata` (simple-json — carries `{ aiTitle: true }`), `tenantId` / `organizationId` (uuid, nullable, no `@ManyToOne` by the entity-cycle rule), `messages` (OneToMany, cascade), `createdAt` / `updatedAt`. Indexes: `['userId','updatedAt']` and `userId`. **No agent, no participants, no kind.** |
| Message entity | [`packages/agent/src/entities/conversation-message.entity.ts`](../../../../../packages/agent/src/entities/conversation-message.entity.ts) — `@Entity('conversation_messages')`. `conversationId` (FK, CASCADE), `role` (`user \| assistant \| system \| tool`), `content` (text), `parts` (simple-json — the verbatim UI-message parts array so tool cards replay on reload), `model`, `usage`, `tenantId` / `organizationId`, `createdAt`. Index `['conversationId','createdAt']`. **No author, no mentions, no attachments, no status.** |
| Repository | [`packages/agent/src/database/repositories/conversation.repository.ts`](../../../../../packages/agent/src/database/repositories/conversation.repository.ts) — `create`, `findById`, `findByUser`, `appendMessage`, `appendMessages`, `updateTitle`, `updateModel`, `delete`, `deleteAllByUser`. Barrelled from [`packages/agent/src/database/index.ts:35`](../../../../../packages/agent/src/database/index.ts). |
| REST | [`apps/api/src/ai-conversation/conversation.controller.ts`](../../../../../apps/api/src/ai-conversation/conversation.controller.ts) — `@Controller` under `api/conversations`; `MAX_CONVERSATIONS_PAGE_SIZE = 200`; `CreateConversationDto` (`title` ≤ 200, `providerId` ≤ 100, `model` ≤ 100); the PATCH DTO deliberately omits `providerId` so `forbidNonWhitelisted` hard-400s an attempt to change it. |
| Title generation | [`apps/api/src/ai-conversation/conversation-title.service.ts`](../../../../../apps/api/src/ai-conversation/conversation-title.service.ts) — `maybeGenerateTitle`, fired un-awaited from the append path once a thread reaches 4+ messages, guarded once by `metadata.aiTitle`. |
| Model proxy | [`apps/api/src/ai-conversation/openai-compat.service.ts`](../../../../../apps/api/src/ai-conversation/openai-compat.service.ts) — the single call-out point every chat surface hits. Already does `@kb:` mention parsing + `<kb>` injection, ~15-pattern secret redaction on provider errors, and 422 (not 500) when no provider is configured. |
| Module | [`apps/api/src/ai-conversation/ai-conversation.module.ts`](../../../../../apps/api/src/ai-conversation/ai-conversation.module.ts) — imports `FacadesModule`, `DatabaseModule`, `KnowledgeBaseModule`; exports `OpenAiCompatService` for the external chat bridge. |

### 1.2 The web chat surface — what ships today

| What | Where |
| --- | --- |
| Shell mount | [`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>) — mounts `ChatProvider` + `ChatPanelProvider`, renders `ChatPanel` as a resizable desktop rail and a full-screen mobile overlay. Pointer-drag resize clamps to `Math.max(350, Math.min(maxWidth, pointerWidth))` (line ~346); width persists in `localStorage['chat-width']` (lines ~160–195, ~306); open/closed persists in the `chat-panel-open` cookie (line ~151), read server-side by [`layout.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout.tsx>) so the shell mounts without a flash. |
| Panel body | [`apps/web/src/components/ai/ChatPanel.tsx`](../../../../../apps/web/src/components/ai/ChatPanel.tsx) → [`ChatInterface.tsx`](../../../../../apps/web/src/components/ai/ChatInterface.tsx) — toolbar, welcome/empty state or message list, an inline error banner, composer, plus the canvas overlay under [`components/ai/canvas/`](../../../../../apps/web/src/components/ai/canvas). |
| History list | [`apps/web/src/components/ai/ChatHistory.tsx`](../../../../../apps/web/src/components/ai/ChatHistory.tsx) — **replaces the whole panel body** when the toolbar's history icon is clicked; groups by Today / Yesterday / N days ago. |
| Composer | [`apps/web/src/components/ai/ChatInput.tsx`](../../../../../apps/web/src/components/ai/ChatInput.tsx) — an **uncontrolled** `<textarea>` (deliberate: controlling it would re-render the panel per keystroke; `hasText` state tracks emptiness only). Hosts [`ChatAttachments.tsx`](../../../../../apps/web/src/components/ai/ChatAttachments.tsx), [`ChatDictation.tsx`](../../../../../apps/web/src/components/ai/ChatDictation.tsx), [`ChatModelSelector.tsx`](../../../../../apps/web/src/components/ai/ChatModelSelector.tsx). |
| Panel state | [`apps/web/src/lib/hooks/use-chat-panel.tsx`](../../../../../apps/web/src/lib/hooks/use-chat-panel.tsx) and [`apps/web/src/components/ai/ChatProvider.tsx`](../../../../../apps/web/src/components/ai/ChatProvider.tsx) — one fixed transport, one chat id, active conversation id in `localStorage['chat-active-conversation']`. |
| BFF | [`apps/web/src/app/api/chat/route.ts`](../../../../../apps/web/src/app/api/chat/route.ts) — Zod-validated UI-message body (128 KB/text-part, 4 MB total, 512 messages, ≤ 20 attachment ids), streams the reply, persists via [`lib/ai/persistence.ts`](../../../../../apps/web/src/lib/ai/persistence.ts) in `onFinish`, and ingests attachments into Memory via `after()`. |
| API client | [`apps/web/src/lib/api/conversations.ts`](../../../../../apps/web/src/lib/api/conversations.ts) — `list`, `get`, `create`, `updateTitle`, … |
| Sidebar | [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) — a hardcoded 14-item nav array, with two inline live badges as the precedent for a live section. |

**Gaps this epic closes:** no Agent on a Conversation, no participants, no group, no broadcast, no
in-panel navigation stack, no mention affordance, no retry, no unread.

### 1.3 The addressing machinery that already works — in Task chat

This is the single most important existing asset. It is complete, tested and running; it is simply
scoped to one object type.

| What | Where |
| --- | --- |
| Service | [`packages/agent/src/tasks-domain/task-chat.service.ts`](../../../../../packages/agent/src/tasks-domain/task-chat.service.ts) — `MAX_CHAT_BYTES = 16 * 1024`, `EDIT_WINDOW_MS = 5 * 60_000`, `MENTION_RE = /@([a-z0-9-]{1,80})\b/g`, `KB_LINK_RE`. `post()` runs: cross-user 404 guard → `assertNoSecrets` → size cap → `parseMentions(body, lookups)` against `MentionLookups { ownedAgentSlugs, knownUserSlugs, knownKbSlugs }` → persist the **resolved subset only** → materialize document mentions → per-mentioned-Agent dispatch. |
| The dedupe rule | Same file, ~lines 148–275: for every `@agent` mention it builds `dedupKey = ${task.id}:${mention.id}:${row.id}`, asks `RUN_STEERING_PORT` whether that Agent already has a live run for this Task and **injects into it instead of spawning**, otherwise admits through `RunDispatchGateService` and enqueues `agent-chat-reply`. A parked admission is logged with its `queuedReason`, never swallowed. |
| Dispatcher contract | [`packages/agent/src/tasks-domain/task-dispatcher.ts`](../../../../../packages/agent/src/tasks-domain/task-dispatcher.ts) — `AGENT_CHAT_REPLY_DISPATCHER` symbol + `AgentChatReplyDispatchPayload { agentId, userId, taskId, triggeringMessageId, dedupKey, runId? }`. Keeps `@ever-works/agent` free of a runtime job-runtime SDK dependency. |
| Concurrency valve | [`packages/agent/src/agents/run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts) — per-Work (default 10) and per-Organization (default 25) ceilings; over the cap a run is created `queued` with a recorded `queuedReason` and promoted later by `drainForWork`. |
| Steering port | [`packages/agent/src/tasks-domain/run-steering-port.ts`](../../../../../packages/agent/src/tasks-domain/run-steering-port.ts) |
| Secret scan | [`packages/agent/src/utils/secret-scan.ts`](../../../../../packages/agent/src/utils/secret-scan.ts) — `assertNoSecrets`, already used by Agent instruction files and Task comments. |
| Persisted mention shape | [`packages/agent/src/entities/task-chat-message.entity.ts`](../../../../../packages/agent/src/entities/task-chat-message.entity.ts) — `TaskChatMention { type: 'user' \| 'agent' \| 'kb'; id?; slug? }` and `TaskChatAttachmentRef { uploadId }`. |
| Job | [`packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts`](../../../../../packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts), registered in [`packages/tasks/src/tasks/trigger/index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts). |
| REST | [`apps/api/src/tasks/task-chat.controller.ts`](../../../../../apps/api/src/tasks/task-chat.controller.ts) (`api/task-chat-messages`, `@Throttle({ long: { limit: 60, ttl: 60_000 } })`). |

### 1.4 Other assets this epic reuses rather than rebuilds

| What | Where | Used for |
| --- | --- | --- |
| Agent collaborator allow-list | [`packages/agent/src/entities/agent-collaborator.entity.ts`](../../../../../packages/agent/src/entities/agent-collaborator.entity.ts) — unique `(agentId, collaboratorAgentId)` + `enabled` | The **only** authorisation for an Agent-pair Conversation (spec FR-77). No new permission model. |
| Agent status lifecycle | [`packages/agent/src/entities/agent.entity.ts`](../../../../../packages/agent/src/entities/agent.entity.ts) — `AgentStatus` `draft\|active\|running\|paused\|error\|archived` | What the reach receipt reports `skipped` against. |
| Run entity | [`packages/agent/src/entities/agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts) — `triggerKind`, `taskId`, `chatMessageId` (**FK to `task_chat_messages.id`**, index `idx_agent_runs_chat_message`), `costCents`, `queuedReason`, `pendingInput` | Reply executions and their receipts. `chatMessageId` is already taken by Task chat, so a Conversation reply needs its own column (§3.3). |
| SSE precedent | [`apps/api/src/email/email.controller.ts`](../../../../../apps/api/src/email/email.controller.ts) lines ~167–250 — poll-diff SSE, 5 s poll, 15 s heartbeat comment, 10-minute forced lifetime, prime-then-diff so the backlog is not announced as new | Exactly the transport for live Conversation delivery, copied verbatim in shape. |
| SSE client precedent | [`apps/web/src/lib/hooks/use-inbox-stream.ts`](../../../../../apps/web/src/lib/hooks/use-inbox-stream.ts) — `EventSource` with a 30 s poll fallback when unavailable or erroring | Spec FR-22/FR-23. |
| Document references | [`packages/agent/src/services/kb-mention-parser.ts`](../../../../../packages/agent/src/services/kb-mention-parser.ts), [`kb-mention-resolver.service.ts`](../../../../../packages/agent/src/services/kb-mention-resolver.service.ts), [`kb-prompt-formatter.ts`](../../../../../packages/agent/src/services/kb-prompt-formatter.ts) | The `#` reference target; [AW-06](../AW-06-knowledge-library/plan.md) owns the picker, this epic consumes it. |
| Typeahead precedent | [`apps/web/src/components/skills/SlashCommandAutocomplete.tsx`](../../../../../apps/web/src/components/skills/SlashCommandAutocomplete.tsx) | The mention picker copies its keyboard model and module-level cache. |
| Org membership gate | [`apps/api/src/organizations/organization-membership.service.ts`](../../../../../apps/api/src/organizations/organization-membership.service.ts) — `ensureMember` / `ensureAdmin`, 404-not-403 on non-membership | Channel read/write authorisation. |
| Scope plumbing | [`apps/api/src/scope/scope-context.service.ts`](../../../../../apps/api/src/scope/scope-context.service.ts), [`packages/agent/src/database/ownership-scope.ts`](../../../../../packages/agent/src/database/ownership-scope.ts) (`ownershipWhere`, `ownershipStamp`, `ownershipScopeOf`) | Spec FR-97/98. |
| Activity record | [`packages/agent/src/activity-log/activity-log.service.ts`](../../../../../packages/agent/src/activity-log/activity-log.service.ts), enum [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts) (already has `CHAT_CONVERSATION`) | Spec FR-110. |
| Notifications | [`packages/agent/src/notifications/notification.service.ts`](../../../../../packages/agent/src/notifications/notification.service.ts), types [`packages/agent/src/entities/notification.types.ts`](../../../../../packages/agent/src/entities/notification.types.ts) | Spec FR-104/105. |
| Uploads | [`apps/web/src/app/api/uploads/route.ts`](../../../../../apps/web/src/app/api/uploads/route.ts) + [`apps/web/src/lib/ai/attachments.ts`](../../../../../apps/web/src/lib/ai/attachments.ts) | Attachments — unchanged. |

---

## 2. Architecture and the seam

### 2.1 Where this plugs in

The seam is **one new domain module in the agent package** (`packages/agent/src/conversations/`),
modelled directly on `tasks-domain/`, plus additive columns on the two entities that already exist.
The existing web streaming path — browser → `POST /api/chat` → `runAgent()` →
`POST /api/v1/chat/completions` — is **not touched**. Agent replies in Conversations are Runs,
dispatched through the job runtime, exactly like Task-chat replies.

```
  ┌──────────────────────── apps/web ──────────────────────────┐
  │  ChatPanel (docked)                                        │
  │   ├─ ConversationView ── composer ── MentionPicker         │
  │   ├─ ConversationList  (per participant)                   │
  │   └─ ParticipantSwitcher                                   │
  │        │ server actions            │ EventSource           │
  └────────┼───────────────────────────┼───────────────────────┘
           ▼                           ▼
  ┌──────────────── apps/api/src/ai-conversation ──────────────┐
  │  conversation.controller.ts        (extended: kind/name/…) │
  │  conversation-participants.controller.ts            (new)  │
  │  conversation-channel.controller.ts                 (new)  │
  │  conversation-stream.controller.ts                  (new)  │
  └───────────────────────┬────────────────────────────────────┘
                          ▼
  ┌────────── packages/agent/src/conversations (new) ──────────┐
  │  conversation.service.ts        create / name / archive    │
  │  conversation-message.service.ts  post → parse → dispatch  │
  │  conversation-mention.service.ts  parse + resolve + strip  │
  │  conversation-promotion.service.ts  direct → group         │
  │  conversation-broadcast.service.ts  channel fan-out        │
  │  agent-peer-conversation.service.ts  pair + pause rule     │
  │  conversation-dispatcher.ts     DI symbols (ports only)    │
  └──────┬───────────────────────────────┬─────────────────────┘
         │ reuses                        │ enqueues via *_DISPATCHER
         ▼                               ▼
  RunDispatchGateService          packages/tasks/src/tasks/trigger
  RunSteeringPort                   agent-conversation-reply.task.ts   (new)
  assertNoSecrets                   conversation-broadcast.task.ts     (new)
  AgentCollaboratorRepository
```

### 2.2 Five decisions and why

**D1 — A Conversation is the named unit; we do not introduce a "thread" noun.**
The program vocabulary has no word between Conversation and message, and `Conversation` already
carries the right cardinality (many per person, each with its own message list). "A conversation
per job" is achieved by *creating* one per job (FR-3), not by nesting a new entity inside one.

**D2 — Participants are a table, not a JSON column.**
Membership is queried in both directions ("who is in this Conversation" for the header; "which
Conversations is this Agent in" for the Agent surface and for the reply dispatcher), carries
per-participant mutable state (`lastReadMessageId`, `mutedAt`, `leftAt`), and must be uniquely
constrained to prevent double-add races (FR-56). A JSON array satisfies none of those.

**D3 — Reach is a JSON column on the message, not a table.**
It is written exactly once at post time, always read with its message, and bounded by the 200-Agent
broadcast ceiling (FR-71). A table would add a join to every channel read for no query we need.

**D4 — A Conversation reply gets its own Run link column.**
`agent_runs.chatMessageId` is documented as an FK to `task_chat_messages.id` and has its own index.
Overloading it would make `idx_agent_runs_chat_message` ambiguous and break the Task-chat
in-flight-run lookup. A separate nullable `conversationMessageId` keeps both lookups exact and is
purely additive.

**D5 — Delivery is poll-diff SSE, not a broker.**
The platform has no pub/sub infrastructure and the inbox stream already proves the pattern at this
scale. Copying it keeps the deployment surface unchanged and gives the 30-second poll fallback for
free.

### 2.3 The addressing pipeline (the core of the epic)

```
person posts a message
      │
      ├─ assertNoSecrets(body)                       → 400, spec FR-38
      ├─ body ≤ 16 KB                                → 400, spec FR-37
      ├─ resolve mentions against what THIS caller
      │  can see in THIS conversation kind           → spec FR-27, FR-96
      │     unresolved tokens dropped from the
      │     agent-visible body                       → spec FR-32
      ├─ persist the message (status = sent)
      │
      ├─ kind = direct  ──► dispatch the addressed Agent
      │
      ├─ kind = group   ──┬─ mentions?  ──► dispatch exactly those (≤ 8)
      │                   └─ none?      ──► deliver to all, each decides
      │
      ├─ kind = channel ──┬─ mentions?  ──► dispatch exactly those
      │                   └─ none?      ──► enqueue ONE broadcast job
      │
      └─ for each dispatch target:
            live run from this Conversation? ─yes─► steer into it  (FR-92)
            admission through RunDispatchGateService
                 admitted ─► `delivered`
                 parked   ─► `queued`  + queuedReason
            agent status not active     ─► `skipped` + status
            guardrail / budget refusal  ─► `refused` + rule name
```

---

## 3. Data model

Entities live in `packages/agent/src/entities/`; migrations live in `apps/api/src/migrations/`
(timestamp-prefixed; the newest on `develop` today is `1789100000000-AddTaskGraphFanout.ts`).
**Constitution V: each entity change below ships its migration in the same PR.**

### 3.1 `conversations` — additive columns (P1 + P2 + P3)

Edit [`packages/agent/src/entities/conversation.entity.ts`](../../../../../packages/agent/src/entities/conversation.entity.ts). Nothing existing is renamed, retyped or dropped.

| Column | Type | Null | Default | Phase | Purpose |
| --- | --- | --- | --- | --- | --- |
| `kind` | varchar(24) | no | `'direct'` | P1 | `direct` / `group` / `organization_channel` / `agent_pair` |
| `agentId` | uuid | yes | — | P1 | The addressed Agent for `direct`. FK → `agents.id`, `ON DELETE SET NULL` (FR-101) |
| `titleSource` | varchar(8) | yes | — | P1 | `user` / `auto`. `user` permanently disables auto-titling (FR-6) |
| `contextType` | varchar(16) | yes | — | P1 | `mission` / `task` / `work` / `idea` / `agent` (FR-9) |
| `contextId` | uuid | yes | — | P1 | No FK — the target table varies; existence is checked at write time |
| `lastMessageAt` | timestamptz | yes | — | P1 | Activity ordering without a correlated subquery (FR-12) |
| `archivedAt` | timestamptz | yes | — | P2 | Archive/restore (FR-57–FR-60) |
| `linkedConversationId` | uuid | yes | — | P2 | Cross-link on promotion. FK → `conversations.id`, `ON DELETE SET NULL` (FR-51) |
| `pausedReason` | varchar(32) | yes | — | P2 | `agent_pair_message_ceiling` (FR-82) |
| `agentMessageStreak` | int | no | `0` | P2 | Consecutive Agent-authored messages, reset by a person's post (FR-82/83) |

New indexes:

```
idx_conversations_user_kind_activity   (userId, kind, lastMessageAt DESC)
idx_conversations_agent_activity       (agentId, lastMessageAt DESC)            WHERE agentId IS NOT NULL
idx_conversations_org_kind             (organizationId, kind, lastMessageAt DESC)
uq_conversations_org_channel           UNIQUE (organizationId)  WHERE kind = 'organization_channel'
```

`uq_conversations_org_channel` is the whole of FR-63 — the singleton is a database constraint, not a
service-layer check, so a concurrent first-use cannot create two channels.

### 3.2 `conversation_messages` — additive columns (P1 + P3)

Edit [`packages/agent/src/entities/conversation-message.entity.ts`](../../../../../packages/agent/src/entities/conversation-message.entity.ts).

| Column | Type | Null | Default | Phase | Purpose |
| --- | --- | --- | --- | --- | --- |
| `authorType` | varchar(8) | no | `'user'` | P1 | `user` / `agent` / `system` (FR-75) |
| `authorId` | uuid | yes | — | P1 | User id or Agent id. Null for `system` |
| `mentions` | simple-json | yes | — | P1 | Reuses the `TaskChatMention` shape verbatim |
| `attachments` | simple-json | yes | — | P1 | Reuses `TaskChatAttachmentRef` (`{ uploadId }`), ≤ 10 (FR-35) |
| `status` | varchar(8) | no | `'sent'` | P1 | `sending` / `sent` / `failed` (FR-42) |
| `failureCode` | varchar(40) | yes | — | P1 | `rate_limited` / `provider_unavailable` / `network` / `too_large` / `secret_detected` / `forbidden` |
| `clientMessageId` | varchar(64) | yes | — | P1 | Retry idempotency (FR-41) |
| `replyToMessageId` | uuid | yes | — | P1 | The message an Agent reply answers |
| `reach` | simple-json | yes | — | P3 | `ConversationReach[]` (§3.5) |

New indexes:

```
idx_conversation_messages_status         (conversationId, status)
uq_conversation_messages_client_id       UNIQUE (conversationId, clientMessageId)
                                         WHERE clientMessageId IS NOT NULL
```

The unique index **is** FR-41: a double-tapped Retry is rejected by the database, not by a race in
the service.

The existing `role` column keeps its meaning and is still written — `authorType` describes *who*,
`role` describes *what the model sees*. Nothing reads `role` differently after this change.

### 3.3 `agent_runs` — one additive column (P1)

Edit [`packages/agent/src/entities/agent-run.entity.ts`](../../../../../packages/agent/src/entities/agent-run.entity.ts).

| Column | Type | Null | Purpose |
| --- | --- | --- | --- |
| `conversationMessageId` | uuid | yes | Populated only when `triggerKind = 'conversation'`. FK → `conversation_messages.id`, `ON DELETE SET NULL` |

Index `idx_agent_runs_conversation_message (conversationMessageId)`.

The `AgentRunTriggerKind` TypeScript union gains `'conversation'`. The column is `varchar(16)` and
`'conversation'` is 12 characters — **no column change, no migration for the enum itself**.

### 3.4 `conversation_participants` — the one new table (P1)

New entity at `packages/agent/src/entities/conversation-participant.entity.ts` **(new)**, exported
from [`packages/agent/src/entities/index.ts`](../../../../../packages/agent/src/entities/index.ts).

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | uuid PK | no | |
| `conversationId` | uuid | no | FK → `conversations.id`, `ON DELETE CASCADE` |
| `participantType` | varchar(8) | no | `user` / `agent` |
| `participantId` | uuid | no | No FK — the target table varies by type |
| `role` | varchar(12) | no | `owner` / `member` / `observer`, default `member` |
| `joinedAt` | timestamptz | no | |
| `leftAt` | timestamptz | yes | Departure, never deletion (FR-55, FR-101) |
| `lastReadMessageId` | uuid | yes | Unread computation (FR-24) |
| `lastReadAt` | timestamptz | yes | |
| `mutedAt` | timestamptz | yes | |
| `tenantId` / `organizationId` | uuid | yes | Tier-C denormalisation, no `@ManyToOne` (entity-cycle rule) |
| `createdAt` / `updatedAt` | timestamptz | no | |

```
uq_conversation_participants   UNIQUE (conversationId, participantType, participantId)
idx_conversation_participants_target  (participantType, participantId, conversationId)
```

`uq_conversation_participants` is FR-56: two simultaneous promotions insert the same
`(conversation, agent)` pair and one of them loses to the constraint, which the promotion service
catches and resolves by loading the winner.

### 3.5 Shared types (no schema)

New file `packages/agent/src/conversations/conversation.types.ts` **(new)**:

```
ConversationKind          = 'direct' | 'group' | 'organization_channel' | 'agent_pair'
ConversationMessageStatus = 'sending' | 'sent' | 'failed'
ConversationAuthorType    = 'user' | 'agent' | 'system'
ConversationReachOutcome  = 'delivered' | 'queued' | 'skipped' | 'refused'
ConversationReach         = { agentId, outcome, reason?, runId? }
```

Re-exported through `packages/agent/src/conversations/index.ts` **(new)** and a new `./conversations`
subpath in [`packages/agent/package.json`](../../../../../packages/agent/package.json) alongside the
existing `./tasks-domain` entry.

### 3.6 Migrations (forward-only, one per phase)

| Phase | File **(new)** | Contents |
| --- | --- | --- |
| P1 | `apps/api/src/migrations/1789200000000-AddConversationKindAndParticipants.ts` | `ALTER TABLE conversations ADD` the six P1 columns; `ALTER TABLE conversation_messages ADD` the eight P1 columns; `ALTER TABLE agent_runs ADD conversationMessageId`; `CREATE TABLE conversation_participants`; all P1 indexes; a backfill that inserts one `owner` participant row per existing conversation from its `userId` and sets `lastMessageAt` from `MAX(conversation_messages.createdAt)` and `titleSource = 'auto'` where `metadata->>'aiTitle' = 'true'`. |
| P2 | `apps/api/src/migrations/1789300000000-AddConversationGroupsAndPeers.ts` | `archivedAt`, `linkedConversationId`, `pausedReason`, `agentMessageStreak` + their FK and indexes. |
| P3 | `apps/api/src/migrations/1789400000000-AddConversationChannelReach.ts` | `conversation_messages.reach`; `uq_conversations_org_channel`. |

Every statement is `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`. No `DROP`, no rename, no retype.
`down()` reverses each with `DROP COLUMN` / `DROP TABLE` in reverse order, per repo convention.

---

## 4. API

All endpoints live under `apps/api/src/ai-conversation/`, guarded exactly as the existing
`ConversationController` is (session guard + `@CurrentUser()`), and scoped through
`ownershipWhere` / `ScopeContextService`. Every write carries
`@Throttle({ long: { limit: 30, ttl: 60_000 } })` unless stated otherwise.

### 4.1 Extended — `conversation.controller.ts`

| Method | Path | Change | Phase |
| --- | --- | --- | --- |
| GET | `/api/conversations` | Additive optional query params `kind`, `agentId`, `archived` (`true\|false\|only`, default `false`), `contextType`, `contextId`. Response rows gain `kind`, `agentId`, `name`, `titleSource`, `lastMessageAt`, `unreadCount`, `participants[]`. Existing callers that pass none of the new params get today's behaviour. | P1 |
| POST | `/api/conversations` | Body gains optional `kind`, `agentId`, `contextType`, `contextId`, `participantAgentIds[]` (≤ 8). Defaults reproduce today's behaviour exactly. | P1 |
| PATCH | `/api/conversations/:id` | `title` becomes `string \| null`. A non-null value sets `titleSource='user'`; `null` clears the title and `titleSource`. `providerId` stays absent from the whitelist. | P1 |
| GET | `/api/conversations/:id` | Response gains `kind`, `agentId`, `participants[]`, `linkedConversation`, `context`, `archivedAt`, `pausedReason`. | P1 |
| DELETE | `/api/conversations` | Unchanged behaviour, now explicitly excluding `organization_channel` and `agent_pair` rows (FR-102). | P1 |

### 4.2 New — messages, retry, read state

| Method | Path | Body / query | Returns | Phase |
| --- | --- | --- | --- | --- |
| GET | `/api/conversations/:id/messages` | `limit` (≤ 200, default 50), `before` (message id) | Paged messages, newest-last | P1 |
| POST | `/api/conversations/:id/messages` | **Extended**: existing batch append plus `clientMessageId`, `attachments[]` (≤ 10), `authorType` | `202` with the stored message and its dispatch outcomes | P1 |
| POST | `/api/conversations/:id/messages/:messageId/retry` | — | `202`; `409` if the message is not `failed` | P1 |
| DELETE | `/api/conversations/:id/messages/:messageId` | Only a `failed` message may be discarded; `409` otherwise | `204` | P1 |
| POST | `/api/conversations/:id/read` | `{ lastReadMessageId }` | `204` | P1 |
| GET | `/api/conversations/mention-candidates` | `q` (≤ 80 chars), `conversationId` | ≤ 8 `{ type, id, slug, name, status }` | P1 |

### 4.3 New — `conversation-participants.controller.ts` **(new)**

| Method | Path | Notes | Phase |
| --- | --- | --- | --- |
| GET | `/api/conversations/:id/participants` | | P1 |
| POST | `/api/conversations/:id/participants` | `{ participantType, participantId }`; `409` at the 8-Agent cap (FR-54) | P2 |
| DELETE | `/api/conversations/:id/participants/:participantType/:participantId` | Sets `leftAt`; never deletes the row (FR-55) | P2 |
| POST | `/api/conversations/:id/promote` | `{ agentId, carryMessages? }` → `201 { conversationId }`. Idempotent on the unique participant constraint (FR-56) | P2 |
| POST | `/api/conversations/:id/archive` | `409` for `organization_channel` and `agent_pair` (FR-65, FR-85) | P2 |
| POST | `/api/conversations/:id/restore` | Restores to activity position — no timestamp is touched (FR-59) | P2 |

### 4.4 New — `conversation-channel.controller.ts` **(new)**

| Method | Path | Notes | Phase |
| --- | --- | --- | --- |
| GET | `/api/conversations/organization-channel` | Resolve-or-create the singleton for the active Organization; `404` when there is no Organization (FR-63, S-26) | P3 |
| POST | `/api/conversations/organization-channel/messages` | `@Throttle({ long: { limit: 10, ttl: 3_600_000 } })` (FR-47). Returns `202` **before** delivery (FR-74) | P3 |
| GET | `/api/conversations/:id/messages/:messageId/reach` | The full receipt (FR-69/70) | P3 |
| GET | `/api/conversations/agent-pairs` | One row per pair with the latest message (FR-79) | P2 |
| GET | `/api/conversations/agent-pairs/:pairId` | Full transcript; `404` outside the caller's Organization | P2 |
| POST | `/api/conversations/agent-pairs/:pairId/messages` | The person stepping in (FR-81) | P2 |

Both channel endpoints call `OrganizationMembershipService.ensureMember` first, which 404s rather
than 403s — satisfying FR-95 with no new code.

### 4.5 New — `conversation-stream.controller.ts` **(new)**

`GET /api/conversations/stream?conversationId=` — SSE, copied in shape from the email stream: 5 s
poll-diff, 15 s heartbeat comment, prime-then-diff so the backlog is not announced, 10-minute forced
lifetime, and every failure swallowed so the heartbeat keeps the connection alive. Phase P1.

### 4.6 DTOs

New file `apps/api/src/ai-conversation/dto/conversation.dto.ts` **(new)** next to the existing
[`dto/openai-compat.dto.ts`](../../../../../apps/api/src/ai-conversation/dto/openai-compat.dto.ts) —
`ListConversationsQueryDto`, `CreateConversationDto` (moved from the controller and extended),
`UpdateConversationDto`, `PostConversationMessageDto`, `AddParticipantDto`, `PromoteConversationDto`,
`MarkReadDto`, `MentionCandidatesQueryDto`. Every string field carries an explicit `@MaxLength`,
matching the existing controller's stated DoS posture.

Shared response types go to `packages/contracts/src/conversations/conversation.types.ts` **(new)**
with an `index.ts` barrel, alongside the existing `packages/contracts/src/inbox/` and
`packages/contracts/src/hitl/` folders.

---

## 5. Web

### 5.1 New components — `apps/web/src/components/ai/conversations/` **(new folder)**

| File **(all new)** | Responsibility |
| --- | --- |
| `ConversationPanelRouter.tsx` | The three-view stack (Conversation → list → switcher) and the back control (FR-14). Owns no data. |
| `ConversationHeader.tsx` | Back, participant name as the switcher trigger, name control, context chip, close (FR-13/14) |
| `ConversationNameDialog.tsx` | Set / clear the name; 200-character counter (§6.5 of the spec) |
| `ConversationListPanel.tsx` | One participant's Conversations: name-over-preview rows, unread dots, empty / loading / error states |
| `ParticipantSwitcher.tsx` | Agents, groups, the channel, the Agent-conversations entry (FR-15) |
| `MentionPicker.tsx` | `@` typeahead: 150 ms debounce, ≤ 8 rows, `↑↓/Enter/Tab/Esc`. Keyboard model copied from `SlashCommandAutocomplete.tsx` |
| `ComposerHighlightLayer.tsx` | The overlay that lights up resolved mentions and references without controlling the textarea (see D6 below) |
| `MessageRetryBar.tsx` | Failed-message row: reason text, Retry, Discard (FR-42–FR-46) |
| `ReachReceipt.tsx` | "Reached 7 of 9" summary plus the grouped expansion (FR-69/70) |
| `GroupMembersMenu.tsx` | Rename, add / remove an Agent, archive (FR-55/61) |
| `AgentPairList.tsx` / `AgentPairView.tsx` | Agent-to-Agent list and transcript, with the paused state (FR-79–FR-83) |
| `OrganizationChannelView.tsx` | The channel body, its subtitle, its composer placeholder, its over-limit and no-Agent states |
| `ConversationsSidebarSection.tsx` | The sidebar section: channel pinned first, groups by recency, `Archived (N)` |

**D6 — how the highlight layer keeps the textarea uncontrolled.**
`ChatInput.tsx` is deliberately uncontrolled, and making it controlled would re-render the panel on
every keystroke. `ComposerHighlightLayer` therefore renders a `aria-hidden`, pointer-events-none
`<div>` positioned exactly behind the textarea, sharing its font metrics and scroll offset, painting
spans only for **server-confirmed** resolved tokens. The textarea stays uncontrolled; resolution
results arrive from the debounced `mention-candidates` call and are keyed by token offset. This is
what makes FR-29 true by construction: nothing is highlighted until the server has confirmed it
resolves.

### 5.2 Modified components

| File | Change |
| --- | --- |
| [`apps/web/src/components/ai/ChatPanel.tsx`](../../../../../apps/web/src/components/ai/ChatPanel.tsx) | Renders `ConversationPanelRouter` instead of `ChatInterface` directly; `ChatInterface` becomes the Conversation view |
| [`ChatInterface.tsx`](../../../../../apps/web/src/components/ai/ChatInterface.tsx) | Accepts a `conversationId` + `kind` and stops assuming a single global thread |
| [`ChatInput.tsx`](../../../../../apps/web/src/components/ai/ChatInput.tsx) | Mounts `MentionPicker` + `ComposerHighlightLayer`; adds the 16 KB pre-send guard and the placeholder per kind |
| [`ChatProvider.tsx`](../../../../../apps/web/src/components/ai/ChatProvider.tsx) | Gains the panel view stack, the active participant, unread state and the failed-message queue |
| [`ChatHistory.tsx`](../../../../../apps/web/src/components/ai/ChatHistory.tsx) | Kept, unchanged, as the flat all-conversations list; the new per-participant list is a sibling, not a replacement |
| [`apps/web/src/lib/hooks/use-chat-panel.tsx`](../../../../../apps/web/src/lib/hooks/use-chat-panel.tsx) | Adds the double-click-to-reset handler (420 px) and keyboard resize on the handle |
| [`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>) | Only the double-click reset and the handle's keyboard affordance; the existing clamp `Math.max(350, Math.min(maxWidth, …))` and the `chat-width` / `chat-panel-open` persistence stay exactly as they are |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx) | Mounts `ConversationsSidebarSection` beneath the fixed nav array; the array itself is untouched |
| [`apps/web/src/lib/api/conversations.ts`](../../../../../apps/web/src/lib/api/conversations.ts) | New client methods for every §4 endpoint; existing signatures unchanged |

### 5.3 New hooks and data fetching

| File **(new)** | Purpose |
| --- | --- |
| `apps/web/src/lib/hooks/use-conversation-stream.ts` | `EventSource` on the SSE endpoint with a 30 s poll fallback — same shape as `use-inbox-stream.ts` |
| `apps/web/src/lib/hooks/use-mention-candidates.ts` | Debounced picker source with a module-level cache |
| `apps/web/src/lib/hooks/use-conversation-outbox.ts` | Optimistic send, failed-message persistence in `localStorage['chat-outbox']`, `clientMessageId` generation, Retry / Discard |
| `apps/web/src/app/actions/conversations.ts` | Server actions wrapping the API client, matching the existing `app/actions/*` pattern |

Reads are server actions from RSC where the surface is a page; the docked panel is a client
component and calls the same actions. No new fetching library.

### 5.4 Entry points elsewhere in the product

- **Mission cards** — [AW-02](../AW-02-mission-board/spec.md) already specifies the `Chat about it`
  menu item and its i18n key `dashboard.missionsPage.menu.chat`. This epic implements the handler:
  open the docked panel with `contextType='mission'`, `contextId=<id>`.
- **Agent detail** — a `Message <agent>` action opens a `direct` Conversation addressed at that
  Agent, from [`apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx>).
- **Agent conversations** — reachable from the participant switcher and from the Agents surface.

---

## 6. Background work

**Constitution IV: every dispatch goes through a `*_DISPATCHER` DI symbol. No call site imports a
job-runtime SDK.**

New ports in `packages/agent/src/conversations/conversation-dispatcher.ts` **(new)** — a leaf file
with no service imports, exactly like `tasks-domain/task-dispatcher.ts`:

```
AGENT_CONVERSATION_REPLY_DISPATCHER
   AgentConversationReplyDispatchPayload
     { agentId, userId, conversationId, triggeringMessageId, dedupKey, runId?,
       tenantId?, organizationId? }

CONVERSATION_BROADCAST_DISPATCHER
   ConversationBroadcastDispatchPayload
     { conversationId, messageId, userId, organizationId, dedupKey }
```

A **new** symbol rather than reusing `AGENT_CHAT_REPLY_DISPATCHER`: that payload requires `taskId`,
and widening it would change a contract three call sites and two specs already depend on. The two
ports sit side by side; the Task path is untouched.

New job-runtime tasks:

| File **(new)** | Kind | Fired by | Does |
| --- | --- | --- | --- |
| `packages/tasks/src/tasks/trigger/agent-conversation-reply.task.ts` | one-shot | `ConversationMessageService` per dispatched Agent | Resolves the Conversation, builds the Agent's context (recent messages, resolved document references, attached context object), executes the run, appends the reply as a message with `authorType='agent'` |
| `packages/tasks/src/tasks/trigger/conversation-broadcast.task.ts` | one-shot | `ConversationBroadcastService` on an unmentioned channel post | Enumerates addressable Agents, classifies each into a reach outcome, enqueues at most 8 reply dispatches immediately and records the rest as `queued`, then writes the `reach` column once |

Both are registered in [`packages/tasks/src/tasks/trigger/index.ts`](../../../../../packages/tasks/src/tasks/trigger/index.ts) beside `agent-chat-reply.task.ts`, and bound in the api-side providers
file alongside the existing dispatcher bindings.

Admission for every reply goes through the existing
[`RunDispatchGateService`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts) —
this epic adds **no** new concurrency mechanism, and a parked reply is promoted by the existing
`drainForWork` path.

**No new cron.** The Agent-pair daily ceiling (FR-84) is computed from a `COUNT` over
`conversation_messages` with `authorType='agent'` at post time, not by a scheduled reset job.

---

## 7. Plugin boundaries

- **No new external integration.** Everything in this epic talks to Postgres, the existing job
  runtime, and the existing model proxy. Constitution I is satisfied by having nothing to satisfy.
- **No hardcoded plugin id.** Model and provider resolution for a reply run stays inside
  `AgentRunService` and the existing facades; the Conversation layer passes the Agent id and never
  names a provider (Constitution II).
- **The existing external chat bridge is not extended.** It keeps calling
  `OpenAiCompatService.handleCompletion` exactly as it does today. Giving an external messaging
  surface participants, groups or a channel is out of scope (spec §7) precisely because it would
  require plugin-side work that belongs in the connector package, not here.
- **Attachments** reuse the existing upload spine; no storage provider is referenced by id.

---

## 8. i18n

One namespace, `dashboard.aiChat`, in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json). Every leaf below is
camelCase and contains **no literal dot** — a leaf with a dot is rejected by the i18n runtime at
render time and reds several e2e shards at once.

```
dashboard.aiChat.conversations.newConversation          "New conversation"
dashboard.aiChat.conversations.nameThis                 "Name this conversation"
dashboard.aiChat.conversations.nameHint                 "Clearing the name shows the first message instead."
dashboard.aiChat.conversations.nameTooLong              "Names are at most {max} characters. This one is {count}."
dashboard.aiChat.conversations.save                     "Save"
dashboard.aiChat.conversations.cancel                   "Cancel"
dashboard.aiChat.conversations.emptyTitle               "No conversations with {agent} yet."
dashboard.aiChat.conversations.emptyBody                "Send a message to start one."
dashboard.aiChat.conversations.emptyAction              "Message {agent}"
dashboard.aiChat.conversations.loadError                "Could not load conversations."
dashboard.aiChat.conversations.tryAgain                 "Try again"
dashboard.aiChat.conversations.sectionTitle             "Conversations"
dashboard.aiChat.conversations.archivedCount            "Archived ({count})"
dashboard.aiChat.conversations.noneYet                  "No conversations yet."
dashboard.aiChat.conversations.startOne                 "Start one"
dashboard.aiChat.conversations.contextChip              "{type}: {name}"

dashboard.aiChat.panel.back                             "Back"
dashboard.aiChat.panel.switch                           "Switch"
dashboard.aiChat.panel.switchPlaceholder                "Search agents and conversations…"
dashboard.aiChat.panel.agents                           "Agents"
dashboard.aiChat.panel.groups                           "Groups"
dashboard.aiChat.panel.agentConversationsLink           "Agent conversations"
dashboard.aiChat.panel.resetWidth                       "Reset width"
dashboard.aiChat.panel.unread                           "Unread"

dashboard.aiChat.mentions.noMatch                       "No agent or teammate matches \"{query}\"."
dashboard.aiChat.mentions.noMatchHint                   "Keep typing, or press esc to leave it as text."
dashboard.aiChat.mentions.pickerHint                    "↑↓ move · ↵ insert · esc ✕"
dashboard.aiChat.mentions.willStartGroup                "Mentioning {agent} will start a group conversation with {others}."
dashboard.aiChat.mentions.overLimit                     "Only {max} mentions land in one message. The rest stay as plain text."
dashboard.aiChat.mentions.groupFull                     "A group holds up to {max} agents. This one is full — start a new group?"

dashboard.aiChat.groups.title                           "Group"
dashboard.aiChat.groups.rename                          "Rename"
dashboard.aiChat.groups.addAgent                        "Add an agent…"
dashboard.aiChat.groups.removeAgent                     "Remove an agent…"
dashboard.aiChat.groups.archive                         "Archive"
dashboard.aiChat.groups.restore                         "Restore"
dashboard.aiChat.groups.archivedNotice                  "This conversation is archived. Restore it to reply."
dashboard.aiChat.groups.carriedHistory                  "Carried the last {count} messages from that conversation."
dashboard.aiChat.groups.continuedFrom                   "Continued from your conversation with {agent}"
dashboard.aiChat.groups.derivedName                     "{names} & you"
dashboard.aiChat.groups.nobodyAdded                     "No one had anything to add. Mention someone by name to ask directly."
dashboard.aiChat.groups.placeholder                     "Message the group…"

dashboard.aiChat.orgChannel.title                       "Organization channel"
dashboard.aiChat.orgChannel.subtitle                    "One message to every active agent"
dashboard.aiChat.orgChannel.placeholder                 "Message everyone… mention someone to narrow it"
dashboard.aiChat.orgChannel.needsOrganization           "Create an Organization to broadcast to every Agent at once."
dashboard.aiChat.orgChannel.createOrganization          "Create Organization"
dashboard.aiChat.orgChannel.tooManyAgents               "This organization has {count} active agents. Broadcasts reach at most {max}. Mention the agents you need instead."
dashboard.aiChat.orgChannel.noLongerMember              "You no longer have access to this Organization's channel."
dashboard.aiChat.orgChannel.textPreserved               "Your message is still in the box."
dashboard.aiChat.orgChannel.openAgents                  "Open agents"

dashboard.aiChat.reach.summary                          "Reached {reached} of {total}"
dashboard.aiChat.reach.summaryNarrowed                  "Reached {reached} of {total} — you mentioned {names}"
dashboard.aiChat.reach.allPaused                        "Reached 0 of {total} — every agent is paused."
dashboard.aiChat.reach.delivered                        "Delivered"
dashboard.aiChat.reach.queued                           "Queued — organization is at its run ceiling"
dashboard.aiChat.reach.skippedPaused                    "Skipped — paused"
dashboard.aiChat.reach.skippedArchived                  "Skipped — archived"
dashboard.aiChat.reach.skippedError                     "Skipped — needs attention"
dashboard.aiChat.reach.refused                          "Refused — {rule}"
dashboard.aiChat.reach.cost                             "{replies} replies · {cost} so far"
dashboard.aiChat.reach.deliveredToRun                   "Delivered to a run already in progress"

dashboard.aiChat.sendFailure.rateLimited                "Not sent — you are sending faster than the rate limit allows. Nothing was lost."
dashboard.aiChat.sendFailure.providerUnavailable        "Not sent — the model provider is unavailable right now."
dashboard.aiChat.sendFailure.offline                    "Not sent — you are offline."
dashboard.aiChat.sendFailure.secretDetected             "Not sent — this message looks like it contains a credential. Store it in the connection's settings instead."
dashboard.aiChat.sendFailure.tooLong                    "Not sent — this message is too long ({size} of {max})."
dashboard.aiChat.sendFailure.attachInstead              "Attach as a file"
dashboard.aiChat.sendFailure.retry                      "Retry"
dashboard.aiChat.sendFailure.discard                    "Discard"
dashboard.aiChat.sendFailure.sending                    "Sending…"
dashboard.aiChat.sendFailure.budgetRefused              "{agent} did not reply — the agent's spend cap for this period was reached."
dashboard.aiChat.sendFailure.openCaps                   "Open caps"

dashboard.aiChat.agentPairs.title                       "Agent conversations"
dashboard.aiChat.agentPairs.subtitle                    "What your agents say to each other"
dashboard.aiChat.agentPairs.empty                       "Your agents have not needed to talk to each other yet."
dashboard.aiChat.agentPairs.emptyHint                   "They will appear here when they do."
dashboard.aiChat.agentPairs.placeholder                 "Step in…"
dashboard.aiChat.agentPairs.pausedTitle                 "Paused — waiting for you."
dashboard.aiChat.agentPairs.pausedBody                  "{a} and {b} exchanged {count} messages without you. Post to continue."
dashboard.aiChat.agentPairs.disableSetting              "Let agents talk to each other"
```

The dead keys `editMessage`, `saveEdit`, `cancelEdit`, `edited` are **left exactly where they are**
(program rule #1, additive only). This epic neither uses nor removes them.

After `en.json`, the same key set is added to the 20 sibling locale files in
[`apps/web/messages/`](../../../../../apps/web/messages) with English values, so nothing renders a
raw key while translation catches up.

---

## 9. Telemetry and failure modes

### 9.1 Activity record

Six additive members on `ActivityActionType` in
[`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts), appended beside the existing `CHAT_CONVERSATION`:

```
CONVERSATION_CREATED         = 'conversation_created'
CONVERSATION_RENAMED         = 'conversation_renamed'
CONVERSATION_ARCHIVED        = 'conversation_archived'
CONVERSATION_RESTORED        = 'conversation_restored'
CONVERSATION_MESSAGE_POSTED  = 'conversation_message_posted'
CONVERSATION_BROADCAST_SENT  = 'conversation_broadcast_sent'
```

`actionType` is a plain `varchar(50)` column — the enum is a TypeScript-side constraint only, so
**no migration is required for these**. Details carry counts and ids only: never a body, never a
mention name, never an attachment filename (spec FR-103/110).

### 9.2 Notifications

One additive `NotificationCategory` member, `CONVERSATION = 'conversation'`. The column is
`varchar(100)` — **no migration**. Emitted only for FR-104 (the person is mentioned by name). All
routing, batching and suppression belong to AW-13; this epic calls
`NotificationService.create` and stops.

### 9.3 Failure modes and the intended behaviour

| Failure | Behaviour |
| --- | --- |
| Model provider down | The reply run fails and is recorded on the run; the Conversation shows the Agent did not reply with the reason. The person's message is unaffected. |
| Job runtime unconfigured | The dispatcher port throws rather than silently no-op-ing (the posture `TaskChatService` already takes); the message is stored, the reach entry reads `refused — background jobs are not configured`. |
| Organization at its run ceiling | `queued` in the receipt with `queuedReason`; the existing drain promotes it. Never an error. |
| Agent paused / archived / errored | `skipped` with the status named. Never a retry, never a notification. |
| Broadcast job crashes mid-fan-out | The `reach` column is written **once, at the end**, from an idempotent classification keyed on `(messageId, agentId)`; a re-run of the job produces the same reach and re-uses the same dispatch dedup keys, so no Agent is dispatched twice. |
| SSE connection dies | Client falls back to the 30 s poll with no user-visible error (FR-23). |
| `clientMessageId` collision | The unique index rejects the second insert; the service returns the existing message, so Retry is idempotent by construction. |
| Promotion race | The unique participant constraint rejects the loser; the promotion service catches it and returns the winning group. |
| Person removed from the Organization mid-session | `ensureMember` 404s; the client shows the membership message and preserves the composer text. |
| Agent pair runaway | The streak counter blocks the twenty-first consecutive Agent message and the daily ceiling blocks the two-hundred-and-first, both recorded against the initiating run. |

---

## 10. Test plan

### 10.1 Unit — agent package (Jest)

| File **(all new unless stated)** | Covers |
| --- | --- |
| `packages/agent/src/conversations/__tests__/conversation-mention.service.spec.ts` | Full-name and slug matching, case-insensitivity, two-word names, the 10-mention cap, unresolved tokens staying plain and being stripped from the agent-visible body, invisible Agents producing the same result as non-existent ones |
| `packages/agent/src/conversations/__tests__/conversation.service.spec.ts` | Kind rules, name set/clear and `titleSource`, participant-derived group names, 200-character cap, archive/restore refusals for channel and pair |
| `packages/agent/src/conversations/__tests__/conversation-message.service.spec.ts` | 16 KB cap, secret rejection, `clientMessageId` idempotency, retry transitions, discard restricted to `failed` |
| `packages/agent/src/conversations/__tests__/conversation-dispatch.spec.ts` | The reply contract: mention → dispatch, no-mention group → deliver-to-all, duplicate mention → one dispatch, live-run steering, the 8-dispatch ceiling |
| `packages/agent/src/conversations/__tests__/conversation-promotion.service.spec.ts` | History carry (20 / 7 days), cross-links both ways, original untouched, concurrent promotion → one group |
| `packages/agent/src/conversations/__tests__/conversation-broadcast.service.spec.ts` | Reach classification for every outcome, narrowing by mention, the 200-Agent refusal, the zero-Agent receipt, idempotent re-run |
| `packages/agent/src/conversations/__tests__/agent-peer-conversation.service.spec.ts` | Collaborator gate, one-pair uniqueness, the 20-message pause and its reset, the daily ceiling |
| `packages/agent/src/database/repositories/conversation.repository.spec.ts` | Scoped list filters, unread computation, activity ordering |
| `packages/agent/src/database/repositories/conversation-participant.repository.spec.ts` | Unique constraint behaviour, `leftAt` semantics |

### 10.2 Controller specs — API (Jest)

| File | Covers |
| --- | --- |
| [`apps/api/src/ai-conversation/conversation.controller.spec.ts`](../../../../../apps/api/src/ai-conversation/conversation.controller.spec.ts) *(existing — extended)* | New query params, `title: null`, the new response fields, unchanged legacy behaviour |
| `apps/api/src/ai-conversation/conversation-participants.controller.spec.ts` **(new)** | Cap 409s, promote idempotency, archive refusals |
| `apps/api/src/ai-conversation/conversation-channel.controller.spec.ts` **(new)** | Singleton resolve-or-create, no-Organization 404, membership 404-not-403, the hourly throttle, 202-before-delivery |
| `apps/api/src/ai-conversation/conversation.controller.scope.spec.ts` **(new)** | Cross-scope reads return 404, mirroring [`apps/api/src/tasks/task-chat.controller.scope.spec.ts`](../../../../../apps/api/src/tasks/task-chat.controller.scope.spec.ts) |
| `apps/api/src/ai-conversation/conversation-stream.controller.spec.ts` **(new)** | Headers, prime-then-diff, heartbeat, forced lifetime cleanup |

### 10.3 Web unit (Vitest)

- `apps/web/src/components/ai/conversations/MentionPicker.unit.spec.tsx` **(new)** — debounce, ≤ 8
  rows, keyboard model, `Esc` keeps the text.
- `apps/web/src/components/ai/conversations/ComposerHighlightLayer.unit.spec.tsx` **(new)** —
  resolved tokens highlight, unresolved stay plain, the textarea stays uncontrolled.
- `apps/web/src/components/ai/conversations/MessageRetryBar.unit.spec.tsx` **(new)** — reason
  mapping, double-Retry produces one send.
- `apps/web/src/components/ai/conversations/ReachReceipt.unit.spec.tsx` **(new)** — grouping and the
  narrowed-post summary.
- `apps/web/src/components/ai/ChatProvider.unit.spec.ts` *(existing — extended)* — the view stack.

### 10.4 E2E (Playwright, `apps/web/e2e/`)

| File **(all new)** | Golden path |
| --- | --- |
| `flow-conversation-naming.spec.ts` | Create, name, reload, clear, confirm preview fallback |
| `flow-conversation-panel-navigation.spec.ts` | Panel survives five navigations, back walks three views, drag + double-click reset, width survives reload |
| `flow-conversation-mentions.spec.ts` | Picker opens, chip inserted, unmatched word stays plain, 11th mention warning |
| `flow-conversation-send-retry.spec.ts` | Forced failure, failed row survives reload, Retry sends once |
| `flow-conversation-group-promotion.spec.ts` | Mention promotes, history carried, both links present, original intact |
| `flow-conversation-archive-restore.spec.ts` | Archive, Archived list, restore to activity position, archived refuses replies |
| `flow-organization-channel-broadcast.spec.ts` | Post, receipt summary, narrowed post, no-Organization state |
| `flow-organization-channel-reach.spec.ts` | Delivered / queued / skipped groupings and the over-limit refusal |
| `flow-agent-peer-conversations.spec.ts` | List, read, step in with attribution, the paused state |
| `conversations-participants-api.spec.ts` | Contract-level checks of the new endpoints, in the style of the existing `conversations-crud.spec.ts` |

Existing chat specs — `chat-api.spec.ts`, `chat-ui-roundtrip.spec.ts`,
`flow-chat-conversation-lifecycle.spec.ts`, `flow-conversations-crud-deep.spec.ts` and siblings —
**must keep passing unmodified**. They are the regression proof that this epic is additive.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — Conversations, participants and the panel

Schema (P1 migration), the `conversations` domain module, mention parse/resolve/strip, the
`direct` reply dispatch, naming, the three-view panel with resize and reset, the composer picker and
highlight layer, optimistic send with failure and retry, SSE delivery with the poll fallback, unread
state, the i18n block, unit + controller + four e2e specs.

**Shippable because**: on its own it converts one global assistant thread into per-Agent named
Conversations with working addressing and a panel that navigates. Nothing else in the product
changes.

### P2 — Groups and Agent-to-Agent

The P2 migration, promotion by mention with history carry and cross-links, explicit group creation,
add/remove participants, archive/restore, the sidebar section, the group reply contract and its
"nobody added" line, Agent-pair Conversations with the collaborator gate, the 20-message pause and
the daily ceiling, the Organization-level on/off setting.

**Shippable because**: groups and pairs are new surfaces layered on P1's participants table; P1
behaviour is untouched if nobody creates a group.

### P3 — The organization channel

The P3 migration, the singleton and its unique index, the broadcast job, reach classification and
the receipt UI, mention narrowing, the 200-Agent ceiling, the hourly throttle, the membership loss
path, cost roll-up on a post.

**Shippable because**: it is one additional Conversation kind. P1 and P2 do not reference it, and an
Organization that never posts to it sees no change.

---

## 12. Constitution compliance

| Gate | Status | Justification |
| --- | --- | --- |
| **I — Plugin-first** | ✅ | No external integration is added. Everything talks to Postgres, the existing job runtime and the existing model proxy. |
| **II — Capability-driven, no hardcoded plugin id** | ✅ | Provider and model resolution for a reply stays in `AgentRunService` and the existing facades; the Conversation layer passes an Agent id and never names a provider. |
| **III — Source-of-truth repositories** | ✅ | Conversations are platform metadata, not Work content. Nothing in this epic writes to a user repo. Referenced Knowledge Base documents are read through the existing resolver, which reads the repo-backed source. |
| **IV — Background work via the job runtime** | ✅ | Reply and broadcast dispatch go through `AGENT_CONVERSATION_REPLY_DISPATCHER` and `CONVERSATION_BROADCAST_DISPATCHER` DI symbols; no call site imports a runtime SDK. `POST` returns `202` and never blocks on delivery. |
| **V — Forward-only migrations** | ✅ | Three additive migrations under `apps/api/src/migrations/`, all `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`, each shipping in the same PR as its entity change. No drop, no rename, no retype. |
| **VI — Tests are a prerequisite** | ✅ | Nine agent-package unit specs, five controller specs, five web unit specs and ten e2e specs, enumerated in §10 and mapped to tasks. |
| **VII — Secret hygiene** | ✅ | `assertNoSecrets` runs on every message before storage; no body, mention or attachment name is logged; provider errors keep the existing redaction on the model proxy. |
| **VIII — Single source of truth for plugin lists** | ✅ | No plugin is added, so no count changes. |
| **IX — Behaviour-first spec** | ✅ | `spec.md` names no class, path or code; every implementation detail lives here. |
| **X — Backwards compatibility** | ✅ | Every existing endpoint keeps its current shape and behaviour with no new parameters supplied; every new field is nullable or defaulted; existing chat e2e specs pass unmodified. |

---

## 13. Cross-references

| Epic | Boundary |
| --- | --- |
| [AW-02 Mission board](../AW-02-mission-board/spec.md) | Owns the `Chat about it` menu item and its key `dashboard.missionsPage.menu.chat`; this epic owns the handler and the context chip. AW-02 explicitly defers all chat surfaces here. |
| [AW-06 Knowledge library](../AW-06-knowledge-library/spec.md) | Owns the `#` picker and reference resolution (its FR-49–FR-60). This epic consumes it in every conversation composer and keeps the existing reference syntax working until it lands. |
| [AW-01 Command palette](../AW-01-command-palette/spec.md) | Reaches Conversation **names**; full-text search over message bodies is explicitly out of scope in both epics. |
| [AW-09 Runs & receipts](../AW-09-runs-receipts/spec.md) | Owns the receipt every Agent message links to; this epic supplies the `conversationMessageId` link. |
| [AW-13 Attention controls](../README.md#3-epics) | Owns notification routing; this epic emits `NotificationCategory.CONVERSATION` events and implements no routing of its own. |
| [AW-17 Costs & caps](../README.md#3-epics) | Owns the cap that refuses a reply; this epic renders the refusal in the Conversation and names the rule. |
| [AW-18 Shared dashboards](../AW-18-shared-dashboards/spec.md) | Owns teammate access. Multi-person group Conversations are deferred to it. |
| [AW-23 Agent identity](../README.md#3-epics) | Owns Agent display names and avatars, which the mention picker and message attribution render. |
</content>
</invoke>
