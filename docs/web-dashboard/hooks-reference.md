---
id: hooks-reference
title: Dashboard Hooks Reference
sidebar_label: Hooks Reference
sidebar_position: 5
---

# Dashboard Hooks Reference

The web dashboard provides 10 custom React hooks in `src/lib/hooks/`. All hooks are client-side (`'use client'`) and handle concerns ranging from AI streaming to theme persistence. This page documents each hook's interface, internal behavior, and usage patterns.

## File Overview

```
src/lib/hooks/
  use-ai-stream.ts            # Server-sent event streaming for AI chat
  use-chat-history.ts          # Chat message state management
  use-keyboard-shortcuts.ts    # Global keyboard shortcut bindings
  use-local-storage.ts         # SSR-safe localStorage synchronization
  use-mounted.ts               # Client-side mount detection
  use-plugin-settings.ts       # Plugin settings form management
  use-plugin-toggle.ts         # Plugin enable/disable with optimistic UI
  use-provider-selection.ts    # AI/search/screenshot provider picker state
  use-sidebar-persistence.ts   # Sidebar width and collapsed state persistence
  use-theme.ts                 # Dark/light theme management
```

## useAIStream

Manages streaming responses from the AI chat endpoint using the Fetch API's `ReadableStream`.

```typescript
interface StreamChunk {
    content?: string;
    done?: boolean;
    error?: string;
    metadata?: Record<string, any>;
}

interface UseAIStreamOptions {
    onChunk?: (chunk: StreamChunk) => void;
    onComplete?: (fullContent: string) => void;
    onError?: (error: Error) => void;
}

function useAIStream(options?: UseAIStreamOptions): {
    streamMessage: (endpoint: string, data: any) => Promise<string>;
    isStreaming: boolean;
    content: string;
    error: Error | null;
    reset: () => void;
};
```

**Internal Behavior**:
- Sends a POST request to the streaming endpoint and reads the response body via `ReadableStream.getReader()`
- Parses newline-delimited JSON chunks with a resilient parser that handles partial JSON and non-JSON prefix text
- Accumulates content from each chunk into a single string, updating React state after each chunk
- Calls `onChunk` for every parsed chunk, `onComplete` when `done: true` or the stream ends, and `onError` on failure
- The `reset` function clears content, error, and streaming state

## useChatHistory

Manages the chat message list for the AI chat interface.

```typescript
type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'function';

type ChatMessage = {
    id: string;
    role: ChatMessageRole;
    content: string;
    timestamp: string | null;
    isStreaming?: boolean;
    metadata?: Record<string, any>;
    error?: string;
};

function useChatHistory(): {
    messages: ChatMessage[];
    error: string | null;
    isLoading: boolean;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    loadHistory: () => void;
    resetHistory: () => void;
};
```

**Internal Behavior**:
- Initializes with an empty message array and sets `isLoading: true`
- `loadHistory()` populates the array with a single initial assistant greeting message; uses a ref to ensure it only runs once
- `resetHistory()` resets to the initial greeting and clears the loaded ref
- `generateMessageId()` is exported as a utility: creates IDs like `msg_1709123456789_a3b2c1`
- Returns a memoized value object to avoid unnecessary re-renders

## useKeyboardShortcuts

Registers global keyboard shortcuts for the dashboard.

```typescript
interface KeyboardShortcutsOptions {
    onOpenHelp?: () => void;
}

function useKeyboardShortcuts(options?: KeyboardShortcutsOptions): void;
```

**Registered Shortcuts**:

| Shortcut | Condition | Action |
|----------|-----------|--------|
| `Ctrl/Cmd + K` | Always | Navigate to directories page with search focused |
| `C` | Not in input field | Navigate to new directory page |
| `?` | Not in input field, `onOpenHelp` provided | Open help drawer |

**Internal Behavior**:
- Uses `useEffect` to add a `keydown` event listener on `document`
- Detects input fields (`input`, `textarea`, `select`, `contentEditable`) and skips non-modifier shortcuts when focus is inside one
- Uses `next-intl` aware `useRouter` for navigation

## useLocalStorage

SSR-safe hook that synchronizes React state with `localStorage`.

```typescript
function useLocalStorage<T>(
    key: string,
    defaultValue: T,
    options?: {
        serialize?: (value: T) => string;
        deserialize?: (raw: string) => T;
        validate?: (value: T) => boolean;
    },
): [T, (value: T) => void];
```

**Hydration Strategy**:
1. Always initializes with `defaultValue` so the server render matches the first client render (no hydration mismatch)
2. Uses `useIsomorphicLayoutEffect` (runs `useLayoutEffect` on client, `useEffect` on server) to read from `localStorage` **before the browser paints**, eliminating any visible flash
3. Listens for `StorageEvent` to sync across tabs/windows

**Ref Pattern**: `serialize`, `deserialize`, and `validate` callbacks are stored in refs and updated every render. This avoids stale closures when callers pass inline function literals, and avoids requiring them as effect dependencies.

## useMounted

Simple hook to detect when the component has mounted on the client.

```typescript
function useMounted(): boolean;
```

Returns `false` during SSR and the first render, then `true` after `useEffect` fires. Useful for gating client-only rendering.

## usePluginSettings

