# AW-12 — Chat, group conversations and the organization channel · Task breakdown

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-12-chat-channels`
**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Status:** `Draft` · **Last updated:** 2026-09-06

---

## How to use

- Tasks run **top to bottom**. A task marked `(parallel)` may run alongside the one before it.
- Every task names the files to create or modify and states what **done** means.
- Every task belongs to a phase: **P1** conversations, participants and the panel; **P2** groups and
  Agent-to-Agent; **P3** the organization channel. Each phase leaves `develop` green on its own.
- Add new tasks at the bottom rather than renumbering.
- Commands run from the repo root unless stated: `pnpm lint`, `pnpm type-check`, `pnpm test`,
  `pnpm build`. Migration authoring runs from `apps/api/`.
- **Hard rule for every task:** nothing existing is removed, renamed or retyped. The dead i18n keys
  `dashboard.aiChat.editMessage` / `saveEdit` / `cancelEdit` / `edited` stay exactly where they are.

---

# Phase P1 — Conversations, participants and the panel

## P1.1 — Data model

- [ ] **T1 · Shared types**
      Create `packages/agent/src/conversations/conversation.types.ts` with `ConversationKind`
      (`direct` / `group` / `organization_channel` / `agent_pair`), `ConversationMessageStatus`
      (`sending` / `sent` / `failed`), `ConversationAuthorType` (`user` / `agent` / `system`),
      `ConversationReachOutcome` (`delivered` / `queued` / `skipped` / `refused`),
      `ConversationReach`, and the numeric constants from the spec:
      `MAX_CONVERSATION_BODY_BYTES = 16 * 1024`, `MAX_MENTIONS_PER_MESSAGE = 10`,
      `MAX_ATTACHMENTS_PER_MESSAGE = 10`, `MAX_GROUP_AGENTS = 8`, `MAX_DISPATCH_PER_MESSAGE = 8`,
      `MAX_BROADCAST_AGENTS = 200`, `PROMOTION_CARRY_MESSAGES = 20`, `PROMOTION_CARRY_DAYS = 7`,
      `AGENT_PAIR_STREAK_CEILING = 20`, `AGENT_PAIR_DAILY_MESSAGE_CEILING = 200`,
      `CONVERSATION_NAME_MAX = 200`.
      **Done:** compiles; every constant carries a one-line comment naming the FR it implements.

- [ ] **T2 · Participant entity**
      Create `packages/agent/src/entities/conversation-participant.entity.ts` with
      `@Entity('conversation_participants')` and the columns in
      [plan §3.4](./plan.md#34-conversation_participants--the-one-new-table-p1): `id`,
      `conversationId` (FK `conversations.id`, `ON DELETE CASCADE`), `participantType`,
      `participantId`, `role`, `joinedAt`, `leftAt`, `lastReadMessageId`, `lastReadAt`, `mutedAt`,
      `tenantId`, `organizationId`, `createdAt`, `updatedAt`. Raw uuid columns for
      `participantId` — **no `@ManyToOne` to `User` or `Agent`** (the entity-cycle rule documented
      in `conversation.entity.ts`). Declare
      `@Index('uq_conversation_participants', [...], { unique: true })` and
      `@Index('idx_conversation_participants_target', [...])`.
      **Done:** compiles; the class doc comment states that the unique index is the mechanism that
      makes concurrent group promotion safe (spec FR-56).

- [ ] **T3 · Register the participant entity in all three registries**
      Modify `packages/agent/src/entities/index.ts` (add the `export *`),
      `packages/agent/src/database/_entity-names.ts` (insert `'ConversationParticipant'`
      alphabetically, beside the existing `'Conversation'` / `'ConversationMessage'` at line ~74),
      and `packages/agent/src/database/_entities-inventory.ts` (import at ~line 44, add to
      `ENTITIES` at ~line 195).
      **Done:** `packages/agent/src/database/database.module.spec.ts` passes.

- [ ] **T4 · Columns on `conversations`**
      Modify `packages/agent/src/entities/conversation.entity.ts`: add `kind` (varchar 24, not null,
      default `'direct'`), `agentId` (uuid, nullable), `titleSource` (varchar 8, nullable),
      `contextType` (varchar 16, nullable), `contextId` (uuid, nullable), `lastMessageAt`
      (nullable). Add the P1 indexes `idx_conversations_user_kind_activity` and
      `idx_conversations_agent_activity`.
      **Done:** compiles; `titleSource`'s comment explains that `'user'` permanently disables the
      automatic titling run by `conversation-title.service.ts` (spec FR-6), and no existing column
      is touched.

- [ ] **T5 · Columns on `conversation_messages`**
      Modify `packages/agent/src/entities/conversation-message.entity.ts`: add `authorType`
      (varchar 8, not null, default `'user'`), `authorId` (uuid, nullable), `mentions`
      (simple-json, nullable — reuse the `TaskChatMention` shape from
      `packages/agent/src/entities/task-chat-message.entity.ts`), `attachments` (simple-json,
      nullable), `status` (varchar 8, not null, default `'sent'`), `failureCode` (varchar 40,
      nullable), `clientMessageId` (varchar 64, nullable), `replyToMessageId` (uuid, nullable). Add
      `idx_conversation_messages_status` and the partial unique
      `uq_conversation_messages_client_id`.
      **Done:** compiles; the existing `role` column keeps its meaning and its comment now says
      `role` describes what the model sees while `authorType` describes who wrote it.

- [ ] **T6 · Column on `agent_runs` + trigger kind**
      Modify `packages/agent/src/entities/agent-run.entity.ts`: add `conversationMessageId` (uuid,
      nullable, FK `conversation_messages.id`, `ON DELETE SET NULL`) with index
      `idx_agent_runs_conversation_message`, and widen the `AgentRunTriggerKind` union with
      `'conversation'`.
      **Done:** compiles; the column comment states it is populated only when
      `triggerKind = 'conversation'` and explains why `chatMessageId` (an FK to
      `task_chat_messages`) could not be reused.

- [ ] **T7 · Migration — SAME PR as T2–T6 (Constitution V)**
      Create `apps/api/src/migrations/1791120000000-AddConversationKindAndParticipants.ts`.
      `up()`: `ADD COLUMN` for every field in T4/T5/T6, `CREATE TABLE conversation_participants`,
      every P1 index, then the backfill — one `owner` participant row per existing conversation
      from its `userId`; `lastMessageAt = (SELECT MAX("createdAt") FROM conversation_messages …)`;
      `titleSource = 'auto'` where `metadata` records an AI title. `down()` reverses in reverse
      order.
      **Done:** generated with `pnpm typeorm migration:generate -d typeorm.config.ts` from
      `apps/api/`, reviewed to contain no `DROP COLUMN`, no rename and no retype in `up()`, and the
      API boots clean against a database seeded from `develop`.

- [ ] **T8 · Participant repository**
      Create `packages/agent/src/database/repositories/conversation-participant.repository.ts` —
      `listForConversation`, `listConversationsFor(participantType, participantId)`,
      `addIfAbsent` (catching the unique-constraint violation and returning the existing row),
      `markLeft`, `markRead`, `countActiveAgents`. Export from
      `packages/agent/src/database/index.ts` and add to
      `packages/agent/src/database/_repository-inventory.ts`.
      **Done:** the repository-inventory drift spec passes.

- [ ] **T9 · Extend the conversation repository**
      Modify `packages/agent/src/database/repositories/conversation.repository.ts`: add `kind`,
      `agentId`, `archived`, `contextType`/`contextId` filters to `findByUser`; add
      `findByIdForParticipant`, `touchLastMessageAt`, `setName(id, name | null)`,
      `unreadCountsFor(userId, conversationIds)`, `findMessagesPaged(conversationId, limit, before)`
      and `findByClientMessageId`. Do not change any existing signature.
      **Done:** existing callers compile unchanged; new methods have unit coverage in T35.

## P1.2 — Domain services

- [ ] **T10 · Domain module skeleton**
      Create `packages/agent/src/conversations/index.ts` and
      `packages/agent/src/conversations/conversations.module.ts`, modelled on
      `packages/agent/src/tasks-domain/tasks.module.ts`. Add a `./conversations` subpath to
      `packages/agent/package.json` `exports`, beside the existing `./tasks-domain` entry.
      **Done:** `turbo build --filter=@ever-works/agent` emits `dist/conversations/index.js` and
      `.d.ts`.

- [ ] **T11 · Mention service**
      Create `packages/agent/src/conversations/conversation-mention.service.ts`. Port the parser
      shape from `packages/agent/src/tasks-domain/task-chat.service.ts` (`MENTION_RE`, the
      `MentionLookups` contract, the resolve-then-strip rule) and extend it: full display-name
      matching including multi-word names, case-insensitive, never prefix; per-kind candidate sets;
      the 10-mention cap; and `resolveCandidates(query, conversationId, viewerId)` returning at most
      8 ranked candidates for the picker.
      **Done:** unresolved tokens are absent from the agent-visible body and present verbatim in the
      stored body; an Agent the viewer cannot see returns exactly the same result as a name that
      does not exist (spec FR-96).

- [ ] **T12 · Conversation service**
      Create `packages/agent/src/conversations/conversation.service.ts` — `create` (kind rules,
      participant seeding, context validation), `rename(id, name | null)` with the 200-character cap
      and `titleSource` handling, `get` / `list` scoped through `ownershipWhere` from
      `packages/agent/src/database/ownership-scope.ts`, `markRead`, and `assertParticipant` that
      throws `NotFoundException` (never `Forbidden`) for a non-participant (spec FR-95).
      **Done:** unit-covered by T35; a cross-user read returns 404-shaped behaviour.

- [ ] **T13 · Message service**
      Create `packages/agent/src/conversations/conversation-message.service.ts` — `post()` running
      the pipeline in [plan §2.3](./plan.md#23-the-addressing-pipeline-the-core-of-the-epic):
      `assertNoSecrets` (from `packages/agent/src/utils/secret-scan.ts`) → 16 KB cap → mention
      resolve → persist with `clientMessageId` → dispatch. Plus `retry(messageId)` (only from
      `failed`), `discard(messageId)` (only from `failed`), and `appendAgentMessage()` used by the
      reply job.
      **Done:** posting the same `clientMessageId` twice returns the first message and creates no
      second row; a body over 16 KB and a body containing a credential are both rejected before
      insert.

- [ ] **T14 · Dispatch service**
      Create `packages/agent/src/conversations/conversation-dispatch.service.ts` implementing the
      reply contract (spec FR-87–FR-93): direct → the addressed Agent; group/channel with mentions →
      exactly those; group without mentions → all addressable, each deciding; duplicate mentions →
      one dispatch; live-run steering through `RUN_STEERING_PORT`; admission through
      `RunDispatchGateService`; the 8-dispatch ceiling; and the reach classification returned to the
      caller.
      **Done:** every branch is unit-covered in T36, and no code path in this service imports a
      job-runtime SDK.

- [ ] **T15 · Dispatcher ports**
      Create `packages/agent/src/conversations/conversation-dispatcher.ts` — a **leaf** file with no
      service imports, mirroring `packages/agent/src/tasks-domain/task-dispatcher.ts`. Export
      `AGENT_CONVERSATION_REPLY_DISPATCHER` and `CONVERSATION_BROADCAST_DISPATCHER` plus their
      payload interfaces.
      **Done:** the file imports nothing from `packages/agent/src/conversations/*.service.ts`, and
      its doc comment states why `AGENT_CHAT_REPLY_DISPATCHER` was not widened.

## P1.3 — Job runtime (Constitution IV)

- [ ] **T16 · Reply job**
      Create `packages/tasks/src/tasks/trigger/agent-conversation-reply.task.ts`, modelled on
      `agent-chat-reply.task.ts` in the same folder: resolve the Conversation and the triggering
      message, build the Agent's context (recent messages, resolved document references, the
      attached context object), execute through `AgentRunService`, and append the reply through
      `appendAgentMessage` with `authorType='agent'` and `replyToMessageId` set. Register it in
      `packages/tasks/src/tasks/trigger/index.ts`.
      **Done:** a reply produces an `AgentRun` with `triggerKind='conversation'` and
      `conversationMessageId` populated.

- [ ] **T17 · Trigger adapter**
      Create `packages/tasks/src/dispatchers/conversation-dispatchers.ts` exporting
      `agentConversationReplyTriggerAdapter` (and, in P3, `conversationBroadcastTriggerAdapter`),
      mirroring `packages/tasks/src/dispatchers/agent-task-dispatchers.ts`, including its
      throw-not-swallow behaviour when the runtime is unconfigured.
      **Done:** a companion spec `conversation-dispatchers.spec.ts` asserts the unconfigured case
      rejects rather than resolving.

- [ ] **T18 · Bind the port**
      Modify `apps/api/src/tasks/tasks.module.ts`: add
      `{ provide: AGENT_CONVERSATION_REPLY_DISPATCHER, useValue: agentConversationReplyTriggerAdapter }`
      to `providers` beside the existing `AGENT_CHAT_REPLY_DISPATCHER` binding (~line 162), and add
      the symbol to `exports` (~line 189).
      **Done:** `apps/api/src/tasks/tasks.module.di-contract.spec.ts` is extended and passes.

## P1.4 — API

- [ ] **T19 · DTOs**
      Create `apps/api/src/ai-conversation/dto/conversation.dto.ts` with
      `ListConversationsQueryDto`, `CreateConversationDto` (moved out of the controller and
      extended), `UpdateConversationDto` (`title: string | null`; `providerId` still absent from the
      whitelist), `PostConversationMessageDto`, `MarkReadDto`, `MentionCandidatesQueryDto`. Every
      string field carries an explicit `@MaxLength`.
      **Done:** `apps/api/src/ai-conversation/update-conversation.dto.spec.ts` is extended and
      passes, including a case asserting that sending `providerId` is still a 400.

- [ ] **T20 · Contracts package**
      Create `packages/contracts/src/conversations/conversation.types.ts` and `index.ts`, exported
      from `packages/contracts/src/index.ts`, alongside the existing `inbox/` and `hitl/` folders.
      **Done:** `turbo build --filter=@ever-works/contracts` is clean and the web app can import the
      response types.

- [ ] **T21 · Extend the conversation controller**
      Modify `apps/api/src/ai-conversation/conversation.controller.ts` per
      [plan §4.1](./plan.md#41-extended--conversationcontrollerts) and
      [§4.2](./plan.md#42-new--messages-retry-read-state): new optional query params on `GET`, new
      optional body fields on `POST`, `title: null` on `PATCH`, the new response fields, and the new
      routes `GET /:id/messages`, `POST /:id/messages/:messageId/retry`,
      `DELETE /:id/messages/:messageId`, `POST /:id/read`, `GET /mention-candidates`. Keep
      `MAX_CONVERSATIONS_PAGE_SIZE = 200`; put `@Throttle({ long: { limit: 30, ttl: 60_000 } })` on
      every write.
      **Done:** every existing e2e spec under `apps/web/e2e/` matching `conversations*` and `chat*`
      passes **unmodified**.

- [ ] **T22 · Participants controller (read side)**
      Create `apps/api/src/ai-conversation/conversation-participants.controller.ts` with
      `GET /api/conversations/:id/participants` only. The write routes land in P2.
      **Done:** registered in `apps/api/src/ai-conversation/ai-conversation.module.ts`; a
      non-participant caller gets 404.

- [ ] **T23 · SSE controller**
      Create `apps/api/src/ai-conversation/conversation-stream.controller.ts` implementing
      `GET /api/conversations/stream?conversationId=`, copied in shape from
      `apps/api/src/email/email.controller.ts` lines ~167–250: `text/event-stream` headers, prime-
      then-diff so the backlog is not announced, 5 s poll, 15 s heartbeat comment, 10-minute forced
      lifetime with full timer cleanup, every error swallowed.
      **Done:** the route is declared **before** any `:id` route so it is not captured, and closing
      the client clears both timers.

- [ ] **T24 · Wire the module**
      Modify `apps/api/src/ai-conversation/ai-conversation.module.ts`: import the new agent-package
      `ConversationsModule`, register the three controllers, keep `OpenAiCompatService` exported
      unchanged.
      **Done:** `apps/api/src/api.module.ts` needs no change (the module is already registered at
      line ~166) and the API boots.

## P1.5 — Web

- [ ] **T25 · API client + server actions**
      Modify `apps/web/src/lib/api/conversations.ts` to add a method per new endpoint, leaving every
      existing signature untouched. Create `apps/web/src/app/actions/conversations.ts` wrapping
      them, matching the existing `apps/web/src/app/actions/*` pattern.
      **Done:** `pnpm type-check` clean; no existing caller changed.

- [ ] **T26 · Panel router and header**
      Create `apps/web/src/components/ai/conversations/ConversationPanelRouter.tsx` and
      `ConversationHeader.tsx`. Modify `apps/web/src/components/ai/ChatPanel.tsx` to render the
      router, and `apps/web/src/components/ai/ChatInterface.tsx` to accept a `conversationId` and
      `kind`. Extend `apps/web/src/components/ai/ChatProvider.tsx` with the view stack and the
      active participant.
      **Done:** navigating five dashboard routes never unmounts the panel, and only the close
      control closes it (spec FR-13).

- [ ] **T27 · Conversation list and switcher**
      Create `apps/web/src/components/ai/conversations/ConversationListPanel.tsx` and
      `ParticipantSwitcher.tsx`, with the loading, empty and error states from
      [spec §6.2](./spec.md#62-the-docked-panel--an-agents-conversation-list). Leave
      `apps/web/src/components/ai/ChatHistory.tsx` untouched — it stays as the flat all-conversation
      list.
      **Done:** a named Conversation renders bold-name-over-preview; an unnamed one renders the
      preview alone; no row reads "Untitled".

- [ ] **T28 · Name control**
      Create `apps/web/src/components/ai/conversations/ConversationNameDialog.tsx` with the
      200-character counter and the clear-to-revert hint.
      **Done:** setting a name survives reload and stops automatic re-titling; clearing it restores
      the preview.

- [ ] **T29 · Mention picker and highlight layer**
      Create `apps/web/src/components/ai/conversations/MentionPicker.tsx` (keyboard model copied
      from `apps/web/src/components/skills/SlashCommandAutocomplete.tsx`) and
      `ComposerHighlightLayer.tsx` (the `aria-hidden`, pointer-events-none overlay described in
      [plan §5.1 D6](./plan.md#51-new-components--appswebsrccomponentsaiconversations-new-folder)).
      Create `apps/web/src/lib/hooks/use-mention-candidates.ts`. Modify
      `apps/web/src/components/ai/ChatInput.tsx` to mount both and add the 16 KB pre-send guard.
      **Done:** the textarea is still uncontrolled; only server-confirmed tokens are highlighted; a
      non-matching `@` word never highlights.

- [ ] **T30 · Outbox, failure and retry**
      Create `apps/web/src/lib/hooks/use-conversation-outbox.ts` (client id generation, optimistic
      insert, failed-message persistence under `localStorage['chat-outbox']`, Retry / Discard) and
      `apps/web/src/components/ai/conversations/MessageRetryBar.tsx` with the reason copy from
      [spec §6.10](./spec.md#610-failed-send-and-retry).
      **Done:** a failed message survives reload; two fast Retries produce exactly one delivered
      message; the composer text is never lost on a refusal.

- [ ] **T31 · Live delivery**
      Create `apps/web/src/lib/hooks/use-conversation-stream.ts`, modelled on
      `apps/web/src/lib/hooks/use-inbox-stream.ts`: `EventSource` with a 30-second poll fallback and
      no user-visible error on the downgrade.
      **Done:** a message posted in a second browser context appears within 5 seconds; blocking the
      stream degrades silently to polling.

- [ ] **T32 · Panel resize affordances**
      Modify `apps/web/src/lib/hooks/use-chat-panel.tsx` and
      `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`: add double-click-to-reset (420 px)
      on the drag handle and keyboard resize (`←`/`→` by 16 px, `Home` resets) when the handle has
      focus. **Do not touch** the existing clamp `Math.max(350, Math.min(maxWidth, pointerWidth))`
      (~line 346) or the `chat-width` / `chat-panel-open` persistence.
      **Done:** width still restores with no visible reflow on first paint, and the handle is
      reachable by `Tab` with an accessible name.

- [ ] **T33 · Entry points**
      Wire `Chat about it` on Mission cards (the menu item and its key
      `dashboard.missionsPage.menu.chat` are owned by [AW-02](../AW-02-mission-board/spec.md)) to
      open the docked panel with `contextType='mission'`, and add a `Message <agent>` action on
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`.
      **Done:** both open the panel in place without navigating, and the context chip renders in the
      header.

## P1.6 — i18n

- [ ] **T34 · Message keys**
      Add the `conversations`, `panel`, `mentions` and `sendFailure` blocks from
      [plan §8](./plan.md#8-i18n) to `dashboard.aiChat` in `apps/web/messages/en.json`, then mirror
      the same keys with English values into the 20 sibling locale files in `apps/web/messages/`.
      **Every leaf name is camelCase and contains no literal dot.**
      **Done:** `pnpm test` passes including the i18n key-shape checks, and no rendered surface shows
      a raw key.

## P1.7 — Tests

- [ ] **T35 · Agent-package unit specs**
      Create `packages/agent/src/conversations/__tests__/conversation-mention.service.spec.ts`,
      `conversation.service.spec.ts`, `conversation-message.service.spec.ts`, and
      `packages/agent/src/database/repositories/conversation.repository.spec.ts` +
      `conversation-participant.repository.spec.ts`.
      **Done:** covers spec FR-1..FR-12, FR-25..FR-48 and FR-94..FR-97 as listed in
      [plan §10.1](./plan.md#101-unit--agent-package-jest).

- [ ] **T36 · Dispatch unit spec**
      Create `packages/agent/src/conversations/__tests__/conversation-dispatch.spec.ts`.
      **Done:** asserts mention → dispatch, duplicate mention → one dispatch, live-run steering,
      the 8-dispatch ceiling, and every reach outcome including `queued` with its reason.

- [ ] **T37 · Controller specs**
      Extend `apps/api/src/ai-conversation/conversation.controller.spec.ts`; create
      `conversation-stream.controller.spec.ts` and `conversation.controller.scope.spec.ts` (the
      latter modelled on `apps/api/src/tasks/task-chat.controller.scope.spec.ts`).
      **Done:** cross-scope reads return 404; the SSE handler sets the right headers and clears both
      timers on close.

- [ ] **T38 · Web unit specs**
      Create `apps/web/src/components/ai/conversations/MentionPicker.unit.spec.tsx`,
      `ComposerHighlightLayer.unit.spec.tsx`, `MessageRetryBar.unit.spec.tsx`; extend
      `apps/web/src/components/ai/ChatProvider.unit.spec.ts`.
      **Done:** all pass under the web app's Vitest runner.

- [ ] **T39 · P1 e2e**
      Create `apps/web/e2e/flow-conversation-naming.spec.ts`,
      `flow-conversation-panel-navigation.spec.ts`, `flow-conversation-mentions.spec.ts`,
      `flow-conversation-send-retry.spec.ts`.
      **Done:** green, **and** every pre-existing spec matching `chat*` / `conversations*` /
      `flow-chat*` / `flow-conversation*` still passes unmodified.

---

# Phase P2 — Groups and Agent-to-Agent

## P2.1 — Data model

- [ ] **T40 · Columns for groups and pairs**
      Modify `packages/agent/src/entities/conversation.entity.ts`: add `archivedAt` (nullable),
      `linkedConversationId` (uuid, nullable, FK `conversations.id`, `ON DELETE SET NULL`),
      `pausedReason` (varchar 32, nullable), `agentMessageStreak` (int, not null, default 0).
      **Done:** compiles; `agentMessageStreak`'s comment states it is reset by any message with
      `authorType='user'`.

- [ ] **T41 · Migration — SAME PR as T40**
      Create `apps/api/src/migrations/1791120100000-AddConversationGroupsAndPeers.ts`: `ADD COLUMN`
      for the four fields, the self-FK, and the index refresh on
      `idx_conversations_user_kind_activity` to include `archivedAt`.
      **Done:** additive only; `down()` drops in reverse order; the API boots against a P1 database.

## P2.2 — Domain services

- [ ] **T42 · Promotion service**
      Create `packages/agent/src/conversations/conversation-promotion.service.ts`: create the group,
      seed participants, copy the last `PROMOTION_CARRY_MESSAGES` messages bounded by
      `PROMOTION_CARRY_DAYS`, set `linkedConversationId` on **both** rows, and leave the originating
      Conversation untouched. On a unique-constraint violation from
      `ConversationParticipantRepository.addIfAbsent`, load and return the winning group instead of
      failing.
      **Done:** two concurrent promotions produce exactly one group (spec FR-56); the original keeps
      every message it had.

- [ ] **T43 · Group membership and naming**
      Extend `conversation.service.ts` with `addAgent` / `removeAgent` (setting `leftAt`, never
      deleting), the 8-Agent cap, the participant-derived name used when `title` is null, and the
      archive / restore transitions with their refusals for `organization_channel` and `agent_pair`.
      **Done:** removing an Agent preserves its messages; restore touches no timestamp, so the row
      returns to its activity position (spec FR-59).

- [ ] **T44 · The "nobody added" outcome**
      Extend `conversation-dispatch.service.ts`: when an unmentioned group message produces zero
      replies, record a `system`-authored message carrying the neutral line rather than an error or
      an empty state.
      **Done:** the surface shows the line, no notification fires, and no run is created.

- [ ] **T45 · Agent-pair service**
      Create `packages/agent/src/conversations/agent-peer-conversation.service.ts`:
      `openPair(initiatingAgentId, targetAgentId)` gated on
      `AgentCollaboratorRepository` (`packages/agent/src/database/repositories/agent-collaborator.repository.ts`)
      with `enabled = true`; one Conversation per unordered pair; the
      `AGENT_PAIR_STREAK_CEILING` pause and its reset on a person's post; the
      `AGENT_PAIR_DAILY_MESSAGE_CEILING` computed as a `COUNT` at post time; and the
      Organization-level on/off flag.
      **Done:** a non-collaborator attempt creates no row and is recorded against the initiating
      run, not surfaced as a person-facing error (spec S-27).

- [ ] **T46 · Agent tool surface**
      Expose the pair-open and pair-post operations to Agents through the existing agent tool
      registration path used by `packages/agent/src/tasks-domain/agent-task-tools.ts`, with the same
      secret-scan and size caps.
      **Done:** an Agent calling the tool for a non-collaborator receives a refusal string, never an
      exception that fails the run.

## P2.3 — API

- [ ] **T47 · Participant write routes**
      Extend `apps/api/src/ai-conversation/conversation-participants.controller.ts` with `POST`
      and `DELETE` for participants, `POST /:id/promote`, `POST /:id/archive`,
      `POST /:id/restore`. `409` at the 8-Agent cap; `409` on archiving a channel or a pair.
      **Done:** covered by T55.

- [ ] **T48 · Agent-pair routes**
      Extend `apps/api/src/ai-conversation/conversation-channel.controller.ts` (create it in this
      phase) with `GET /api/conversations/agent-pairs`,
      `GET /api/conversations/agent-pairs/:pairId`, and
      `POST /api/conversations/agent-pairs/:pairId/messages`. All three call
      `OrganizationMembershipService.ensureMember` from
      `apps/api/src/organizations/organization-membership.service.ts` first.
      **Done:** a caller outside the Organization gets 404, not 403.

- [ ] **T49 · Organization setting**
      Add the `agentPeerConversationsEnabled` flag to the Organization settings surface, defaulting
      to enabled, alongside the existing organization settings page under
      `apps/web/src/app/[locale]/(dashboard)/settings/organization/`.
      **Done:** disabling it stops new pairs being created; existing pairs stay readable.

## P2.4 — Web

- [ ] **T50 · Sidebar section**
      Create `apps/web/src/components/ai/conversations/ConversationsSidebarSection.tsx` and mount it
      in `apps/web/src/components/dashboard/DashboardSidebar.tsx` beneath the fixed nav array.
      **Do not modify the nav array itself.**
      **Done:** groups sort by recency, `Archived (N)` sits at the bottom, and the collapsed sidebar
      mode renders the section as icons with tooltips like every other entry.

- [ ] **T51 · Group interior**
      Create `apps/web/src/components/ai/conversations/GroupMembersMenu.tsx` and the group header
      variants — rename, add / remove an Agent, archive, the carried-history notice, the
      continued-from link, and the archived read-only banner.
      **Done:** matches [spec §6.8](./spec.md#68-group-conversation) including the archived state.

- [ ] **T52 · Agent-pair surfaces**
      Create `apps/web/src/components/ai/conversations/AgentPairList.tsx` and `AgentPairView.tsx`
      with the empty state, the paused state and the person's attributed message.
      **Done:** matches [spec §6.9](./spec.md#69-agent-conversations-agent-to-agent).

- [ ] **T53 · Promotion affordance**
      Extend `MentionPicker` and the pre-send hints so that mentioning a second Agent inside a
      `direct` Conversation shows the "will start a group conversation" hint before sending.
      **Done:** the hint names the resulting participants and is non-blocking.

## P2.5 — i18n and tests

- [ ] **T54 · Message keys**
      Add the `groups` and `agentPairs` blocks from [plan §8](./plan.md#8-i18n) to
      `dashboard.aiChat` in `apps/web/messages/en.json` and the 20 sibling locale files. Leaf names
      camelCase, no literal dot.
      **Done:** no raw keys render on the group or pair surfaces.

- [ ] **T55 · Unit and controller specs**
      Create `packages/agent/src/conversations/__tests__/conversation-promotion.service.spec.ts` and
      `agent-peer-conversation.service.spec.ts`; create
      `apps/api/src/ai-conversation/conversation-participants.controller.spec.ts`.
      **Done:** covers spec FR-49..FR-62 and FR-77..FR-86.

- [ ] **T56 · P2 e2e**
      Create `apps/web/e2e/flow-conversation-group-promotion.spec.ts`,
      `flow-conversation-archive-restore.spec.ts`, `flow-agent-peer-conversations.spec.ts`.
      **Done:** green, and the P1 specs still pass.

---

# Phase P3 — The organization channel

## P3.1 — Data model

- [ ] **T57 · Reach column and the singleton constraint**
      Modify `packages/agent/src/entities/conversation-message.entity.ts` to add `reach`
      (simple-json, nullable, typed `ConversationReach[]`), and
      `packages/agent/src/entities/conversation.entity.ts` to declare the partial unique index
      `uq_conversations_org_channel` on `(organizationId)` where `kind = 'organization_channel'`.
      **Done:** compiles; the index comment states that it, not a service-layer check, is what makes
      the channel a singleton under concurrent first use (spec FR-63).

- [ ] **T58 · Migration — SAME PR as T57**
      Create `apps/api/src/migrations/1791120200000-AddConversationChannelReach.ts`: `ADD COLUMN
      reach`, `CREATE UNIQUE INDEX … WHERE kind = 'organization_channel'`.
      **Done:** additive only; the index creation is guarded so an existing duplicate (impossible by
      construction, but checked) fails loudly at migration time rather than silently.

## P3.2 — Domain and job runtime

- [ ] **T59 · Broadcast service**
      Create `packages/agent/src/conversations/conversation-broadcast.service.ts` —
      `resolveOrCreateChannel(organizationId)`, `post()` returning as soon as the message is stored,
      the 200-Agent refusal, mention narrowing, and the reach classifier that maps every addressable
      Agent to `delivered` / `queued` / `skipped` / `refused` with its reason.
      **Done:** classification is a pure function keyed on `(messageId, agentId)` so a re-run of the
      broadcast job produces identical reach.

- [ ] **T60 · Broadcast job**
      Create `packages/tasks/src/tasks/trigger/conversation-broadcast.task.ts`: enumerate
      addressable Agents, enqueue at most `MAX_DISPATCH_PER_MESSAGE` reply dispatches immediately,
      record the rest as `queued`, then write the `reach` column **once** at the end. Register in
      `packages/tasks/src/tasks/trigger/index.ts`. Add
      `conversationBroadcastTriggerAdapter` to `packages/tasks/src/dispatchers/conversation-dispatchers.ts`
      and bind `CONVERSATION_BROADCAST_DISPATCHER` in `apps/api/src/tasks/tasks.module.ts`.
      **Done:** the DI-contract spec is extended; re-running the job dispatches no Agent twice
      (dedup keys are stable).

## P3.3 — API

- [ ] **T61 · Channel routes**
      Extend `apps/api/src/ai-conversation/conversation-channel.controller.ts` with
      `GET /api/conversations/organization-channel`,
      `POST /api/conversations/organization-channel/messages`
      (`@Throttle({ long: { limit: 10, ttl: 3_600_000 } })`), and
      `GET /api/conversations/:id/messages/:messageId/reach`.
      **Done:** the post returns `202` before delivery completes; no Organization returns 404; a
      removed member returns 404 with the membership-loss body.

## P3.4 — Web

- [ ] **T62 · Channel view**
      Create `apps/web/src/components/ai/conversations/OrganizationChannelView.tsx` — the pinned
      row, the subtitle, the composer placeholder, the no-Organization state, the over-limit
      refusal, the membership-loss state that preserves the composer text.
      **Done:** matches [spec §6.7](./spec.md#67-the-organization-channel) in every state.

- [ ] **T63 · Reach receipt**
      Create `apps/web/src/components/ai/conversations/ReachReceipt.tsx` — the collapsed summary
      count, the grouped expansion, the narrowed-post variant, the zero-Agent variant with its link
      to the Agents list.
      **Done:** the summary is readable without expanding (spec FR-70), and the groups render in the
      order delivered → queued → skipped → refused.

- [ ] **T64 · Cost roll-up**
      Show the running total cost of the executions a channel post caused, linking each Agent reply
      to its run receipt (program rule #9, spec FR-107/108).
      **Done:** the total updates as replies complete, and each Agent message links to its receipt.

## P3.5 — Telemetry, i18n and tests

- [ ] **T65 · Activity and notification members**
      Append `CONVERSATION_CREATED`, `CONVERSATION_RENAMED`, `CONVERSATION_ARCHIVED`,
      `CONVERSATION_RESTORED`, `CONVERSATION_MESSAGE_POSTED`, `CONVERSATION_BROADCAST_SENT` to
      `ActivityActionType` in `packages/agent/src/entities/activity-log.types.ts`, and
      `CONVERSATION = 'conversation'` to `NotificationCategory` in
      `packages/agent/src/entities/notification.types.ts`. Emit them from
      `conversation.service.ts`, `conversation-message.service.ts` and
      `conversation-broadcast.service.ts`.
      **Done:** **no migration is needed** (both columns are plain `varchar`), and no emitted detail
      payload contains a message body, a mention name or an attachment filename.

- [ ] **T66 · Mention notification**
      Emit a `NotificationCategory.CONVERSATION` notification only when a person is mentioned by
      name in a group or the channel (spec FR-104), via
      `packages/agent/src/notifications/notification.service.ts`. Implement **no** routing,
      batching or suppression — that belongs to AW-13.
      **Done:** an Agent reply in the Conversation the person is viewing produces no notification.

- [ ] **T67 · Message keys**
      Add the `orgChannel` and `reach` blocks from [plan §8](./plan.md#8-i18n) to
      `dashboard.aiChat` in `apps/web/messages/en.json` and the 20 sibling locale files. Leaf names
      camelCase, no literal dot.
      **Done:** every state in spec §6.7 renders translated copy.

- [ ] **T68 · Unit and controller specs**
      Create `packages/agent/src/conversations/__tests__/conversation-broadcast.service.spec.ts` and
      `apps/api/src/ai-conversation/conversation-channel.controller.spec.ts`.
      **Done:** covers spec FR-63..FR-76, including the 200-Agent refusal, the zero-Agent receipt,
      the queued classification under a saturated concurrency valve, and idempotent job re-run.

- [ ] **T69 · P3 e2e**
      Create `apps/web/e2e/flow-organization-channel-broadcast.spec.ts`,
      `flow-organization-channel-reach.spec.ts`, `conversations-participants-api.spec.ts`.
      **Done:** green, and every P1 and P2 spec still passes.

---

## Cross-cutting closing tasks

- [ ] **T70 · Documentation**
      Add a short "Conversations" page under `docs/` describing the four Conversation kinds, the
      addressing rule and the routing guidance ("direction goes in a Conversation, decisions go to
      My Decisions, announcements go to the organization channel; anything that should outlive the
      conversation belongs in the Knowledge Base"), and list it in
      `apps/docs/sidebarsPlatform.ts` so it is not an orphan page.
      **Done:** the docs site builds and the page appears in the nav.

- [ ] **T71 · Program bookkeeping**
      Update `docs/specs/features/agent-workspace/TRACKER.md` (the AW-12 spec and implementation
      columns) and add **Conversation participant** to the vocabulary table in
      `docs/specs/features/agent-workspace/README.md` §1, as required by program rule #2 — a new
      entity must be added to that table in the same change that introduces it.
      **Done:** the tracker and the vocabulary table agree with this epic.

- [ ] **T72 · Full-suite gate**
      Run `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` from the repo root, plus the
      full `apps/web/e2e/` suite.
      **Done:** green, with no pre-existing chat or conversation spec modified to make it pass.
</content>
</invoke>
