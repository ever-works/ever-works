# AI Refactoring: Task Checklist

## Phase 1: Dependencies & Setup

- [x] Install `ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/react` in `apps/web/`
    ```bash
    pnpm add ai @ai-sdk/openai-compatible @ai-sdk/react --filter ever-works-web
    ```
- [x] Verify version alignment with `packages/plugins/agent-pipeline/` (`ai@^6.0.85`)
- [x] Run `pnpm install` from root to ensure lockfile is updated

## Phase 2: Enable Tool Calling in AiOperations

### 2.1 Update Plugin Contracts

- [x] Add `toolCallId?: string` field to `ChatMessage` interface
    - File: `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts`
- [x] Make `createStreamingChatCompletion` required (not optional) in `IAiProviderPlugin`
- [x] Verify `ToolDefinition`, `ToolCall`, `ChatCompletionOptions.tools` already exist (they do)

### 2.2 Update AiOperations Class

- [x] Import `ToolMessage`, `BaseMessage` from `@langchain/core/messages`
    - File: `packages/plugin/src/ai/ai-operations.ts`
- [x] Update `toLangChainMessages()` to handle:
    - [x] `role: 'tool'` -> `ToolMessage` with `tool_call_id`
    - [x] `role: 'assistant'` with `toolCalls` -> `AIMessage` with `tool_calls`
- [x] Add `bindTools()` private method using LangChain's `bindTools` API:
    - [x] If `options.tools` present, call `llm.bindTools(tools, { tool_choice })`
    - [x] Add `'tools'` to parameter rejection/retry logic in `parseRejectedParam()`
- [x] Update `createChatCompletion()` to parse tool calls:
    - [x] Extract `response.tool_calls` from `AIMessage`
    - [x] Map to `ChatCompletionResponse.choices[].message.toolCalls`
    - [x] Set `finishReason: 'tool_calls'` when tool calls present
- [x] Update `createStreamingChatCompletion()` to parse tool call chunks:
    - [x] Extract `chunk.tool_call_chunks` from `AIMessageChunk`
    - [x] Map to `delta.toolCalls` in chunk format
    - [x] Handle `finishReason: 'tool_calls'`
- [x] Update `parseRejectedParam()` to handle `'tools'` rejection

### 2.3 Additional Changes

- [x] Remove optional streaming guard from `AiFacadeService.createStreamingChatCompletion()`
    - File: `packages/agent/src/facades/ai.facade.ts`

### 2.4 Verify

- [x] Run `cd packages/plugin && pnpm type-check` — passes
- [x] Run type-check on all 8 AI provider plugins (openai, anthropic, groq, google, mistral, openrouter, ollama, vercel-ai-gateway) — all pass
- [x] Run `cd packages/agent && pnpm test` — 33 suites, 892 tests pass
- [x] Note: `langfuse-plugin` has pre-existing type-check failure (unrelated to our changes)

## Phase 3: OpenAI-Compatible NestJS Endpoint

### 3.1 Create DTOs

- [ ] Create `apps/api/src/ai-conversation/dto/openai-compat.dto.ts`
    - [ ] `OpenAiChatCompletionRequestDto` with class-validator decorators
    - [ ] `OpenAiMessage` interface
    - [ ] `OpenAiToolDefinition` interface
    - [ ] OpenAI response types (non-streaming and streaming chunk)

### 3.2 Create Service

- [ ] Create `apps/api/src/ai-conversation/openai-compat.service.ts`
    - [ ] Constructor: inject `AiFacadeService`, `DirectoryRepository`
    - [ ] `handleCompletion(dto, facadeOptions)` - non-streaming path
    - [ ] `handleStreamingCompletion(dto, facadeOptions, res)` - SSE streaming path
    - [ ] `mapToInternalMessages(messages)` - OpenAI -> internal ChatMessage format
    - [ ] `mapToInternalOptions(dto)` - Full request mapping
    - [ ] `mapToOpenAiResponse(response)` - Internal -> OpenAI response format
    - [ ] `mapToOpenAiStreamChunk(chunk)` - Internal -> OpenAI SSE chunk format
    - [ ] `resolveDirectoryContext(options)` - Reuse from existing service

### 3.3 Create Controller

- [ ] Create `apps/api/src/ai-conversation/openai-compat.controller.ts`
    - [ ] `POST /api/v1/chat/completions`
    - [ ] JWT auth via `@CurrentUser()`
    - [ ] Read `X-Provider-Override` and `X-Directory-Id` headers
    - [ ] Route to streaming vs non-streaming based on `body.stream`
    - [ ] Set proper response headers for SSE

### 3.4 Register in Module

- [ ] Update `apps/api/src/ai-conversation/ai-conversation.module.ts`
    - [ ] Add `OpenAiCompatController` to controllers
    - [ ] Add `OpenAiCompatService` to providers

### 3.5 Test Endpoint

