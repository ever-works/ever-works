# Feature Specification: AI Conversation

**Feature ID**: `ai-conversation`
**Branch**: `docs/spec-ai-conversation`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The AI Conversation feature lets a signed-in user hold persistent,
chat-style conversations with the AI provider configured for their
work. Each conversation is owned by a user, optionally scoped to a
work, and stores the full message timeline (system / user / assistant /
tool messages, tool-call deltas, model + token usage). The feature also
exposes an OpenAI-compatible `POST /api/v1/chat/completions` endpoint
so that any AI SDK client (Vercel AI SDK, LangChain, raw OpenAI SDK,
etc.) can drive the same provider chain — streaming or non-streaming —
without knowing which underlying plugin (OpenAI, Anthropic, Google,
Groq, Mistral, Ollama, OpenRouter, Vercel AI Gateway, …) is currently
active for the user. Conversation titles are auto-generated from the
first user message and, once the conversation reaches four messages,
are upgraded to an AI-summarised title in the background.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I am signed in, **when** I `POST /api/conversations` with
  `{title?, providerId?}`, **then** a new conversation row is created
  for `userId=auth.userId` and returned.
- **Given** I have created a conversation, **when** I
  `POST /api/conversations/:id/messages` with the first user message,
  **then** the messages are appended in order **and** the conversation
  title is set to the first 60 chars of that user message (with the
  trailing `...` ellipsis if the original message exceeded 60 chars).
- **Given** my conversation has at least four messages and no AI title
  yet, **when** I append a new message, **then** a fire-and-forget
  background task asks the AI facade to summarise the last four
  user/assistant messages into a ≤50-char title and stores it with
  `metadata.aiTitle = true`.
- **Given** I `GET /api/conversations`, **when** the request resolves,
  **then** I see only my own conversations sorted by `updatedAt DESC`,
  paginated at `limit=50` / `offset=0` by default, **without** the
  message bodies (the list endpoint selects only
  `id, title, providerId, model, createdAt, updatedAt`).
- **Given** I `GET /api/conversations/:id`, **when** the conversation
  belongs to me, **then** I receive the conversation with its messages
  ordered by `createdAt ASC`.
- **Given** I send `POST /api/v1/chat/completions` with `stream=false`,
  **when** the request validates, **then** the OpenAI-compatible
  service forwards `(messages, model, temperature, max_tokens, …)` to
  the AI facade and returns an OpenAI-shaped
  `{id, object:'chat.completion', created, model, choices, usage?}`
  envelope.
- **Given** I send `POST /api/v1/chat/completions` with `stream=true`,
  **when** the service receives the chunk stream from the facade,
  **then** the controller writes SSE frames
  `data: {…ChatCompletionChunkResponse}\n\n` followed by
  `data: [DONE]\n\n` and emits the headers
  `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`.
- **Given** I send `model: "auto"` in the request, **when** the service
  maps it to internal options, **then** `model` is passed as
  `undefined` so the AI facade resolves the real model from plugin
  settings.
- **Given** I send tools in the request, **when** the service maps
  them, **then** every tool entry is passed through with
  `type: 'function'` and the original `function.name`, `description`,
  `parameters` shape so the AI facade can route through the active
  tool loop.

### 2.2 Edge cases & failures

- **Given** my user has multiple works but I do NOT pass `x-work-id`
  on `chat/completions`, **when** the service resolves work context,
  **then** it picks `workRepository.findByUser(userId)[0].id` —
  arbitrary but deterministic for that user.
- **Given** I `GET /api/conversations/:id` for a conversation owned by
  another user, **when** the repository's `findById(id, userId)` filter
  returns `null`, **then** the controller throws
  `NotFoundException` (no leakage of existence).
- **Given** I `DELETE /api/conversations/:id` with a non-existent or
  cross-user id, **when** the repository's `delete` returns
  `affected === 0`, **then** the controller throws `NotFoundException`.
- **Given** I `DELETE /api/conversations` (the bulk endpoint), **when**
  the request resolves, **then** the response is
  `{deleted: <count>}` (not 204) and only my conversations are deleted.
- **Given** the AI provider plugin throws during streaming
  **before** any chunk has been written (i.e. `res.headersSent`
  is still `false`), **when** the error reaches the catch block,
  **then** the service flips status to `502`, sets
  `Content-Type: application/json`, and writes
  `{error: {message, type:'provider_error', code:'ai_provider_error'}}`.
