# AI Feature Refactoring: Vercel AI SDK Integration

## Context

The current AI chat implementation uses a custom NDJSON streaming approach:

- Custom `useAIStream` / `useChatHistory` hooks on the frontend
- A Next.js proxy route at `/api/ai-conversations/chat/stream`
- A NestJS `AiConversationController` that streams NDJSON via `AiFacadeService`

This works but has limitations:

- **No tool calling support** in the chat UI (AiOperations doesn't forward tools to LangChain)
- **Custom streaming protocol** instead of industry-standard SSE (Server-Sent Events)
- **Duplicated message management** logic that Vercel AI SDK handles out of the box
- **No structured message parts** (text, tool calls, tool results) in the UI

## Goal

Replace the custom implementation with Vercel AI SDK (`ai` v6), enabling:

1. Tool calling throughout the full stack
2. Standard `useChat` hook for the frontend
3. OpenAI-compatible API endpoint on the NestJS backend
4. Custom Vercel AI SDK provider wrapping our plugin system

## Architecture

### Current Flow

```
ChatInterface -> useAIStream() -> POST /api/ai-conversations/chat/stream (Next.js NDJSON proxy)
  -> POST /api/ai-conversations/chat/stream (NestJS) -> AiFacadeService -> Plugin -> LangChain
```

### New Flow

```
ChatInterface -> useChat() -> POST /api/chat (Next.js route handler)
  -> streamText() with custom provider -> POST /api/v1/chat/completions (NestJS, OpenAI-compat)
    -> OpenAiCompatService -> AiFacadeService -> Plugin -> LangChain (with tools)
```

### Key Design Decisions

1. **OpenAI-compatible endpoint** (`POST /api/v1/chat/completions`) on NestJS backend
    - Standard wire format understood by `@ai-sdk/openai-compatible`
    - Supports both streaming (SSE) and non-streaming responses
    - Reuses existing `AiFacadeService` for provider resolution, settings, routing
    - Provider selection via `X-Provider-Override` header (keeps request body clean)

2. **Custom provider via `@ai-sdk/openai-compatible`**
    - Points to NestJS backend's `/api/v1/` base URL
    - Auth token injected server-side in the Next.js route handler
    - No JWT exposed to the client

3. **`useChat` from `@ai-sdk/react`** replaces both `useAIStream` and `useChatHistory`
    - Built-in message management, streaming state, error handling
    - Native tool call/result rendering via message `parts`
    - Provider selection via custom headers

4. **Extend existing `AiConversationModule`** (not a new module)
    - Add `OpenAiCompatController` + `OpenAiCompatService` alongside existing controller
    - Share `WorkRepository` and `AiFacadeService` imports

---

## Phase 1: Enable Tool Calling in AiOperations

### File: `packages/plugin/src/ai/ai-operations.ts`

#### 1.1 Update `toLangChainMessages()` (line 387)

Add support for `tool` role messages and assistant messages with tool calls:

```typescript
import { ToolMessage } from '@langchain/core/messages';

private toLangChainMessages(messages: readonly ChatMessage[]) {
  return messages.map((msg) => {
    const content = typeof msg.content === 'string' ? msg.content : '';
    switch (msg.role) {
      case 'system':
        return new SystemMessage(content);
      case 'assistant': {
        const aiMsg = new AIMessage(content);
        if (msg.toolCalls?.length) {
          aiMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
            type: 'tool_call' as const,
          }));
        }
        return aiMsg;
      }
      case 'tool':
        return new ToolMessage({
          content,
          tool_call_id: (msg as any).toolCallId ?? '',
        });
      case 'user':
      default:
        return new HumanMessage(content);
    }
  });
}
```

#### 1.2 Update `createChatModel()` (line 316)

Bind tools to the LangChain model when present:

```typescript
private createChatModel(
  config: AiOperationsConfig,
  model: string,
  options?: ChatCompletionOptions,
  skip?: Set<string>
): ChatOpenAI {
  // ... existing code ...

  const llm = new ChatOpenAI({ ... });

  // Bind tools if provided
  if (options?.tools?.length && !skip?.has('tools')) {
    return llm.bind({
      tools: options.tools.map((t) => ({
        type: 'function' as const,
        function: t.function,
      })),
      ...(options.toolChoice && { tool_choice: options.toolChoice }),
    }) as unknown as ChatOpenAI;
  }

  return llm;
}
```

#### 1.3 Update `createChatCompletion()` (line 44)

Parse tool calls from LangChain response:

```typescript
const response = await llm.invoke(messages, { callbacks: [tracker] });
const content = typeof response.content === 'string' ? response.content : '';

// Extract tool calls from response
const toolCalls = response.tool_calls?.map((tc) => ({
	id: tc.id ?? `call_${Date.now()}`,
	type: 'function' as const,
	function: {
		name: tc.name,
		arguments: JSON.stringify(tc.args)
	}
}));

const hasToolCalls = toolCalls && toolCalls.length > 0;

return {
	id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
	model,
	created: Date.now(),
	choices: [
		{
			index: 0,
			message: {
				role: 'assistant',
				content,
				...(hasToolCalls && { toolCalls })
			},
			finishReason: hasToolCalls ? 'tool_calls' : 'stop'
		}
	],
	usage: this.mapTokenUsage(tracker)
};
```

#### 1.4 Update `createStreamingChatCompletion()` (line 109)

Parse tool call chunks from streaming response:

```typescript
for await (const chunk of stream) {
  const content = typeof chunk.content === 'string' ? chunk.content : '';

  // Extract tool call chunks
  const toolCallChunks = chunk.tool_call_chunks?.map((tc) => ({
    id: tc.id ?? '',
    type: 'function' as const,
    function: {
      name: tc.name ?? '',
      arguments: tc.args ?? '',
    },
  }));

  yield {
    id: `chatcmpl-${Date.now()}`,
    model,
    created: Date.now(),
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content,
        ...(toolCallChunks?.length && { toolCalls: toolCallChunks }),
      },
      finishReason: null,
    }],
  };
}
```

#### 1.5 Add `'tools'` to `parseRejectedParam()` (line 377)

```typescript
if (msg.includes("'tools'") || msg.includes('"tools"') || msg.includes('tool_choice')) return 'tools';
```

#### 1.6 Update `ChatMessage` interface

Add `toolCallId` field for tool result messages:

**File:** `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts`

```typescript
export interface ChatMessage {
	readonly role: ChatMessageRole;
	readonly content: string | readonly ChatMessageContent[];
	readonly name?: string;
	readonly functionCall?: FunctionCall;
	readonly toolCalls?: readonly ToolCall[];
	readonly toolCallId?: string; // NEW: For tool result messages
}
```

---

## Phase 2: OpenAI-Compatible NestJS Endpoint

### 2.1 New DTO: `apps/api/src/ai-conversation/dto/openai-compat.dto.ts`

```typescript
import { IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

export class OpenAiChatCompletionRequestDto {
	@IsString() @IsOptional() model?: string;
	@IsArray() messages: OpenAiMessage[];
	@IsNumber() @IsOptional() temperature?: number;
	@IsNumber() @IsOptional() max_tokens?: number;
	@IsNumber() @IsOptional() top_p?: number;
	@IsNumber() @IsOptional() frequency_penalty?: number;
	@IsNumber() @IsOptional() presence_penalty?: number;
	@IsArray() @IsOptional() stop?: string[];
	@IsBoolean() @IsOptional() stream?: boolean;
	@IsArray() @IsOptional() tools?: OpenAiToolDefinition[];
	@IsOptional() tool_choice?: string | { type: string; function: { name: string } };
	@IsObject() @IsOptional() response_format?: { type: string };
	@IsString() @IsOptional() user?: string;
}

// Supporting types for clarity
export interface OpenAiMessage {
	role: string;
	content: string | null;
	name?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

export interface OpenAiToolDefinition {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}
```

### 2.2 New Service: `apps/api/src/ai-conversation/openai-compat.service.ts`

**Responsibilities:**

- Map OpenAI wire format -> internal `ChatCompletionOptions`
- Map internal `ChatCompletionResponse` / `ChatCompletionChunk` -> OpenAI wire format
- Handle both streaming (SSE) and non-streaming paths
- Reuse `AiFacadeService` for provider resolution

**Key methods:**

- `handleCompletion(dto, facadeOptions)` - Non-streaming path
- `handleStreamingCompletion(dto, facadeOptions, res)` - Streaming SSE path
- `mapToInternalOptions(dto)` - Convert OpenAI format to internal format
- `mapToOpenAiResponse(response)` - Convert internal response to OpenAI format
- `mapToOpenAiChunk(chunk, index)` - Convert internal chunk to OpenAI SSE chunk
- `resolveWorkContext(options)` - Reused from existing service

**Message mapping (OpenAI -> Internal):**

```
{ role: "user", content: "..." }           -> { role: "user", content: "..." }
{ role: "assistant", tool_calls: [...] }   -> { role: "assistant", toolCalls: [...] }
{ role: "tool", tool_call_id: "...", content: "..." } -> { role: "tool", toolCallId: "...", content: "..." }
```

**Response mapping (Internal -> OpenAI):**

```
{ choices: [{ message: { toolCalls } }] }  -> { choices: [{ message: { tool_calls } }] }
{ choices: [{ delta: { toolCalls } }] }    -> { choices: [{ delta: { tool_calls } }] }
```

### 2.3 New Controller: `apps/api/src/ai-conversation/openai-compat.controller.ts`

```typescript
@ApiTags('AI - OpenAI Compatible')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1')
export class OpenAiCompatController {
	constructor(private readonly service: OpenAiCompatService) {}

	@Post('chat/completions')
	@HttpCode(200)
	async chatCompletions(
		@CurrentUser() auth: AuthenticatedUser,
		@Headers('x-provider-override') providerOverride: string | undefined,
		@Headers('x-work-id') workId: string | undefined,
		@Body() body: OpenAiChatCompletionRequestDto,
		@Res() res: Response
	): Promise<void> {
		const facadeOptions = {
			userId: auth.userId,
			workId,
			providerOverride
		};

		if (body.stream) {
			// SSE streaming
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');

			await this.service.handleStreamingCompletion(body, facadeOptions, res);
		} else {
			// JSON response
			const result = await this.service.handleCompletion(body, facadeOptions);
			res.setHeader('Content-Type', 'application/json');
			res.json(result);
		}
	}
}
```

### 2.4 SSE Streaming Format

Each chunk must be exactly:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n
```

Final message:

```
data: [DONE]\n\n
```

### 2.5 Update Module: `apps/api/src/ai-conversation/ai-conversation.module.ts`

```typescript
@Module({
	imports: [FacadesModule, DatabaseModule],
	controllers: [AiConversationController, OpenAiCompatController],
	providers: [AiConversationService, OpenAiCompatService]
})
export class AiConversationModule {}
```

---

## Phase 3: Install Dependencies

### `apps/web/package.json` - Add:

```bash
cd /home/ubuntu/projects/ever/ever-works && pnpm add ai @ai-sdk/openai-compatible @ai-sdk/react --filter ever-works-web
```

**Packages:**

- `ai` - Core Vercel AI SDK (streamText, convertToModelMessages, tool, etc.)
- `@ai-sdk/openai-compatible` - OpenAI-compatible provider factory
- `@ai-sdk/react` - React hooks (useChat)

**Version alignment:** `ai@^6.0.85` matches the version already used in `packages/plugins/agent-pipeline/`.

---

## Phase 4: Custom Vercel AI SDK Provider

### Provider Selection Requirements

- `X-Provider-Override` header is **always passed** — the frontend always has an active AI provider selected
- Default provider: `openrouter` (auto-selected via `resolveEffectiveDefault()` from `ChatProvider`)
- Users can switch providers from the chat UI (provider selector buttons)
- The backend `AiFacadeService` uses the override to resolve the correct plugin + settings

### Auth Pattern

- Next.js route handler reads the encrypted JWT from the `everworks_auth_token` cookie via `getAuthAccessCookie()`
- On 401, it attempts a single token refresh via `refreshAccessToken()` (same pattern as `serverFetch`)
- The JWT is passed as `apiKey` to `@ai-sdk/openai-compatible`, which sends it as `Authorization: Bearer <token>`
- No JWT is ever exposed to the client browser

### URL Resolution

- `API_URL` from constants already includes `/api` suffix (e.g., `http://localhost:3100/api`)
- The OpenAI-compat endpoint is at `POST /api/v1/chat/completions`
- So `baseURL` = `${API_URL}/v1` which resolves to `http://localhost:3100/api/v1`

### New File: `apps/web/src/lib/ai/provider.ts`

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface BackendProviderOptions {
	baseURL: string;
	authToken: string;
	providerOverride: string; // Always required — user always has an active AI provider
	workId?: string;
}

export function createBackendProvider(options: BackendProviderOptions) {
	return createOpenAICompatible({
		name: 'ever-works',
		baseURL: options.baseURL,
		apiKey: options.authToken,
		headers: {
			'X-Provider-Override': options.providerOverride,
			...(options.workId && { 'X-Work-Id': options.workId })
		}
	});
}
```

### New File: `apps/web/src/lib/ai/index.ts`

```typescript
export { createBackendProvider, type BackendProviderOptions } from './provider';
```

**Note:** `@ai-sdk/openai-compatible` automatically sends `apiKey` as `Authorization: Bearer <apiKey>`. This matches our JWT auth pattern exactly.

---

## Phase 5: Next.js Route Handler

### New File: `apps/web/src/app/api/chat/route.ts`

```typescript
import { convertToModelMessages, streamText, UIMessage } from 'ai';
import { createBackendProvider } from '@/lib/ai/provider';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { refreshAccessToken } from '@/lib/auth/refresh';
import { API_URL } from '@/lib/constants';

export const maxDuration = 60;

export async function POST(request: Request) {
	// 1. Auth - same pattern as serverFetch
	let token = await getAuthAccessCookie();
	if (!token) {
		const refreshed = await refreshAccessToken();
		if (refreshed) token = await getAuthAccessCookie();
	}
	if (!token) {
		return new Response('Unauthorized', { status: 401 });
	}

	// 2. Parse request
	const body = await request.json();
	const { messages, ...rest } = body as {
		messages: UIMessage[];
		providerOverride?: string;
		workId?: string;
	};

	// 3. Create provider (API_URL already includes /api suffix)
	const provider = createBackendProvider({
		baseURL: `${API_URL}/v1`,
		authToken: token,
		providerOverride: rest.providerOverride ?? 'openrouter',
		workId: rest.workId
	});

	// 4. Stream with Vercel AI SDK
	const result = streamText({
		model: provider('default'),
		messages: await convertToModelMessages(messages)
	});

	return result.toUIMessageStreamResponse();
}
```

**Key details:**

- `maxDuration = 60` allows long streaming responses (Vercel default is 10s)
- Auth follows the same `getAuthAccessCookie` + refresh pattern as `serverFetch`
- Provider/work selection passed from the client as body fields
- `convertToModelMessages()` converts `UIMessage[]` to model-compatible format
- `toUIMessageStreamResponse()` returns the proper streaming response for `useChat`

---

## Phase 6: Frontend Chat UI Refactor

### 6.1 Update `ChatProvider.tsx`

```typescript
'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useTranslations } from 'next-intl';
import type { ProviderOption } from '@/lib/api/types-only';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { toast } from 'sonner';

interface ChatContextValue {
  // From useChat
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
  input: string;
  setInput: (input: string) => void;
  handleSubmit: (e?: { preventDefault?: () => void }) => void;
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  error: Error | undefined;
  stop: () => void;
  reload: () => void;

  // Provider selection
  providers: ProviderOption[];
  selectedProvider: string | null;
  setSelectedProvider: (id: string | null) => void;

  // Custom
  resetChat: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('dashboard.aiChat');
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  const welcomeMessage: UIMessage = {
    id: 'welcome',
    role: 'assistant',
    parts: [{ type: 'text', text: t('welcomeMessage') }],
    createdAt: new Date(),
  };

  const chat = useChat({
    api: '/api/chat',
    body: {
      providerOverride: selectedProvider,
    },
    initialMessages: [welcomeMessage],
  });

  // ... provider fetching (same as current) ...

  const resetChat = useCallback(() => {
    chat.setMessages([welcomeMessage]);
  }, [chat.setMessages, welcomeMessage]);

  const value: ChatContextValue = {
    messages: chat.messages,
    setMessages: chat.setMessages,
    input: chat.input,
    setInput: chat.setInput,
    handleSubmit: chat.handleSubmit,
    status: chat.status,
    error: chat.error,
    stop: chat.stop,
    reload: chat.reload,
    providers,
    selectedProvider,
    setSelectedProvider,
    resetChat,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChatContext must be used within a ChatProvider');
  return context;
}
```

### 6.2 Update `ChatInterface.tsx`

Major simplification - remove:

- `useAIStream` import and all manual streaming logic
- `pendingMessageRef` and `updatePendingMessage`
- `useChatHistory` (now handled by `useChat`)
- Manual message creation in `handleSubmit`
- Custom NDJSON error handling

Replace with:

- `useChatContext()` for all state (messages, input, status, etc.)
- `handleSubmit` from `useChat` (pass directly to form)
- `status === 'streaming'` instead of `isStreaming`
- `message.parts` iteration for rendering (handles text + tool invocations)
- `chat.reload()` for message editing (set messages then reload)

**Message rendering changes:**

```tsx
// Old: message.content (plain string)
// New: message.parts (array of typed parts)
{
	message.parts.map((part, i) => {
		if (part.type === 'text') {
			return (
				<p key={i} className="text-xs leading-relaxed whitespace-pre-wrap">
					{part.text}
				</p>
			);
		}
		if (part.type === 'tool-invocation') {
			return <ToolCallDisplay key={i} toolInvocation={part.toolInvocation} />;
		}
		return null;
	});
}
```

**Message editing approach:**

```typescript
const handleSaveEdit = async () => {
	if (!editingId || !editingContent.trim()) return;
	const editIndex = messages.findIndex((m) => m.id === editingId);
	if (editIndex === -1) return;

	// Truncate to edited message and update content
	const updatedMessages = messages.slice(0, editIndex + 1);
	updatedMessages[editIndex] = {
		...updatedMessages[editIndex],
		parts: [{ type: 'text', text: editingContent.trim() }]
	};

	setMessages(updatedMessages);
	setEditingId(null);
	setEditingContent('');
	reload(); // Re-generate from the edited message
};
```

---

## Phase 7: Cleanup

### Files to Remove

| File                                                         | Reason                           |
| ------------------------------------------------------------ | -------------------------------- |
| `apps/web/src/lib/hooks/use-ai-stream.ts`                    | Replaced by `useChat`            |
| `apps/web/src/lib/hooks/use-chat-history.ts`                 | Replaced by `useChat`            |
| `apps/web/src/lib/api/ai-conversation.ts`                    | Replaced by custom provider      |
| `apps/web/src/app/api/ai-conversations/chat/stream/route.ts` | Replaced by `/api/chat/route.ts` |
| `apps/web/src/lib/utils/next-api.ts`                         | Only used by removed route       |

### Files to Update

| File                                                         | Change                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `apps/web/src/lib/api/index.ts`                              | Remove `export * from './ai-conversation'`                             |
| `apps/web/src/lib/constants.ts`                              | Remove `API_AI_CONVERSATIONS_CHAT_STREAM`, add `API_CHAT: '/api/chat'` |
| `apps/api/src/ai-conversation/ai-conversation.controller.ts` | Mark `@Deprecated()`, keep for now                                     |
| `apps/api/src/ai-conversation/ai-conversation.service.ts`    | Keep (shared `resolveWorkContext` logic)                          |

### Verification Checklist

- Search for `use-ai-stream` imports -> should find none
- Search for `use-chat-history` imports -> should find none
- Search for `aiConversationAPI` imports -> should find none
- Search for `nextApiResponseStreaming` imports -> should find none (after removing next-api.ts)
- Search for `API_AI_CONVERSATIONS_CHAT_STREAM` -> should find none

---

## Testing & Verification

### Manual Testing

1. Start API server: `pnpm dev:api`
2. Test OpenAI-compat endpoint directly with curl:

    ```bash
    # Non-streaming
    curl -X POST http://localhost:3100/api/v1/chat/completions \
      -H "Authorization: Bearer <jwt>" \
      -H "Content-Type: application/json" \
      -d '{"model":"default","messages":[{"role":"user","content":"Hello"}]}'

    # Streaming
    curl -X POST http://localhost:3100/api/v1/chat/completions \
      -H "Authorization: Bearer <jwt>" \
      -H "Content-Type: application/json" \
      -d '{"model":"default","messages":[{"role":"user","content":"Hello"}],"stream":true}'
    ```

3. Start web: `pnpm dev:web`
4. Test chat UI: send messages, verify streaming works
5. Test provider switching
6. Test message editing
7. Test new chat / reset

### Automated Testing

- `cd packages/agent && pnpm test` - Verify no regression in facade/pipeline tests
- `cd packages/plugin && pnpm test` - Verify AiOperations changes don't break tests
- `pnpm type-check` - Full TypeScript check across monorepo
- `pnpm lint` - ESLint check

### Edge Cases

- Auth token expiry during streaming
- Provider not configured (should show error)
- Network interruption during stream
- Empty messages / whitespace-only input
- Long conversations (context window)
- Provider that doesn't support tools (graceful degradation)

---

## Risk Mitigation

1. **LangChain tool binding compatibility**: LangChain's `ChatOpenAI` supports OpenAI-format tools natively. Non-OpenAI providers (Anthropic, Google) using ChatOpenAI with custom baseURL should also work since the tools are passed in OpenAI format. The `withParamRetry` pattern will catch providers that reject tools.

2. **SSE format strictness**: `@ai-sdk/openai-compatible` expects exact OpenAI SSE format. Test with curl before connecting frontend.

3. **Message format migration**: `useChat` uses `UIMessage` with `parts[]` array, not plain `content` string. The ChatInterface rendering must handle this properly.

4. **Parallel operation**: Old and new endpoints can coexist during development. No flag-day cutover required.
