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

- [x] Create `apps/api/src/ai-conversation/dto/openai-compat.dto.ts`
    - [x] `OpenAiChatCompletionRequestDto` with class-validator decorators
    - [x] `OpenAiMessageDto`, `OpenAiToolDefinitionDto`, `OpenAiFunctionDto` classes
    - [x] `OpenAiChatCompletionResponse` interface (non-streaming)
    - [x] `OpenAiChatCompletionChunkResponse` interface (streaming)
    - [x] `OpenAiToolCallResponse` interface

### 3.2 Create Service

- [x] Create `apps/api/src/ai-conversation/openai-compat.service.ts`
    - [x] Constructor: inject `AiFacadeService`, `DirectoryRepository`
    - [x] `handleCompletion(dto, facadeOptions)` - non-streaming path
    - [x] `handleStreamingCompletion(dto, facadeOptions, res)` - SSE streaming path
    - [x] `mapToInternalMessages(messages)` - OpenAI -> internal ChatMessage format (with tool_calls + tool_call_id)
    - [x] `mapToInternalOptions(dto)` - Full request mapping (snake_case -> camelCase)
    - [x] `mapToOpenAiResponse(response)` - Internal -> OpenAI response format (camelCase -> snake_case)
    - [x] `mapToOpenAiStreamChunk(chunk, toolCallBaseIndex)` - Internal -> OpenAI SSE chunk format with indexed tool_calls
    - [x] `resolveDirectoryContext(options)` - Reuses same logic as old service

### 3.3 Create Controller

- [x] Create `apps/api/src/ai-conversation/openai-compat.controller.ts`
    - [x] `POST /api/v1/chat/completions`
    - [x] JWT auth via `@CurrentUser()`
    - [x] Read `X-Provider-Override` and `X-Directory-Id` headers
    - [x] Route to streaming (SSE) vs non-streaming (JSON) based on `body.stream`
    - [x] Proper SSE headers: `text/event-stream`, `no-cache`, `keep-alive`, `X-Accel-Buffering: no`

### 3.4 Clean Up Old Code

- [x] Deleted `apps/api/src/ai-conversation/ai-conversation.controller.ts` (old NDJSON controller)
- [x] Deleted `apps/api/src/ai-conversation/ai-conversation.service.ts` (old streaming service)
- [x] Updated `ai-conversation.module.ts` — only registers `OpenAiCompatController` + `OpenAiCompatService`
- [x] Fixed `ai.facade.spec.ts` — added `createStreamingChatCompletion` to mock (required after interface change)

### 3.5 Verify

- [x] `npx turbo build --filter=ever-works-api` — 0 TSC issues, all 6 tasks pass
- [x] `cd packages/agent && pnpm test` — 33 suites, 892 tests pass
- [ ] Manual curl testing (deferred to integration testing)

## Phase 4: Custom Vercel AI SDK Provider + Next.js Route Handler

### Provider Selection Requirements

- `X-Provider-Override` is **always** passed — user always has an active AI provider
- Default: `openrouter` (auto-selected via `resolveEffectiveDefault()` in ChatProvider)
- Auth: encrypted JWT cookie → `getAuthAccessCookie()` → Bearer token to backend

### 4.1 Custom Provider

- [x] Create `apps/web/src/lib/ai/provider.ts`
    - [x] `createBackendProvider(options)` function
    - [x] Uses `createOpenAICompatible` from `@ai-sdk/openai-compatible`
    - [x] `providerOverride` is **required** (not optional) — always passed as `X-Provider-Override` header
    - [x] `apiKey` = JWT token (sent as `Authorization: Bearer` automatically)
    - [x] `baseURL` = `${API_URL}/v1` (API_URL already includes `/api` suffix)
    - [x] Marked `server-only` — no client-side usage
- [x] Create `apps/web/src/lib/ai/index.ts` barrel export

### 4.2 Next.js Route Handler

- [x] Create `apps/web/src/app/api/chat/route.ts`
    - [x] `POST` handler with `maxDuration = 60`
    - [x] Auth: `getAuthAccessCookie()` + `refreshAccessToken()` fallback (same as `serverFetch`)
    - [x] Parse body: extract `messages` (UIMessage[]), `providerOverride` (required), `directoryId`
    - [x] Returns 400 if `providerOverride` missing
    - [x] Returns 401 if no auth token after refresh attempt
    - [x] Creates provider with `createBackendProvider()` pointing to `${API_URL}/v1`
    - [x] Calls `streamText()` with `provider('default')` + `convertToModelMessages(messages)`
    - [x] Returns `result.toUIMessageStreamResponse()`
