# Task Breakdown: AI Conversation

**Feature ID**: `ai-conversation`
**Plan**: `./plan.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## How to use

This document is a retrospective task list — every shipped task below
links to the merged PR or the source path. Outstanding follow-ups
(open questions in `spec.md` §8 plus deferred coverage gaps) are
listed at the bottom of the file as `T30`+.

## Phase 1 — Data model & contracts (shipped)

- [x] **T1**. `Conversation` entity at
      [`packages/agent/src/entities/conversation.entity.ts`](../../../../packages/agent/src/entities/conversation.entity.ts)
    - `(userId, updatedAt)` composite index, `userId` standalone
      index, `ON DELETE CASCADE` from `users`.
- [x] **T2**. `ConversationMessage` entity at
      [`packages/agent/src/entities/conversation-message.entity.ts`](../../../../packages/agent/src/entities/conversation-message.entity.ts)
    - `(conversationId, createdAt)` composite + `conversationId`
      standalone index, `ON DELETE CASCADE` from `conversations`.
    - `parts` and `usage` columns are `simple-json`.
- [x] **T3**. Forward-only TypeORM migration under
      `apps/api/src/database/migrations/` adding both tables.
- [x] **T4**. OpenAI-compat DTOs at
      [`apps/api/src/ai-conversation/dto/openai-compat.dto.ts`](../../../../apps/api/src/ai-conversation/dto/openai-compat.dto.ts)
    - Includes `OpenAiFunctionDto`, `OpenAiToolDefinitionDto`,
      `OpenAiMessageDto`, `OpenAiChatCompletionRequestDto`, plus the
      response interfaces `OpenAiToolCallResponse`,
      `OpenAiChatCompletionResponse`,
      `OpenAiChatCompletionChunkResponse`.
    - Permissive: `@Allow()` on free-form fields (`tool_calls`,
      `tool_choice`, `response_format`, `parameters`,
      `stream_options`) so the controller's
      `ValidationPipe({whitelist:true})` can strip without rejecting.

## Phase 2 — Repository layer (shipped)

- [x] **T5**. `ConversationRepository` at
      [`packages/agent/src/database/repositories/conversation.repository.ts`](../../../../packages/agent/src/database/repositories/conversation.repository.ts)
    - `create({userId, title?, providerId?, model?})`
    - `findById(id, userId?)` — relations: `messages`, ordered
      `ASC` by `createdAt`.
    - `findByUser(userId, {limit, offset})` — selects only
      `id, title, providerId, model, createdAt, updatedAt`,
      defaults `limit=50`, `offset=0`, ordered `updatedAt DESC`,
      returns `{conversations, total}`.
    - `appendMessage(input)` — creates+saves one message, touches
      conversation `updatedAt`.
    - `appendMessages(inputs)` — sequential save with explicit
      `createdAt = new Date(baseTime + i)`, then touches
      conversation `updatedAt`. Empty input → `[]` no-op.
    - `updateTitle(id, userId, title, metadata?)` — composite-key
      update so cross-user updates can't happen.
    - `delete(id, userId)` — `(id, userId)` composite delete,
      returns `affected > 0`.
    - `deleteAllByUser(userId)` — returns `affected ?? 0`.
- [x] **T6**. Wire `ConversationRepository` into
      `@ever-works/agent/database` (already present in the
      `DatabaseModule` exports via the entities + repos barrel).

## Phase 3 — Title-generation service (shipped)

- [x] **T7**. `ConversationTitleService` at
      [`apps/api/src/ai-conversation/conversation-title.service.ts`](../../../../apps/api/src/ai-conversation/conversation-title.service.ts)
    - `maybeGenerateTitle(conversationId, userId)` — gated on
      `messageCount >= 4 && !metadata.aiTitle`.
    - Summarises last 4 user/assistant messages, each truncated to
      200 chars; system prompt _"Generate a short title (max 50
      chars)…"_; `temperature: 0.3`, `maxTokens: 30`.
    - Persists the trimmed AI response truncated to 100 chars with
      `metadata: {aiTitle: true}`.
    - Catches every failure path with `logger.debug`.
    - `extractMessageText` falls back to `parts[].text` when
      `content` is empty.
    - `resolveFacadeOptions(userId)` — `findByUser` first work
      fallback, swallows repo errors.

## Phase 4 — Conversation REST surface (shipped)

- [x] **T8**. `ConversationController` at
      [`apps/api/src/ai-conversation/conversation.controller.ts`](../../../../apps/api/src/ai-conversation/conversation.controller.ts)
    - `GET /api/conversations` — list with `limit?`, `offset?`
      `parseInt(_, 10)`.
    - `POST /api/conversations` — create with optional `title`,
      `providerId`.
    - `GET /api/conversations/:id` — read, 404 on missing /
      cross-user.
    - `PATCH /api/conversations/:id` — rename, 204, 404 on
      missing.
    - `POST /api/conversations/:id/messages` — append messages,
      derive first-message title (`/\s+/g, ' '` collapse + trim +
      60-char cap with `...` suffix), fire-and-forget AI title.
    - `DELETE /api/conversations/:id` — delete one (204), 404 on
      missing.
    - `DELETE /api/conversations` — delete all (`{deleted: count}`).
    - Swagger annotations:
      `@ApiTags('Conversations')`,
      `@ApiBearerAuth('JWT-auth')`,
      `@ApiOperation` per endpoint.

## Phase 5 — OpenAI-compat surface (shipped)

- [x] **T9**. `OpenAiCompatService` at
      [`apps/api/src/ai-conversation/openai-compat.service.ts`](../../../../apps/api/src/ai-conversation/openai-compat.service.ts)
    - `handleCompletion(dto, facadeOptions)` —
      resolveWorkContext → mapToInternalOptions →
      `aiFacade.createChatCompletion` →
      `mapToOpenAiResponse`.
    - `handleStreamingCompletion(dto, facadeOptions, res)` —
      iterates the facade async iterator, writes
      `data: …\n\n` SSE frames, ends with `data: [DONE]\n\n`,
      maps pre-headers errors to 502 JSON, post-headers errors to
      `res.destroy(error)`.
    - `mapToInternalOptions` — `model:'auto'` → `undefined`,
      passes through `temperature`, `max_tokens → maxTokens`,
      `top_p → topP`, `frequency_penalty → frequencyPenalty`,
      `presence_penalty → presencePenalty`, `stop`, `stream`,
      `tools`, `tool_choice → toolChoice`,
      `response_format → responseFormat`, `user`.
    - `mapToInternalMessages` — three-shape handler
      (assistant-with-tool-calls, tool-result, default).
      `content === null` → `''`. `name?` only when truthy.
    - `mapToOpenAiResponse` — `created: floor(ms/1000)`,
      `content: null` when upstream is non-string,
      `usage` only when present.
    - `mapToOpenAiStreamChunk` — `role:'assistant'` whenever upstream
      delta carries one; omit `content` when undefined; emit
      tool-call `id`/`type`/`name` only on first chunk
      (when `chunk.id` is set).
    - `resolveWorkContext` — picks first `findByUser` work when
      `workId` is omitted; passes through unchanged when `workId`
      is supplied.
    - `sanitizeErrorMessage` — regex redact + 300-char cap.
- [x] **T10**. `OpenAiCompatController` at
      [`apps/api/src/ai-conversation/openai-compat.controller.ts`](../../../../apps/api/src/ai-conversation/openai-compat.controller.ts)
    - `POST /api/v1/chat/completions` with
      `@HttpCode(200)` + permissive `ValidationPipe`.
    - Forwards headers `x-provider-override` and `x-work-id` to
      `FacadeOptions`.
    - Branches on `body.stream` for SSE vs JSON.

## Phase 6 — Module wiring (shipped)

- [x] **T11**. `AiConversationModule` at
      [`apps/api/src/ai-conversation/ai-conversation.module.ts`](../../../../apps/api/src/ai-conversation/ai-conversation.module.ts)
    - `imports: [FacadesModule, DatabaseModule]`
    - `controllers: [OpenAiCompatController, ConversationController]`
    - `providers: [OpenAiCompatService, ConversationTitleService]`
- [x] **T12**. Imported into `ApiModule` so the controllers register
      under `/api/conversations` and `/api/v1/chat/completions`.

## Phase 7 — Tests (shipped via PR [#484](https://github.com/ever-works/ever-works/pull/484))

- [x] **T13**. `conversation.controller.spec.ts` — 16 tests.
    - `list` — limit/offset `parseInt` + undefined passthrough.
    - `create` — body forwarded to repo; `auth.userId` injected.
    - `get` — 404 on null repo result.
    - `update` — 204 + `updateTitle` invocation; 404 on missing.
    - `appendMessages` — happy path; 404 on missing; first-message
      title derivation (`'\s+'` collapse, 60-char cap, `...`
      suffix); existing-title short-circuit; fire-and-forget AI
      title invocation; AI-title-rejection swallowing; tool-message
      passthrough.
    - `delete` — 204 + 404.
    - `deleteAll` — `{deleted: count}` envelope.
- [x] **T14**. `conversation-title.service.spec.ts` — 15 tests.
    - Gating (`<4` messages, `aiTitle:true` metadata, missing
      conversation).
    - Summary windowing (last 4 user/assistant only, 200-char per
      message, `parts[]` fallback for empty content).
    - AI request shape (`temperature: 0.3`, `maxTokens: 30`, system
      prompt verbatim).
    - Trim + 100-char cap on AI response.
    - Empty / whitespace / non-string AI response → no update.
    - AI request failure → `logger.debug` + no update.
    - `resolveFacadeOptions` — first work wins; throw → fallback to
      `{userId}` only.
- [x] **T15**. `openai-compat.controller.spec.ts` — 4 tests.
    - Streaming branch sets the four SSE headers and calls
      `handleStreamingCompletion`.
    - Non-streaming branch sets `Content-Type: application/json`
      and calls `handleCompletion`.
    - `x-provider-override` and `x-work-id` headers forwarded to
      `FacadeOptions`.
    - Permissive validation — extra fields stripped, not rejected.
- [x] **T16**. `openai-compat.service.spec.ts` — 21 tests.
    - DTO → internal options mapping for every supported field.
    - `model === 'auto'` → `undefined`.
    - Tool-call `name` passthrough.
    - Three-shape message mapping (assistant-with-tools, tool-result,
      default).
    - `content === null` → `''`.
    - Internal → OpenAI response mapping
      (`created: floor(ms/1000)`, non-string `content` → `null`,
      `usage` gating).
    - Streaming chunk mapping (`role:'assistant'` normalisation,
      `content` undefined-omit, tool-call delta first-vs-continuation
      `id`/`type`/`name` rules).
    - Pre-headers error → 502 JSON envelope.
    - Post-headers error → `res.destroy(error)` with the original
      `Error` (or wrapped non-Error).
    - `sanitizeErrorMessage` — `sk-…` / `Bearer …` redaction +
      300-char truncation + non-Error fallback.
    - `resolveWorkContext` — first-work pick / passthrough on
      explicit `workId` / no-work fallback.

## Phase 8 — Docs & retrospective

- [x] **T17**. Spec, plan, and tasks authored under
      `docs/specs/features/ai-conversation/` (this PR).
- [x] **T18**. Cross-link from `docs/specs/features/index.md` (or the
      auto-generated index, if used) — _no separate index file in
      `docs/specs/features/`; cross-references are surfaced via the
      `COVERAGE-TRACKER.md` "Pending — Medium Priority"
      checkbox flip._
- [x] **T19**. `COVERAGE-TRACKER.md` row moved to the "Done" table
      with this PR's link.

## Outstanding follow-ups

These map 1:1 to the open questions in `spec.md` §8 and to coverage
gaps not yet shipped. Each is its own future PR.

- [ ] **T30**. Decide on / implement OQ-1: optional persistence of
      the user/assistant turn into a `Conversation` from
      `OpenAiCompatService.handleStreamingCompletion` when
      `x-conversation-id` is supplied (the comments in the source
      hint at this but it isn't wired). _Owner: TBD._
- [ ] **T31**. OQ-2: tighten the title-derivation regex to also
      strip zero-width / RTL marks, OR document why the loose
      `/\s+/g` is sufficient.
- [ ] **T32**. OQ-3: make `resolveWorkContext` /
      `resolveFacadeOptions` deterministic — add a `defaultWorkId`
      column on `User` (or pick `oldest-work` / `most-recently-active`
      consistently) and document the choice in `plan.md` §11.
- [ ] **T33**. OQ-4: title-generation should resolve provider from
      `conversation.providerId` first, falling back to the user's
      first work only when `providerId` is unset. Update
      `ConversationTitleService.resolveFacadeOptions` accordingly.
- [ ] **T34**. OQ-5: switch `appendMessages` to a single batch save
      with explicit `createdAt` overrides — required for long-paste
      conversations to scale. Add cross-driver tests
      (Postgres / MySQL / SQLite) before flipping the implementation.
- [ ] **T35**. OQ-6: short-circuit `OpenAiCompatService.handleCompletion`
      / `handleStreamingCompletion` with `BadRequestException` if
      `userRepository.findById(userId)` returns null — protects
      against hard-deleted-user races where the auth session
      survives the user row.
- [ ] **T36**. OQ-7 (deferred from §4): add a typed
      `AppendMessagesDto` for `POST /api/conversations/:id/messages`
      to match the rest of the codebase's class-validator pattern
      (today the body is a plain inline shape).
- [ ] **T37**. e2e test against `/api/v1/chat/completions` using a
      mocked AI provider plugin to pin the streaming wire format
      end-to-end (current coverage is unit-level only).
- [ ] **T38**. Postgres-container integration test for
      `ConversationRepository` covering: cascade delete from
      `users`; cascade delete to `conversation_messages`; the
      `(userId, updatedAt)` and `(conversationId, createdAt)`
      indexes; `appendMessages` ordering after a 100-row insert.
- [ ] **T39**. Document the `chat/completions` surface in
      [`docs/api/`](../../../api/) — the canonical OpenAI-compat
      endpoint reference is not yet written. Cross-link from
      `apps/docs/sidebarsPlatform.ts`.

## Definition of Done

- All checkboxes T1–T19 ticked. ✅ (this is a retrospective spec)
- 56 unit tests in PR [#484](https://github.com/ever-works/ever-works/pull/484) passing.
- `pnpm format:check`, `pnpm lint`, and `pnpm --filter ever-works-api test`
  green at PR-merge time.
- Outstanding follow-ups T30–T39 captured above; none are blocking.