- [ ] Start API: `pnpm dev:api`
- [ ] Test non-streaming with curl
- [ ] Test streaming with curl (verify SSE format: `data: {...}\n\n` + `data: [DONE]\n\n`)
- [ ] Test with invalid auth (should return 401)
- [ ] Test with `X-Provider-Override` header

## Phase 4: Custom Vercel AI SDK Provider

- [ ] Create `apps/web/src/lib/ai/provider.ts`
    - [ ] `createBackendProvider(options)` function
    - [ ] Uses `createOpenAICompatible` from `@ai-sdk/openai-compatible`
    - [ ] Configures: name, baseURL, apiKey (= JWT token), custom headers
- [ ] Create `apps/web/src/lib/ai/index.ts` barrel export
- [ ] Verify TypeScript compilation

## Phase 5: Next.js Route Handler

- [ ] Create `apps/web/src/app/api/chat/route.ts`
    - [ ] `POST` handler with `maxDuration = 60`
    - [ ] Auth: `getAuthAccessCookie()` + `refreshAccessToken()` fallback
    - [ ] Parse body: extract `messages`, `providerOverride`, `directoryId`
    - [ ] Create provider with `createBackendProvider()`
    - [ ] Call `streamText()` with provider and messages
    - [ ] Return `result.toUIMessageStreamResponse()`
- [ ] Update `apps/web/src/lib/constants.ts`
    - [ ] Add `API_CHAT: '/api/chat'` to ROUTES
- [ ] Test end-to-end: web -> Next.js route -> NestJS -> plugin -> LangChain

## Phase 6: Frontend Chat UI Refactor

### 6.1 Update ChatProvider

- [ ] Rewrite `apps/web/src/components/ai/ChatProvider.tsx`
    - [ ] Replace `useChatHistory` with `useChat` from `@ai-sdk/react`
    - [ ] Configure `useChat` with `api: '/api/chat'`
    - [ ] Pass `providerOverride` via `body` option
    - [ ] Set `initialMessages` with welcome message
    - [ ] Expose `useChat` return values through context
    - [ ] Add `resetChat()` method
    - [ ] Keep provider fetching logic (unchanged)

### 6.2 Update ChatInterface

- [ ] Rewrite `apps/web/src/components/ai/ChatInterface.tsx`
    - [ ] Remove imports: `useAIStream`, `useChatHistory`, `generateMessageId`
    - [ ] Use `useChatContext()` for all state
    - [ ] Replace `isStreaming` checks with `status === 'streaming'`
    - [ ] Update form submit to use `handleSubmit` from `useChat`
    - [ ] Update message rendering to use `message.parts` array
        - [ ] Render `part.type === 'text'` as text
        - [ ] Render `part.type === 'tool-invocation'` with tool UI (optional, can be basic)
    - [ ] Update message editing to use `setMessages` + `reload`
    - [ ] Update reset to call `resetChat()`
    - [ ] Update error display to use `error` from `useChat`
    - [ ] Keep: provider selection UI, auto-resize textarea, timestamps
    - [ ] Remove: `pendingMessageRef`, `updatePendingMessage`, `clearPending`

### 6.3 Verify UI

- [ ] Chat sends and receives messages
- [ ] Streaming animation works (loading dots while `status === 'streaming'`)
- [ ] Provider switching works
- [ ] Message editing works (truncate + regenerate)
- [ ] New chat / reset works
- [ ] Error states display correctly
- [ ] Auto-scroll works

## Phase 7: Cleanup

### 7.1 Remove Old Files

- [ ] Delete `apps/web/src/lib/hooks/use-ai-stream.ts`
- [ ] Delete `apps/web/src/lib/hooks/use-chat-history.ts`
- [ ] Delete `apps/web/src/lib/api/ai-conversation.ts`
- [ ] Delete `apps/web/src/app/api/ai-conversations/chat/stream/route.ts`
    - [ ] Also remove the `ai-conversations` directory tree if empty
- [ ] Delete `apps/web/src/lib/utils/next-api.ts` (only used by removed route)

### 7.2 Update References

- [ ] Remove `export * from './ai-conversation'` from `apps/web/src/lib/api/index.ts`
- [ ] Remove `API_AI_CONVERSATIONS_CHAT_STREAM` from `apps/web/src/lib/constants.ts`
- [ ] Deprecate old NestJS controller (add comment, keep for backward compat)

### 7.3 Verify No Broken Imports

- [ ] Search for `use-ai-stream` -> 0 results
- [ ] Search for `use-chat-history` -> 0 results
- [ ] Search for `aiConversationAPI` -> 0 results
- [ ] Search for `nextApiResponseStreaming` -> 0 results
- [ ] Search for `API_AI_CONVERSATIONS_CHAT_STREAM` -> 0 results

### 7.4 Final Verification

- [ ] `pnpm type-check` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` succeeds
- [ ] `cd packages/agent && pnpm test` passes
- [ ] Manual E2E test of chat feature
- [ ] Manual test of directory generation (verify pipelines still work)
