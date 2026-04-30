---
id: openai-plugin-deep-dive
title: "OpenAI Plugin Deep Dive"
sidebar_label: "OpenAI Deep Dive"
sidebar_position: 53
---

# OpenAI Plugin Deep Dive

## Overview

The OpenAI plugin connects Ever Works to OpenAI's API for AI-powered content generation, conversational AI, and text embeddings. It extends the `BaseAiProvider` abstract class and uses the shared `AiOperations` utility (which wraps LangChain) to provide a consistent interface across all AI provider plugins. Users supply their own API key to connect directly to OpenAI.

## Architecture

The plugin extends `BaseAiProvider` from `@ever-works/plugin/abstract`, which provides common AI provider scaffolding including tiered model resolution and configuration merging. The actual API communication is handled by `AiOperations` from `@ever-works/plugin/ai`, which wraps LangChain's OpenAI integration.

```
OpenAiPlugin (extends BaseAiProvider)
  |-- AiOperations (@ever-works/plugin/ai)
       |-- LangChain (@langchain/openai)
            |-- OpenAI REST API
```

On `onLoad`, the plugin creates an `AiOperations` instance with default configuration. Each request then calls `resolveConfig(options.settings)` to merge user-provided settings (API key, model, temperature) with the defaults, ensuring per-request customisation.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| N/A | -- | No environment-variable fallbacks; users provide their own API key |

### Settings Schema

```typescript
interface OpenAiSettings {
  apiKey: string;           // OpenAI API key (x-secret, user-scoped, required)
  defaultModel: string;     // Default model for all tasks (default: 'gpt-5.1')
  simpleModel: string;      // Model for tags, short descriptions (default: 'gpt-5-nano')
  mediumModel: string;      // Model for listings, summaries (default: 'gpt-4o-mini')
  complexModel: string;     // Model for full-page generation (default: 'gpt-5.1')
  temperature: number;      // Response randomness, 0-2 (default: 0.7, hidden)
  maxTokens: number;        // Max response length (default: 4096, hidden)
  baseUrl: string;          // API endpoint (default: 'https://api.openai.com/v1', hidden)
}
```

- `configurationMode`: `user-required` -- each user must provide their own OpenAI API key.
- Model fields use the `x-widget: 'model-select'` custom widget for UI rendering.
- `temperature`, `maxTokens`, and `baseUrl` are hidden from the default settings UI but available for advanced configuration.

## Capabilities

| Capability | Supported | Details |
|------------|-----------|---------|
| Structured output | Yes | JSON mode and function calling |
| Streaming | Yes | Server-sent events via async iterables |
| Tool calling | Yes | Function/tool calling for structured extraction |
| Vision | Yes | Image analysis with multimodal models |
| Embeddings | Yes | `text-embedding-3-small` and others |
| Max context | 128,000 tokens | For supported models like GPT-4o |

## API Reference

### Chat Completion

| Method | Signature | Description |
|--------|-----------|-------------|
| `createChatCompletion` | `(options: ChatCompletionOptions) => Promise<ChatCompletionResponse>` | Single-shot completion |
| `createStreamingChatCompletion` | `(options: ChatCompletionOptions) => AsyncIterable<ChatCompletionChunk>` | Streaming completion via async generator |

### Embeddings

| Method | Signature | Description |
|--------|-----------|-------------|
| `createEmbedding` | `(options: EmbeddingOptions) => Promise<EmbeddingResponse>` | Generate text embeddings |

### Model Management

| Method | Signature | Description |
|--------|-----------|-------------|
| `listModels` | `(settings?) => Promise<readonly AiModel[]>` | Lists available models from the OpenAI API |
| `isAvailable` | `(settings?) => Promise<boolean>` | Tests connection by calling `testConnection` |
| `getCapabilities` | `() => AiModelCapabilities` | Returns static capability flags |

## Implementation Details

### Tiered Model Resolution

The `BaseAiProvider.resolveConfig()` method (inherited) merges settings from the 4-level hierarchy (directory > user > admin > env) and resolves the correct model for the requested complexity tier:

- **Simple tier**: `simpleModel` setting (default: `gpt-5-nano`) -- used for tags, short descriptions, quick classifications.
- **Medium tier**: `mediumModel` setting (default: `gpt-4o-mini`) -- used for listings, summaries, content reformatting.
- **Complex tier**: `complexModel` setting (default: `gpt-5.1`) -- used for full page generation and multi-step analysis.
- **Default**: `defaultModel` setting (default: `gpt-5.1`) -- fallback for all other tasks.

### AiOperations Wrapper

`AiOperations` is the shared utility that wraps LangChain. It handles:

- Model instantiation based on `providerType: 'openai'`
- Structured output parsing
- Streaming response iteration
- Embedding generation
- Connection testing

### Stateless Request Handling

Each call to `createChatCompletion` or `createStreamingChatCompletion` calls `resolveConfig(options.settings)` to produce a fresh configuration object. This means every request can have different settings (different API key, model, temperature) without affecting other requests.

## Usage Examples

```typescript
// Non-streaming chat completion
const response = await openaiPlugin.createChatCompletion({
  messages: [
    { role: 'system', content: 'You are a directory content writer.' },
    { role: 'user', content: 'Write a description for Acme Corp.' }
  ],
  settings: { apiKey: userApiKey, defaultModel: 'gpt-4o-mini' }
});

// Streaming chat completion
for await (const chunk of openaiPlugin.createStreamingChatCompletion({
  messages: [{ role: 'user', content: 'Summarize this company...' }],
  settings: { apiKey: userApiKey }
})) {
  process.stdout.write(chunk.content || '');
}

// Generate embeddings
const embedding = await openaiPlugin.createEmbedding({
  input: 'AI-powered directory builder',
  model: 'text-embedding-3-small',
  settings: { apiKey: userApiKey }
});

// Check availability
const available = await openaiPlugin.isAvailable({ apiKey: userApiKey });
```

## Rate Limiting & Quotas

- **OpenAI API limits**: Depend on the user's OpenAI account tier. Free tier accounts have strict RPM (requests per minute) and TPM (tokens per minute) limits; paid tiers have progressively higher limits.
- **Max tokens**: Defaults to 4,096 per response. Configurable via the `maxTokens` setting.
- **Context window**: Up to 128,000 tokens for GPT-4o class models.
- The plugin does not implement internal rate-limit tracking. OpenAI returns `429 Too Many Requests` errors which propagate to callers.

## Error Handling

- **Plugin not loaded**: All methods throw `Error('OpenAI plugin not loaded')` if called before `onLoad`.
- **Connection test**: `isAvailable` calls `testConnection`, which makes a minimal API call and returns `{ success: boolean }`. Returns `false` on any failure.
- **LangChain errors**: Errors from the underlying LangChain/OpenAI SDK propagate directly. Common errors include invalid API key (401), rate limiting (429), and context length exceeded (400).
- **Missing API key**: If settings do not include `apiKey`, the underlying `AiOperations` will throw when attempting the API call.

## Related Plugins

- [Anthropic Plugin Deep Dive](./anthropic-plugin-deep-dive) -- alternative AI provider using Claude models.
- [Ollama Plugin Deep Dive](./ollama-plugin-deep-dive) -- self-hosted AI provider for local inference.
- [OpenAI Plugin](./openai-plugin) -- overview documentation for the OpenAI plugin.