Manages the state and lifecycle of a plugin settings form, including validation, secret field handling, and save operations.

```typescript
interface UsePluginSettingsOptions {
    schema: PluginSettingsSchema | undefined;
    initialSettings: Record<string, unknown>;
    scopes: SettingScopeApi[];
    onSave: (data: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
    }) => Promise<void>;
    fallbackSettings?: Record<string, unknown>;
    scope: 'user' | 'directory';
}

function usePluginSettings(options: UsePluginSettingsOptions): {
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
    hasChanges: boolean;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    hasSettings: boolean;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
};
```

**Key Features**:
- **Secret Splitting**: Separates settings into regular and secret buckets using `splitSettingsBySecret` from `@ever-works/plugin/api`
- **Visible Properties**: Filters schema properties based on scopes to determine which fields to render
- **Required Validation**: Uses `validateRequiredSettings` to check all required fields before saving; directory scope allows inheritance from `fallbackSettings`
- **Constraint Validation**: Uses `validateSettingsConstraints` for value range and pattern checks
- **Fallback Display**: `getFieldValue` shows inherited values from `fallbackSettings` when no local value exists, but respects user modifications (even empty values)
- **Sync on Refresh**: Detects when `initialSettings` changes (e.g., after `router.refresh()`) and resets local state
- **Save Flow**: Sanitizes settings via `sanitizeSettingsForSave`, calls `onSave`, updates local state, clears modified fields, shows success indicator for 3 seconds

## usePluginToggle

Manages plugin enable/disable with optimistic UI updates and confirmation dialogs.

```typescript
interface UsePluginToggleOptions {
    pluginId: string;
    enabled: boolean;
    visibility: string;
}

function usePluginToggle(options: UsePluginToggleOptions): {
    isPending: boolean;
    optimisticEnabled: boolean;
    showDisableWarning: boolean;
    showEnablePanel: boolean;
    autoEnableForDirs: boolean;
    setAutoEnableForDirs: (value: boolean) => void;
    handleToggle: () => void;
    handleCancelEnable: () => void;
    handleCancelDisable: () => void;
};
```

**Toggle Flow**:
- **Enable**: If the plugin supports directory scope, shows an enable panel with an auto-enable checkbox first. On confirm, optimistically sets enabled state and calls `enablePlugin` server action via `useTransition`.
- **Disable**: Shows a cascade warning dialog first. On confirm, optimistically disables and calls `disablePlugin`.
- **Rollback**: If the server action fails, the optimistic state is reverted.

## useProviderSelection

Manages the selection state for AI provider categories (search, screenshot, AI, content extractor, pipeline).

```typescript
function useProviderSelection(initial?: Partial<ProviderSelectionState>): {
    providers: ProviderSelectionState;
    handleProviderChange: (category: SelectableProviderCategory, value: string | null) => void;
    buildSelectedProviders: (formSchema?: GeneratorFormSchema | null) => Record<string, string> | undefined;
    getUnconfiguredProviders: (formSchema: GeneratorFormSchema | null) => string[];
    syncResolvedPipeline: (formSchema: GeneratorFormSchema) => string | null;
};
```

**Provider Categories**:

| Category | Description |
|----------|-------------|
| `search` | Web search provider (e.g., Exa, Tavily) |
| `screenshot` | Screenshot provider (e.g., ScreenshotOne) |
| `ai` | AI provider (e.g., OpenAI, Anthropic) |
| `contentExtractor` | Content extraction provider |
| `pipeline` | Generation pipeline (e.g., agent-pipeline) |

The `syncResolvedPipeline` method auto-selects the backend-resolved pipeline ID when no pipeline is explicitly chosen.

## useSidebarPersistence

Persists sidebar width and collapsed state using `useLocalStorage`.

```typescript
function useSidebarPersistence(): {
    sidebarWidth: number;        // default: 320, range: 320-440
    sidebarCollapsed: boolean;   // default: false
    handleSidebarWidthChange: (width: number) => void;
    handleSidebarCollapsedChange: (collapsed: boolean) => void;
};
```

**Storage Keys and Serialization**:

| Key | Default | Serialize | Deserialize | Validate |
|-----|---------|-----------|-------------|----------|
| `sidebar-width` | `320` | `String` | `parseInt(raw, 10)` | `!isNaN(v) && v >= 320 && v <= 440` |
| `sidebar-collapsed` | `false` | `v ? '1' : '0'` | `raw === '1'` | (none) |

## useTheme

Manages dark/light theme with localStorage persistence and system preference detection.

```typescript
type Theme = 'light' | 'dark';

function useTheme(): {
    theme: Theme;
    isDark: boolean;
    toggleTheme: (newTheme?: Theme) => void;
    mounted: boolean;
};
```

**Initialization Order**:
1. Starts with `'light'` as default state (safe for SSR)
2. On mount, checks `localStorage` for stored theme preference
3. Falls back to `window.matchMedia('(prefers-color-scheme: dark)')` system preference
4. Applies theme by adding/removing the `dark` class on `document.documentElement`

**Storage**: Uses the key `theme` in `localStorage`, storing the raw string `'light'` or `'dark'`.

The `mounted` boolean allows components to avoid rendering theme-dependent UI until the actual theme is known, preventing flash of incorrect theme.
