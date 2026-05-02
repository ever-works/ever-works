---
id: anthropic-plugin-deep-dive
title: 'Anthropic Plugin Deep Dive'
sidebar_label: 'Anthropic Deep Dive'
sidebar_position: 54
---

# Anthropic Plugin Deep Dive

## Overview

The Anthropic plugin connects Ever Works to Anthropic's Claude API for AI-powered content generation and conversational AI. It extends the `BaseAiProvider` abstract class and uses the shared `AiOperations` utility (wrapping LangChain) to provide chat completions and streaming responses. Claude models are recognized for their large context windows and strong instruction-following capabilities, making them well-suited for work content generation.

## Architecture

The plugin extends `BaseAiProvider` from `@ever-works/plugin/abstract` and delegates all API communication to `AiOperations` from `@ever-works/plugin/ai`, which wraps LangChain's Anthropic integration.

```
AnthropicPlugin (extends BaseAiProvider)
  |-- AiOperations (@ever-works/plugin/ai)
       |-- LangChain (@langchain/anthropic)
            |-- Anthropic Messages API
```

On `onLoad`, the plugin creates an `AiOperations` instance configured with `providerType: 'anthropic'` and the default Claude Sonnet model. Each request resolves its own configuration from the settings hierarchy, enabling per-request model and key customisation.

## Configuration

### Environment Variables

| Variable | Required | Description                                                        |
| -------- | -------- | ------------------------------------------------------------------ |
| N/A      | --       | No environment-variable fallbacks; users provide their own API key |

### Settings Schema

```typescript
interface AnthropicSettings {
	apiKey: string; // Anthropic API key (x-secret, user-scoped, required)
	defaultModel: string; // Default model (default: 'claude-sonnet-4-5-20250514')
	simpleModel: string; // Simple tasks model (default: 'claude-haiku-4-5-20251001')
	mediumModel: string; // Standard tasks model (default: 'claude-sonnet-4-5-20250929')
	complexModel: string; // Complex tasks model (default: 'claude-sonnet-4-5-20250514')
	baseUrl: string; // Custom API endpoint (default: 'https://api.anthropic.com/v1/', hidden)
	temperature: number; // Response randomness, 0-2 (default: 0.7, hidden)
	maxTokens: number; // Max response length (default: 4096, hidden)
}
```

- `configurationMode`: `user-required` -- each user must provide their own Anthropic API key.
- Model fields use the `x-widget: 'model-select'` custom widget.
- The `baseUrl` setting supports custom proxies or compatible API services.

## Capabilities

| Capability        | Supported      | Details                                                 |
| ----------------- | -------------- | ------------------------------------------------------- |
| Structured output | Yes            | JSON mode and tool use                                  |
| Streaming         | Yes            | Server-sent events via async iterables                  |
| Tool calling      | Yes            | Tool use for structured data extraction                 |
| Vision            | Yes            | Image analysis with Claude models                       |
| Embeddings        | No             | Throws `Error('Embeddings not supported by Anthropic')` |
| Max context       | 200,000 tokens | Claude's extended context window                        |

**Important**: Anthropic does not offer an embeddings API. The `createEmbedding` method throws an explicit error. If you need embeddings alongside Anthropic for chat, use a secondary provider (e.g., OpenAI) for embedding generation.

## API Reference

### Chat Completion

| Method                          | Signature                                                                | Description                              |
| ------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `createChatCompletion`          | `(options: ChatCompletionOptions) => Promise<ChatCompletionResponse>`    | Single-shot completion                   |
| `createStreamingChatCompletion` | `(options: ChatCompletionOptions) => AsyncIterable<ChatCompletionChunk>` | Streaming completion via async generator |

### Embeddings

| Method            | Signature                                                   | Description                        |
| ----------------- | ----------------------------------------------------------- | ---------------------------------- |
| `createEmbedding` | `(options: EmbeddingOptions) => Promise<EmbeddingResponse>` | **Not supported** -- always throws |

### Model Management

| Method            | Signature                                    | Description                       |
| ----------------- | -------------------------------------------- | --------------------------------- |
| `listModels`      | `(settings?) => Promise<readonly AiModel[]>` | Lists available Claude models     |
| `isAvailable`     | `(settings?) => Promise<boolean>`            | Tests connection to Anthropic API |
| `getCapabilities` | `() => AiModelCapabilities`                  | Returns static capability flags   |

## Implementation Details

### Tiered Model Resolution

The inherited `resolveConfig()` method resolves the appropriate Claude model for the task tier:

- **Simple tier**: `claude-haiku-4-5-20251001` -- optimized for speed; handles tags, short descriptions, quick classifications.
- **Medium tier**: `claude-sonnet-4-5-20250929` -- balanced speed and quality; handles listings, summaries, content reformatting.
- **Complex tier**: `claude-sonnet-4-5-20250514` -- highest quality; handles full page generation and multi-step analysis.
- **Default**: `claude-sonnet-4-5-20250514` -- fallback for unspecified tiers.

### No Embedding Support

Unlike OpenAI, Anthropic does not provide embedding models. The `createEmbedding` method is implemented as a hard error:

```typescript
async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
  throw new Error('Embeddings not supported by Anthropic');
}
```

Works that require semantic search should pair Anthropic (for generation) with a separate embedding provider.

### 200K Context Window

Claude models support up to 200,000 tokens of context, which is reported via `getCapabilities()`. This allows processing large source documents or entire website contents in a single request during work generation.

## Usage Examples

```typescript
// Non-streaming chat completion with Claude
const response = await anthropicPlugin.createChatCompletion({
	messages: [
		{ role: 'system', content: 'You are a work content writer.' },
		{ role: 'user', content: 'Write a detailed description for Acme Corp.' }
	],
	settings: { apiKey: userApiKey, defaultModel: 'claude-sonnet-4-5-20250514' }
});

// Streaming chat completion
for await (const chunk of anthropicPlugin.createStreamingChatCompletion({
	messages: [{ role: 'user', content: 'Summarize this company...' }],
	settings: { apiKey: userApiKey }
})) {
	process.stdout.write(chunk.content || '');
}

// List available models
const models = await anthropicPlugin.listModels({ apiKey: userApiKey });

// Check availability
const available = await anthropicPlugin.isAvailable({ apiKey: userApiKey });
```

## Rate Limiting & Quotas

- **Anthropic API limits**: Depend on the user's usage tier. Tier 1 starts at 50 RPM and 40,000 TPM; higher tiers increase these limits significantly.
- **Max tokens**: Defaults to 4,096 per response. Claude models support up to 8,192 output tokens; configurable via the `maxTokens` setting.
- **Context window**: Up to 200,000 tokens input.
- The plugin does not implement internal rate-limit tracking. Anthropic returns `429` errors which propagate to callers.

## Error Handling

- **Plugin not loaded**: All methods throw `Error('Anthropic plugin not loaded')` if called before `onLoad`.
- **Embedding requests**: Always throw `Error('Embeddings not supported by Anthropic')`.
- **Connection test**: `isAvailable` calls `testConnection` and returns `false` on any failure, including invalid API keys or network errors.
- **LangChain errors**: Errors from the underlying LangChain Anthropic SDK propagate directly. Common errors include authentication failure (401), rate limiting (429), and overloaded API (529).

## Related Plugins

- [OpenAI Plugin Deep Dive](./openai-plugin-deep-dive) -- alternative AI provider with embedding support.
- [Ollama Plugin Deep Dive](./ollama-plugin-deep-dive) -- self-hosted AI provider for private inference.
- [Anthropic Plugin](./anthropic-plugin) -- overview documentation for the Anthropic plugin.