- [ ] Test end-to-end: web -> Next.js route -> NestJS -> plugin -> LangChain

## Phase 6: Frontend Chat UI Refactor

### 6.1 Update ChatProvider

- [x] Rewrite `apps/web/src/components/ai/ChatProvider.tsx`
    - [x] Replace `useChatHistory` with `useChat` from `@ai-sdk/react`
    - [x] Configure `useChat` with `DefaultChatTransport({ api: '/api/chat' })`
    - [x] Pass `providerOverride` via `body` option (always required, defaults to `'openrouter'`)
    - [x] Set `messages` with welcome message as initial
    - [x] Expose `sendMessage`, `setMessages`, `status`, `error`, `stop`, `regenerate` through context
    - [x] Add `resetChat()` method
    - [x] Keep provider fetching logic (unchanged)

### 6.2 Split into Clean Components

- [x] Create `apps/web/src/components/ai/ChatMessage.tsx` — Single message rendering (user/assistant)
- [x] Create `apps/web/src/components/ai/ChatMessageContent.tsx` — Message parts renderer (text, tool calls, streaming dots)
- [x] Create `apps/web/src/components/ai/ChatMessageEdit.tsx` — Inline editing textarea with save/cancel
- [x] Create `apps/web/src/components/ai/ChatProviderSelector.tsx` — Provider selection pill buttons

### 6.3 Rewrite ChatInterface

- [x] Rewrite `apps/web/src/components/ai/ChatInterface.tsx`
    - [x] Uses split sub-components (ChatMessage, ChatProviderSelector)
    - [x] Uses `useChatContext()` for all state
    - [x] `isStreaming = status === 'streaming' || status === 'submitted'`
    - [x] Form submit calls `sendMessage(text)` from context
    - [x] Message editing: `setMessages` to truncate + `regenerate()` (v6 API, not `reload`)
    - [x] Reset calls `resetChat()`
    - [x] Error from `error.message`
    - [x] Removed: `pendingMessageRef`, `updatePendingMessage`, `clearPending`, all manual streaming

### 6.4 Refactor Sidebar — Chat as Sidebar-of-Sidebar

- [x] Rewrite `apps/web/src/components/dashboard/DashboardSidebar.tsx`
    - [x] Removed menu/chat mode toggle (no more `activeMode` state)
    - [x] Sidebar always shows navigation — AI Chat button is a nav item
    - [x] Chat slides out as a secondary panel (positioned at `left: sidebarWidth`)
    - [x] Panel has its own close button, drag-to-resize handle, and backdrop
    - [x] Works with both collapsed and expanded sidebar states
    - [x] Removed `LayoutList` import (unused after mode toggle removal)

### 6.5 Verify

- [x] `npx turbo build --filter=ever-works-web` — build passes, 0 TypeScript errors
- [x] Old `/api/ai-conversations/chat/stream` route removed from build output
- [x] New `/api/chat` route present in build output

## Phase 7: Cleanup

### 7.1 Remove Old Files

- [x] Deleted `apps/web/src/lib/hooks/use-ai-stream.ts`
- [x] Deleted `apps/web/src/lib/hooks/use-chat-history.ts`
- [x] Deleted `apps/web/src/lib/api/ai-conversation.ts`
- [x] Deleted `apps/web/src/app/api/ai-conversations/` (entire directory tree)
- [x] Deleted `apps/web/src/lib/utils/next-api.ts`
- [x] Deleted `apps/api/src/ai-conversation/ai-conversation.controller.ts` (old NDJSON controller)
- [x] Deleted `apps/api/src/ai-conversation/ai-conversation.service.ts` (old streaming service)

### 7.2 Update References

- [x] Removed `export * from './ai-conversation'` from `apps/web/src/lib/api/index.ts`
- [x] Removed `API_AI_CONVERSATIONS_CHAT_STREAM` from constants, added `API_CHAT`
- [x] Removed re-exports of deleted types from `apps/web/src/lib/api/types-only.ts`

### 7.3 Verify No Broken Imports

- [x] Search for `use-ai-stream` -> 0 results
- [x] Search for `use-chat-history` -> 0 results
- [x] Search for `aiConversationAPI` -> 0 results
- [x] Search for `nextApiResponseStreaming` -> 0 results
- [x] Search for `API_AI_CONVERSATIONS_CHAT_STREAM` -> 0 results

### 7.4 Final Verification

- [x] `npx turbo build --filter=ever-works-web` passes
- [x] `npx turbo build --filter=ever-works-api` passes
- [x] `cd packages/agent && pnpm test` — 892 tests pass
- [ ] Manual E2E test of chat feature (requires running servers)
- [ ] Manual test of directory generation (verify pipelines still work)
