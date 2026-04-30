---
id: ai-components
title: AI Chat Components
sidebar_label: AI Chat Components
sidebar_position: 6
---

# AI Chat Components

The AI chat system provides a conversational interface for creating directories using natural language. It consists of two components in `src/components/ai/` -- a context provider and the chat UI -- backed by the `useAIStream` and `useChatHistory` hooks.

## Architecture Overview

```
ChatProvider (context)
  |-- fetches AI provider list from generator-form schema
  |-- wraps useChatHistory for message state
  |-- manages selected AI provider
  |
  ChatInterface (UI)
      |-- reads context via useChatContext()
      |-- uses useAIStream for streaming responses
      |-- renders message bubbles, provider selector, input form
```

The chat system streams responses from `/api/ai/conversations/chat/stream` using newline-delimited JSON. Each chunk contains optional `content`, `done`, `error`, and `metadata` fields.

## ChatProvider

**File**: `src/components/ai/ChatProvider.tsx`

The provider wraps the chat history hook and adds AI provider management via React Context.

```typescript
interface ChatContextValue extends UseChatHistoryValue {
	providers: ProviderOption[];
	selectedProvider: string | null;
	setSelectedProvider: (id: string | null) => void;
}
```

**Initialization Flow**:

1. Creates a `useChatHistory` instance for message state
2. On mount, calls `getGlobalFormSchema()` server action to fetch available AI providers
3. Extracts the `providers.ai` array from the form schema response
4. Uses `resolveEffectiveDefault()` from `@ever-works/plugin` to auto-select the default provider
5. Stores providers and selected provider in local state

**Provider Option Shape**:

```typescript
interface ProviderOption {
	id: string;
	name: string;
	icon?: PluginIcon;
	configured: boolean;
	isDefault?: boolean;
}
```

**Usage**:

```tsx
// In a layout or page component
<ChatProvider>
	<ChatInterface />
</ChatProvider>
```

**Context Hook**:

```typescript
// Throws if used outside ChatProvider
const context = useChatContext();
```

## ChatInterface

**File**: `src/components/ai/ChatInterface.tsx`

The main chat UI component. It reads all state from `useChatContext()` and manages the streaming interaction.

### Component Structure

The interface is divided into four vertical sections:

1. **Header** -- Title, subtitle, "New Chat" button, and AI provider selector
2. **Message List** -- Scrollable area with message bubbles
3. **Error Banner** -- Displayed when an error occurs
4. **Input Form** -- Auto-resizing textarea with send button

### Provider Selector

When multiple AI providers are available, the header renders a horizontal scrollable row of provider buttons:

```tsx
{
	providers.length > 1 && (
		<div className="flex gap-1.5 overflow-x-auto">
			{providers.map((provider) => (
				<button onClick={() => setSelectedProvider(provider.id)} disabled={!provider.configured || isStreaming}>
					<PluginIcon icon={provider.icon} name={provider.name} size={16} />
					<span>{provider.name}</span>
				</button>
			))}
		</div>
	);
}
```

Unconfigured providers are shown with reduced opacity and wrapped in a `Tooltip` explaining the issue. The active provider shows a checkmark icon.

### Message Handling

Messages use the `ChatMessage` type from `useChatHistory`:

| Role        | Visual Style                        | Description         |
| ----------- | ----------------------------------- | ------------------- |
| `user`      | Purple background, right-aligned    | User input messages |
| `assistant` | Light gray background, left-aligned | AI responses        |

**Streaming Indicator**: When `isStreaming` is true and content is empty, three animated bouncing dots are shown. As content arrives, it renders incrementally as a pre-wrapped paragraph.

**Error Display**: Messages with an `error` field get a red border and show the error text below the content.

**Timestamps**: Each message shows a localized time (HH:MM format) below the content.

### Streaming Flow

The submit handler orchestrates the full message lifecycle:

```typescript
async function handleSubmit(event: FormEvent) {
	// 1. Create user message and empty assistant placeholder
	const userMessage = { id: generateMessageId(), role: 'user', content: input };
	const assistantMessage = { id: generateMessageId(), role: 'assistant', content: '', isStreaming: true };

	// 2. Track the assistant message ID for updates
	pendingMessageRef.current = assistantMessage.id;

	// 3. Add both messages to the history
	setMessages([...messages, userMessage, assistantMessage]);

	// 4. Build chat history (excluding empty placeholder)
	const chatHistory = updatedMessages
		.filter((m) => m.content.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.content }));

	// 5. Stream response from API
	await streamMessage('/api/ai/conversations/chat/stream', {
		messages: chatHistory,
		providerOverride: selectedProvider ?? undefined
	});
}
```

**Chunk Processing**: The `useAIStream` hook is configured with three callbacks:

- `onChunk`: Appends chunk content to the pending assistant message and updates metadata
- `onComplete`: Marks the message as no longer streaming
- `onError`: Sets error message on the pending message and clears streaming state

The `updatePendingMessage` helper uses the tracked `pendingMessageRef` to find and update only the current assistant message in the array.

### Input Behavior

The textarea auto-resizes up to 160px max height:

```typescript
const autoResize = () => {
	const el = textareaRef.current;
	if (!el) return;
	el.style.height = 'auto';
	el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
};
```

**Enter Key**: Submits the form (without Shift). `Shift+Enter` creates a new line.

**Send Button**: Disabled when input is empty or streaming is in progress. Uses a `SendHorizonal` icon from Lucide.

### Reset Conversation

The "New Chat" button calls `handleResetConversation`:

```typescript
const handleResetConversation = () => {
	if (isStreaming) return;
	reset(); // useAIStream: clear content/error/streaming
	resetHistory(); // useChatHistory: reset to initial greeting
	setErrorMessage(null);
	clearPending(); // Clear pendingMessageRef
};
```

### Auto-Scroll

Messages auto-scroll to the bottom when the message list changes:

```typescript
useEffect(() => {
	if (messages.length) {
		scrollToBottom('auto');
	}
}, [messages, scrollToBottom]);
```

The `scrollToBottom` function uses `requestAnimationFrame` and `scrollIntoView` on a sentinel `div` at the end of the message list.

## Integration with Generation System

The AI chat's primary purpose is to help users create directories through natural conversation. When the AI determines the user wants to create a directory, the streaming response metadata may contain directory creation details. The chat endpoint on the backend coordinates with the generation system to:

1. Parse user intent from the conversation
2. Generate directory configuration (name, description, categories)
3. Optionally trigger item generation

The `providerOverride` field sent with each message allows the user to choose which AI provider processes their request, independent of the directory's default provider configuration.

## Styling

The chat interface uses Tailwind CSS with the project's design token system:

- **Dark mode**: All elements use `dark:` variants for full dark mode support
- **Brand colors**: User messages use `bg-brand-purple`, assistant messages use `bg-surface-tertiary`
- **Animations**: Message bubbles use `motion-safe:animate-fade-in`, streaming dots use `animate-bounce` with staggered delays
- **Typography**: Message text uses `text-xs` with `leading-relaxed` and `whitespace-pre-wrap`