- **Given** the AI provider throws **after** at least one chunk has
  flushed (so `res.headersSent === true`), **when** the catch block
  runs, **then** it cannot rewrite the status — it instead destroys
  the response with the original `Error` (or a wrapped one when the
  thrown value isn't an `Error`) so downstream proxies see a broken
  stream rather than a malformed JSON tail.
- **Given** an error message contains an API key, **when**
  `sanitizeErrorMessage` runs, **then** any token matching
  `\b(sk-|key-|token-|Bearer\s+)[A-Za-z0-9_-]{10,}\b` is replaced with
  `[redacted]` and the message is truncated to 300 chars with `...`.
- **Given** the thrown value is not an `Error` instance, **when**
  `sanitizeErrorMessage` runs, **then** the response carries the
  generic message `"Something went wrong. Please try again."`.
- **Given** the upstream chunk has `delta.role`, **when** the service
  maps it to OpenAI shape, **then** the role is normalised to
  `'assistant'` regardless of what the provider sent.
- **Given** the upstream chunk has tool-call deltas, **when** the
  service maps them, **then** `id`, `type`, and `function.name` are
  written **only on the first chunk** of each tool call (when
  `chunk.id` is present). Continuation chunks carry only `index` and
  `function.arguments`. (This shape is required by
  `@ai-sdk/openai-compatible`'s parser, which uses `id == null` to
  detect continuation.)
- **Given** the upstream `delta.content` is `undefined`, **when** the
  service maps it, **then** the field is omitted from the SSE payload
  entirely (vs being written as `null`).
- **Given** the upstream `message.content` is not a string (e.g.
  multimodal parts array), **when** the response mapper runs, **then**
  the OpenAI-shape `content` is set to `null` (since OpenAI
  non-stream responses only carry text content).
- **Given** I append messages to a conversation that already has a
  title, **when** the controller's title-derivation block runs,
  **then** it short-circuits — the existing title is preserved.
- **Given** the auto-derived title contains repeated whitespace or
  newlines, **when** the controller normalises it, **then** internal
  whitespace runs collapse to a single space (`/\s+/g, ' '`) and
  leading/trailing space is trimmed before the 60-char cap.
- **Given** the AI title-generation request fails (provider error,
  empty response, network drop), **when** the title service catches
  it, **then** the failure is logged at `debug` level and the
  conversation keeps the existing first-message title.
- **Given** the AI title response is empty, whitespace-only, or not a
  string, **when** the service evaluates it, **then** no title update
  is written.
- **Given** the AI title response is longer than 100 chars, **when**
  the service writes it, **then** the title is truncated at 100 chars
  before persistence (the prompt asks for ≤50 chars, but this is a
  defensive cap).
- **Given** my conversation message has empty `content` but non-empty
  `parts`, **when** the title service summarises, **then**
  `extractMessageText` falls back to the joined `parts[].text` of the
  text-typed parts, so multimodal-only messages still contribute to
  the summary.
- **Given** the title service can't resolve a work for the user
  (`workRepository.findByUser` throws), **when** it builds the facade
  context, **then** it gracefully falls back to `{userId}` (no
  `workId`) so the title still generates against the user's default
  provider.
- **Given** I append two or more messages in a single
  `POST /api/conversations/:id/messages` call, **when** the repository
  saves them, **then** each row gets a `createdAt` of
  `new Date(baseTime + i)` so a subsequent `findById` returning rows
  ordered by `createdAt ASC` is guaranteed deterministic — even when
  the underlying database would otherwise stamp identical timestamps.

## 3. Functional Requirements

- **FR-1** Every conversation MUST belong to exactly one user
  (`userId`, FK with `ON DELETE CASCADE`); no cross-user reads or
  writes are possible at the repository layer.
- **FR-2** `POST /api/conversations` MUST accept
  `{title?: string, providerId?: string}` and MUST associate the new
  row with `auth.userId` from the session guard.
- **FR-3** `GET /api/conversations` MUST list only `auth.userId`'s
  conversations, sort by `updatedAt DESC`, default to `limit=50` /
  `offset=0`, accept query `limit` and `offset` parsed via
  `parseInt(_, 10)` (each independently `undefined`-able), and MUST
  return `{conversations, total}` projecting only
  `id, title, providerId, model, createdAt, updatedAt`.
- **FR-4** `GET /api/conversations/:id` MUST throw `NotFoundException`
  when the row is missing OR owned by a different user, and MUST
  include the `messages` relation ordered by `createdAt ASC` on
  success.
- **FR-5** `PATCH /api/conversations/:id` MUST update only the title
  for `auth.userId`'s row, MUST return `204`, and MUST throw
  `NotFoundException` for missing or cross-user ids.
- **FR-6** `POST /api/conversations/:id/messages` MUST require the
  conversation to belong to `auth.userId` (else `NotFoundException`)
  before appending; MUST persist `role`, `content`, optional `parts`,
  `model`, and `usage` for every supplied message; MUST set the
  conversation title from the first user message — collapsing
  whitespace runs to a single space, trimming, and capping at 60 chars
  (with `...` suffix when truncated) — **only** when the conversation
  has no title yet; and MUST kick off a fire-and-forget AI title
  generation via `titleService.maybeGenerateTitle(...).catch(() => {})`.
- **FR-7** `DELETE /api/conversations/:id` MUST return `204` on
  success and `NotFoundException` when nothing was deleted (so a
  cross-user delete is indistinguishable from a missing id).
- **FR-8** `DELETE /api/conversations` MUST return `200` with
  `{deleted: <count>}` and MUST delete only `auth.userId`'s rows.
- **FR-9** Appended messages MUST be persisted sequentially with
  `createdAt = new Date(baseTime + i)` so that ordering survives even
  on databases that stamp identical bulk-save timestamps; the
  conversation's `updatedAt` MUST be touched after the batch.
- **FR-10** AI title generation MUST run only when the conversation
  has at least 4 messages AND `metadata.aiTitle !== true`; the prompt
  MUST be built from the last 4 user/assistant messages, each
  truncated to 200 chars; the AI request MUST use
  `temperature: 0.3`, `maxTokens: 30`, and the system prompt
  _"Generate a short title (max 50 chars) for this conversation.
  Return ONLY the title, no quotes, no explanation."_
- **FR-11** When the AI title returns a non-empty trimmed string, the
  service MUST persist it via `updateTitle` truncated to 100 chars
  with `metadata: {aiTitle: true}`. When the AI request fails or
  returns nothing usable, the service MUST log at `debug` and leave
  the title untouched.
- **FR-12** `POST /api/v1/chat/completions` MUST accept the OpenAI
  `chat/completions` request body, run it through a
  `ValidationPipe({whitelist: true, transform: true})` (NO
  `forbidNonWhitelisted` — many AI SDK clients append fields like
  `stream_options`, `logprobs`, `parallel_tool_calls`, etc. and we
  MUST NOT reject them), and MUST forward the optional headers
  `x-provider-override` and `x-work-id` to the AI facade options.
- **FR-13** When `stream === true`, the controller MUST emit headers
  `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no` BEFORE the first
  chunk and MUST end the stream with `data: [DONE]\n\n`.
- **FR-14** When `stream === false`, the controller MUST set
  `Content-Type: application/json` and MUST return the full
  OpenAI-shape response.
- **FR-15** The internal-options mapper MUST translate
  `model === 'auto'` to `model: undefined` so the facade resolves
  from plugin settings; all other fields MUST be passed through
  unchanged (incl. `temperature`, `max_tokens → maxTokens`,
  `top_p → topP`, `frequency_penalty → frequencyPenalty`,
  `presence_penalty → presencePenalty`, `stop`, `stream`, `tools`,
  `tool_choice → toolChoice`, `response_format → responseFormat`,
  `user`).
- **FR-16** The message mapper MUST handle three shapes:
  (a) `assistant` with non-empty `tool_calls` produces a
  `{role:'assistant', content, toolCalls:[...]}` ChatMessage;
  (b) `tool` produces `{role:'tool', content, toolCallId}`;
  (c) any other role produces `{role, content, name?}` with the
  optional `name` only when truthy. `content === null` MUST be
  coerced to `''`.
- **FR-17** The non-stream response mapper MUST produce
  `created: Math.floor(response.created / 1000)` (OpenAI uses
  seconds, internal uses millis), MUST emit
  `object: 'chat.completion'`, MUST include `usage` only when the
  internal response carries it, and MUST set `content` to `null`
  whenever the upstream `message.content` is not a string.
- **FR-18** The stream chunk mapper MUST set `role: 'assistant'`
  whenever the upstream `delta.role` is present (regardless of value),
  MUST omit `content` entirely when it is `undefined`, and MUST emit
  tool-call `id` / `type` / `function.name` ONLY for the first chunk
  of each tool call (when `chunk.id` is set) — continuation chunks
  carry only `index` and `function.arguments`.
- **FR-19** Streaming errors that happen BEFORE `res.headersSent` MUST
  be converted to `502` JSON with the body
  `{error: {message, type:'provider_error', code:'ai_provider_error'}}`.
  Streaming errors that happen AFTER headers have been sent MUST
  destroy the response with the original `Error` (or a fresh `Error`
  built from the sanitised message when the thrown value is not an
  `Error`).
- **FR-20** `sanitizeErrorMessage` MUST replace any
  `\b(sk-|key-|token-|Bearer\s+)[A-Za-z0-9_-]{10,}\b` match with
  `[redacted]`, MUST truncate the result to 300 chars with `...`, and
  MUST return `"Something went wrong. Please try again."` when the
  thrown value is not an `Error`.
- **FR-21** When `facadeOptions.workId` is omitted on
  `chat/completions`, the service MUST attempt
  `workRepository.findByUser(userId)` and use the first work's id;
  when the user has zero works, the service MUST proceed with no
  `workId` (the AI facade decides whether to error).
- **FR-22** All conversation endpoints MUST be guarded by the global
  `AuthSessionGuard` (none are `@Public()`); unauthenticated requests
  MUST receive `401`.
- **FR-23** All endpoints MUST extract identity from
  `@CurrentUser() auth: AuthenticatedUser` and MUST NOT trust any
  `userId` field in request bodies or query params.

## 4. Non-Functional Requirements

- **Performance**: AI-title generation MUST be fire-and-forget (the
  message-append response MUST NOT wait for it). Streaming chat
  completions MUST flush each chunk as soon as the upstream provider
  emits it (no buffering past the SSE encoder).
- **Reliability**: A failure in AI-title generation MUST NOT cause a
  message-append failure. A streaming-provider failure MUST result in
  a clean response — either `502 + JSON envelope` (pre-headers) or
  `socket.destroy()` (post-headers) — and MUST NOT leave a half-open
  connection.
- **Security & privacy**: API keys, OAuth bearer tokens, and any
  alphanumeric secret-shaped substring in error messages MUST be
  redacted via `sanitizeErrorMessage`. Cross-user reads MUST surface
  as `NotFoundException` (no existence leakage). The OpenAI-compat
  endpoint MUST NOT echo any `Authorization` header back to the
  client.
- **Observability**: `OpenAiCompatService.handleStreamingCompletion`
  MUST log streaming errors via
  `logger.error('Streaming completion error', error)`.
  `ConversationTitleService` MUST log AI-title failures via
  `logger.debug('AI title generation failed', err)`. No PII is
  logged.
- **Compatibility**: The `chat/completions` envelope MUST match the
  OpenAI 2024-08-06 chat-completions schema sufficiently for the
  Vercel AI SDK, the OpenAI Node SDK, and `@ai-sdk/openai-compatible`
  to consume it without custom decoders.

## 5. Key Entities & Domain Concepts

| Entity / concept           | Description                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conversation`             | A per-user chat thread (`id`, `userId`, optional `title`, `providerId`, `model`, `metadata`, `createdAt`, `updatedAt`).                                                                      |
| `ConversationMessage`      | A single turn in a conversation (`role`, `content`, optional `parts`, `model`, `usage`). `role` is one of `user` / `assistant` / `system` / `tool`.                                          |
| `ConversationRepository`   | The data-access boundary: `create`, `findById`, `findByUser`, `appendMessage`, `appendMessages`, `updateTitle`, `delete`, `deleteAllByUser`. All read paths apply the `(id, userId)` filter. |
| `OpenAiCompatService`      | Translates between OpenAI's wire format and the platform's internal `ChatMessage` / `ChatCompletionOptions` / `ChatCompletionResponse` types and drives `AiFacadeService`.                   |
| `OpenAiCompatController`   | The `POST /api/v1/chat/completions` HTTP surface — chooses streaming vs JSON based on `body.stream` and emits the right headers in either case.                                              |
| `ConversationController`   | The `/api/conversations` REST surface — list / create / get / update-title / append-messages / delete-one / delete-all.                                                                      |
| `ConversationTitleService` | The fire-and-forget AI title summariser; gated on `messageCount >= 4 && !metadata.aiTitle`.                                                                                                  |
| `FacadeOptions`            | The `{userId, workId?, providerOverride?}` shape forwarded to `AiFacadeService` so that plugin settings, AI provider routing, and per-work overrides resolve consistently.                   |

## 6. Out of Scope

- A WebSocket transport for chat (current implementation is HTTP +
  SSE only).
- Multi-user conversations / sharing / collaboration on a single
  conversation thread.
- Server-side tool execution beyond what `AiFacadeService` already
  routes through (function-calling tools are passed through verbatim;
  there is no platform-side function registry in this feature).
- Multi-modal request bodies (image inputs, audio inputs) — the
  message mapper coerces non-string `content` to `''` on the request
  side and to `null` on the response side, but the spec does not
  guarantee multimodal round-trip.
- Per-conversation memory / RAG / retrieval — conversation history is
  stored, but the AI provider sees only what the client sends in the
  request `messages` array. (The web app's chat page replays the
  whole history; that's a UI concern.)
- Rate limiting beyond what `@nestjs/throttler` already does globally.
- A push/notification firing when an AI title finishes — the UI is
  expected to refetch on demand.
- Persisting messages on the OpenAI-compat endpoint. Message
  persistence happens via the conversation endpoints; the
  `chat/completions` surface is stateless from the platform's point
  of view.

## 7. Acceptance Criteria

- [ ] `POST /api/conversations` creates a row with the authenticated
      user's id and returns it.
- [ ] `GET /api/conversations` returns only the caller's rows, sorted
      newest-first, paginated, without message bodies.
- [ ] `GET /api/conversations/:id` returns 404 for cross-user reads.
- [ ] `PATCH /api/conversations/:id` updates the title and returns
      204; missing/cross-user → 404.
- [ ] `POST /api/conversations/:id/messages` appends the supplied
      messages, sets the title from the first user message when no
      title is set, and fires a fire-and-forget AI-title task.
- [ ] `DELETE /api/conversations/:id` returns 204 on success and 404
      when nothing is deleted.
- [ ] `DELETE /api/conversations` returns
      `{deleted: <count>}`.
- [ ] `POST /api/v1/chat/completions` (non-streaming) returns an
      OpenAI-shape JSON response with `created` in seconds, `usage`
      present only when the upstream returned it, and `content` set
      to `null` when the upstream returned non-string content.
- [ ] `POST /api/v1/chat/completions` (streaming) flushes SSE
      `data: …\n\n` frames followed by `data: [DONE]\n\n` and emits
      the four streaming headers.
- [ ] A pre-headers streaming error returns `502` JSON; a
      post-headers streaming error destroys the socket.
- [ ] `sanitizeErrorMessage` redacts `sk-…` / `Bearer …` tokens and
      truncates at 300 chars.
- [ ] `model === 'auto'` is forwarded to the facade as `undefined`.
- [ ] AI-title generation runs only at `messageCount >= 4` and only
      when `metadata.aiTitle !== true`; an empty/failed AI response
      is silently dropped.
- [ ] Tool-call deltas emit `id`/`type`/`name` only on the first
      chunk per tool call.
- [ ] All existing functional requirements have a passing unit test
      (currently 56 tests across `ConversationController` (16),
      `ConversationTitleService` (15), `OpenAiCompatController` (4),
      `OpenAiCompatService` (21) — see PR #484).

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1]` Should the OpenAI-compat endpoint
  optionally persist the user/assistant turn into a Conversation when
  `x-conversation-id` is supplied as a header? The current code path
  has comments hinting at this ("Creates/reuses a conversation,
  streams SSE, then persists messages.") but the persistence step is
  not actually wired.
- `[NEEDS CLARIFICATION: OQ-2]` The first-message-title rule strips
  `'\s+'` but does NOT strip emoji / zero-width characters. Should
  the regex be tightened (`/[\s​-‍﻿]+/g`) to keep
  titles human-readable when users paste from formatted sources?
- `[NEEDS CLARIFICATION: OQ-3]` `resolveWorkContext` and
  `resolveFacadeOptions` both pick `findByUser(userId)[0].id` —
  whichever work TypeORM hands back first — when no `x-work-id` /
  `workId` is supplied. Should this be deterministic (oldest work?
  most-recently-active work? user's `defaultWorkId` if we add one)?
  Today the order is repository-stable but undocumented.
- `[NEEDS CLARIFICATION: OQ-4]` AI title generation runs against the
  user's first work too. If a user has multiple works under different
  AI providers, the conversation can therefore be titled by a
  provider unrelated to where the conversation was originally
  scoped. Should we either (a) resolve provider from
  `conversation.providerId` if set, or (b) drop the work scope
  entirely for title generation?
- `[NEEDS CLARIFICATION: OQ-5]` `appendMessages` saves rows
  sequentially to guarantee ordering. On hot conversations
  (long histories), this is N round-trips per request. Should we
  switch to a single batch save with explicit `createdAt` overrides
  once the database wrapper supports it cleanly across all three
  drivers?
- `[NEEDS CLARIFICATION: OQ-6]` `OpenAiCompatService` does not check
  whether `userId` exists in the database before forwarding to the
  AI facade — the guard establishes authentication, but the
  `findByUser` query is the only side effect that would fail on a
  hard-deleted user. Should we guard explicitly?

## 9. Constitution Gates

- [ ] Plugin-first: not introducing a new external integration —
      reuses `AiFacadeService` and `WorkRepository`. (Principle I)
- [ ] Capability-driven resolution: the OpenAI-compat path defers
      provider/model resolution to `AiFacadeService` via the
      `model === 'auto'` → `undefined` translation. (Principle II)
- [ ] Source-of-truth repos preserved: messages live in the platform
      DB, not in any work's repo. No content escapes the user
      boundary. (Principle III)
- [ ] Long-running work via Trigger.dev: N/A — chat completions are
      request/response or SSE-streamed within the request lifetime.
      (Principle IV)
- [x] Schema changes ship as forward-only migrations: the
      `conversations` and `conversation_messages` tables shipped via
      forward-only migrations under `apps/api/src/database/migrations/`.
      (Principle V)
- [x] Tests accompany the change: 56 unit tests across the four
      classes (PR [#484](https://github.com/ever-works/ever-works/pull/484)).
      (Principle VI)
- [x] Secrets handled per `x-secret` rules: API keys are sourced from
      plugin settings (already secret-tagged); the OpenAI-compat
      surface accepts no key from the client. (Principle VII)
- [ ] Plugin counts touch the canonical doc only: N/A. (Principle VIII)
- [x] Behaviour-first — no implementation in this spec. (Principle IX)
- [x] Backwards-compatible API/SDK/schema changes: the OpenAI wire
      format is a stable public contract; all internal fields are
      optional or additive. (Principle X)

## 10. References

- Related features: [`auth-jwt-oauth`](../auth-jwt-oauth/spec.md),
  [`plugin-system`](../plugin-system/spec.md),
  [`subscriptions`](../subscriptions/spec.md).
- Source: [`apps/api/src/ai-conversation/`](../../../../apps/api/src/ai-conversation/),
  [`packages/agent/src/database/repositories/conversation.repository.ts`](../../../../packages/agent/src/database/repositories/conversation.repository.ts),
  [`packages/agent/src/entities/conversation.entity.ts`](../../../../packages/agent/src/entities/conversation.entity.ts),
  [`packages/agent/src/entities/conversation-message.entity.ts`](../../../../packages/agent/src/entities/conversation-message.entity.ts).
- Tests: [`apps/api/src/ai-conversation/conversation.controller.spec.ts`](../../../../apps/api/src/ai-conversation/conversation.controller.spec.ts),
  [`apps/api/src/ai-conversation/conversation-title.service.spec.ts`](../../../../apps/api/src/ai-conversation/conversation-title.service.spec.ts),
  [`apps/api/src/ai-conversation/openai-compat.controller.spec.ts`](../../../../apps/api/src/ai-conversation/openai-compat.controller.spec.ts),
  [`apps/api/src/ai-conversation/openai-compat.service.spec.ts`](../../../../apps/api/src/ai-conversation/openai-compat.service.spec.ts).
- Test PR: [#484](https://github.com/ever-works/ever-works/pull/484).
