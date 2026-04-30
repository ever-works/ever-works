---
id: ai-components-deep-dive
title: AI Components Deep Dive
sidebar_label: AI Components
sidebar_position: 22
---

# AI Components Deep Dive

## Overview

The AI components provide an embedded conversational interface within the Ever Works dashboard. Users can chat with AI models directly from the sidebar without leaving their current workflow. The system supports multiple AI providers, streaming responses via NDJSON over HTTP, and persists conversation history. All AI components live in `apps/web/src/components/ai/` and rely on custom hooks from `apps/web/src/lib/hooks/`.

## Architecture

```
ChatProvider (React Context)
├── useChatHistory (message state management)
├── useProviderSelection (AI provider state)
├── getGlobalFormSchema → resolveEffectiveDefault (default provider resolution)
│
└── ChatInterface (UI)
    ├── Provider selection bar
    ├── Message list with auto-scroll
    ├── Streaming indicator (bouncing dots)
    ├── useAIStream (fetch + ReadableStream NDJSON parsing)
    └── Auto-resize textarea input
```

The `ChatProvider` wraps the entire AI chat experience in a React Context, making chat state (messages, providers, streaming status) available to any descendant component. `ChatInterface` is the primary consumer that renders the full chat UI.

## Components

### ChatProvider

**File:** `apps/web/src/components/ai/ChatProvider.tsx`

| Prop       | Type        | Description                                    |
| ---------- | ----------- | ---------------------------------------------- |
| `children` | `ReactNode` | Child components that consume the chat context |

`ChatProvider` is a React Context provider that composes two hooks:

1. **`useChatHistory`** - Manages the message array, loading state, and history persistence.
2. **`useProviderSelection`** - Manages which AI provider and model are selected.

On mount, it fetches the global form schema via `getGlobalFormSchema` server action, then uses `resolveEffectiveDefault` from `@ever-works/plugin` to determine the default AI provider. This means the chat automatically selects whatever AI provider the user has configured as their default.

The context value exposes:

```typescript
interface ChatContextValue {
	messages: ChatMessage[];
	setMessages: (msgs: ChatMessage[]) => void;
	loadHistory: () => Promise<void>;
	resetHistory: () => void;
	isLoading: boolean;
	error: string | null;
	providers: ProviderSelectionState;
	handleProviderChange: (field: string, value: string) => void;
}
```

```tsx
import { ChatProvider } from '@/components/ai/ChatProvider';

<ChatProvider>
	<ChatInterface />
</ChatProvider>;
```

### ChatInterface

**File:** `apps/web/src/components/ai/ChatInterface.tsx`

This component takes no props and consumes the chat context via `useChatContext()`. It renders:

1. **Provider selection bar** - A compact row at the top where users can switch AI providers and models. Only shown when multiple providers are available.

2. **Message list** - Scrollable area displaying all messages. User messages are right-aligned with a primary-colored background. Assistant messages are left-aligned with a muted background. Each message shows its content with Markdown rendering support.

3. **Streaming indicator** - When the AI is generating a response, three bouncing dots appear as a visual indicator. The partial content is rendered in real-time as chunks arrive.

4. **Input area** - An auto-resizing textarea at the bottom. Pressing Enter sends the message (Shift+Enter for newlines). A send button is also provided.

**Message flow:**

1. User types a message and presses Enter.
2. The message is appended to the local message list with role `user`.
3. `streamMessage` from `useAIStream` is called, which POSTs to the streaming API endpoint.
4. As NDJSON chunks arrive, the assistant's response is progressively rendered.
5. On completion, the full response is committed to the message list with role `assistant`.

```tsx
import { ChatInterface } from '@/components/ai/ChatInterface';

// Must be wrapped in ChatProvider
<ChatProvider>
	<ChatInterface />
</ChatProvider>;
```

## Implementation Details

### Streaming Protocol

The chat uses NDJSON (newline-delimited JSON) streaming over HTTP. The `useAIStream` hook (see [Web Hooks Reference](./web-hooks-reference.md)) handles the protocol:

1. A `fetch` POST request is sent to the chat stream endpoint with the conversation payload.
2. The response body is a `ReadableStream`.
3. A `TextDecoder` processes the stream, splitting on newlines.
4. Each line is parsed as JSON, and the `onChunk` callback receives the parsed data.
5. Content chunks are concatenated to build the full response progressively.
6. On stream completion, `onComplete` fires with the final assembled content.

The streaming endpoint is defined as `ROUTES.API_AI_CONVERSATIONS_CHAT_STREAM` which maps to `/api/ai-conversations/chat/stream`.

### Provider Resolution

The default AI provider is resolved at context initialization time:

1. `getGlobalFormSchema` fetches the schema for all configured AI plugins.
2. `resolveEffectiveDefault` from `@ever-works/plugin` examines the schema to find which provider is marked as the default.
3. The resolved provider ID and model are set as the initial selection in `useProviderSelection`.

Users can override the selection at any time via the provider bar in `ChatInterface`.

### Auto-scroll Behavior

The message list auto-scrolls to the bottom when:

- A new message is added (user or assistant).
- New streaming content arrives.

This is implemented with a `useEffect` that watches the messages array and streaming content, calling `scrollIntoView` on a sentinel element at the bottom of the list.

### Message Types

```typescript
type ChatMessageRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
	id: string;
	role: ChatMessageRole;
	content: string;
	createdAt?: string;
}
```

## Styling & Theming

The chat interface follows the project's design token system:

| Element                  | Light Mode                            | Dark Mode                            |
| ------------------------ | ------------------------------------- | ------------------------------------ |
| User message bubble      | `bg-primary text-white`               | Same                                 |
| Assistant message bubble | `bg-surface-secondary`                | `bg-surface-secondary-dark`          |
| Input area               | `bg-white border-border`              | `bg-surface-dark border-border-dark` |
| Streaming dots           | `bg-text-muted` with bounce animation | `bg-text-muted-dark`                 |

The streaming indicator uses a CSS animation with staggered delays on three dots to create a bouncing effect. The auto-resize textarea grows vertically as the user types, up to a maximum height, then switches to scrollable overflow.

## Usage Examples

### Embedding Chat in a Custom Layout

```tsx
'use client';

import { ChatProvider } from '@/components/ai/ChatProvider';
import { ChatInterface } from '@/components/ai/ChatInterface';

export function AIChatPanel() {
	return (
		<div className="h-full flex flex-col">
			<ChatProvider>
				<ChatInterface />
			</ChatProvider>
		</div>
	);
}
```

### Accessing Chat Context from a Custom Component

```tsx
'use client';

import { useChatContext } from '@/components/ai/ChatProvider';

export function ChatMessageCount() {
	const { messages } = useChatContext();
	return <span>{messages.length} messages</span>;
}
```

## Related Components

- [Dashboard Layout](./dashboard-layout.md) - ChatInterface is embedded in the DashboardSidebar
- [Web Hooks Reference](./web-hooks-reference.md) - useAIStream, useChatHistory, useProviderSelection hooks
- [Web API Routes](./web-api-routes.md) - The streaming chat API endpoint
- [Server Actions Deep Dive](./server-actions-deep-dive.md) - getGlobalFormSchema used for provider resolution
