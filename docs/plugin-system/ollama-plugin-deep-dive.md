---
id: ollama-plugin-deep-dive
title: 'Ollama Plugin Deep Dive'
sidebar_label: 'Ollama Deep Dive'
sidebar_position: 59
---

# Ollama Plugin Deep Dive

## Overview

The Ollama plugin connects Ever Works to a self-hosted Ollama server for private, local AI inference. It extends the `BaseAiProvider` abstract class and uses the shared `AiOperations` utility (wrapping LangChain) to provide chat completions, streaming responses, and embeddings. Because the Ollama server runs on the user's own infrastructure, all data stays private and there are no per-request API costs. The plugin supports any model that Ollama can serve, including Llama, Mistral, Gemma, and many others.

## Architecture

The plugin extends `BaseAiProvider` from `@ever-works/plugin/abstract` and delegates all API communication to `AiOperations` from `@ever-works/plugin/ai`, which wraps LangChain's OpenAI-compatible integration pointed at the Ollama server's `/v1` endpoint.

```
OllamaPlugin (extends BaseAiProvider)
  |-- AiOperations (@ever-works/plugin/ai)
       |-- LangChain (OpenAI-compatible client)
            |-- Ollama /v1 API (OpenAI-compatible endpoint)
```

On `onLoad`, the plugin creates an `AiOperations` instance configured with `providerType: 'ollama'`, the default model `ministral-3:8b`, and a base URL of `http://localhost:11434/v1`. The API key defaults to `'ollama'` since most Ollama installations do not require authentication. Each request resolves its own configuration from the settings hierarchy, enabling per-request model and URL customisation.

## Configuration

### Environment Variables

| Variable | Required | Description                                                                |
| -------- | -------- | -------------------------------------------------------------------------- |
| N/A      | --       | No environment-variable fallbacks; users configure the server URL directly |

### Settings Schema

```typescript
interface OllamaSettings {
	baseUrl: string; // Ollama server URL (user-scoped, required, e.g. 'http://localhost:11434/v1')
	apiKey: string; // API key, usually not needed (default: 'ollama', user-scoped)
	defaultModel: string; // Default model (default: 'ministral-3:8b', global scope)
	simpleModel: string; // Simple tasks model (default: 'ministral-3:8b', global scope)
	mediumModel: string; // Standard tasks model (default: 'ministral-3:8b', global scope)
	complexModel: string; // Complex tasks model (default: 'ministral-3:8b', global scope)
	temperature: number; // Response randomness, 0-2 (default: 0.7, hidden)
	maxTokens: number; // Max response length (default: 4096, hidden)
}
```

- `configurationMode`: `user-required` -- each user must configure their own Ollama server URL.
- Model fields use the `x-widget: 'model-select'` custom widget.
- `baseUrl` and `defaultModel` are the only required fields.
- The `apiKey` defaults to `'ollama'` and is only needed for secured Ollama instances behind an authentication proxy.

## Capabilities

| Capability        | Supported      | Details                                      |
| ----------------- | -------------- | -------------------------------------------- |
| Structured output | Yes            | JSON mode and tool use                       |
| Streaming         | Yes            | Async iterables via AiOperations             |
| Tool calling      | Yes            | Depends on the model's support               |
| Vision            | Yes            | Depends on the model's support (e.g., LLaVA) |
| Embeddings        | Yes            | Models like `nomic-embed-text`               |
| Max context       | 128,000 tokens | Reported via `getCapabilities()`             |

**Note**: Actual capability support depends on the specific Ollama model being used. The plugin reports all capabilities as supported, but models that lack vision, tool calling, or embedding support will fail gracefully at the model level.

## API Reference

### Chat Completion

| Method                          | Signature                                                                | Description                              |
| ------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `createChatCompletion`          | `(options: ChatCompletionOptions) => Promise<ChatCompletionResponse>`    | Single-shot completion                   |
| `createStreamingChatCompletion` | `(options: ChatCompletionOptions) => AsyncIterable<ChatCompletionChunk>` | Streaming completion via async generator |

### Embeddings

| Method            | Signature                                                   | Description                                               |
| ----------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `createEmbedding` | `(options: EmbeddingOptions) => Promise<EmbeddingResponse>` | Generate embeddings (requires an embedding-capable model) |

### Model Management

| Method            | Signature                                    | Description                                 |
| ----------------- | -------------------------------------------- | ------------------------------------------- |
| `listModels`      | `(settings?) => Promise<readonly AiModel[]>` | Lists models available on the Ollama server |
| `isAvailable`     | `(settings?) => Promise<boolean>`            | Tests connection to the Ollama server       |
| `getCapabilities` | `() => AiModelCapabilities`                  | Returns static capability flags             |

## Implementation Details

### Tiered Model Resolution

The inherited `resolveConfig()` method from `BaseAiProvider` resolves the appropriate model for the task tier. Unlike cloud providers which use different model families for each tier, Ollama defaults all tiers to the same model (`ministral-3:8b`) since model availability depends on what the user has pulled locally:

- **Simple tier**: `ministral-3:8b` -- tags, short descriptions, quick classifications.
- **Medium tier**: `ministral-3:8b` -- listings, summaries, content reformatting.
- **Complex tier**: `ministral-3:8b` -- full page generation and multi-step analysis.
- **Default**: `ministral-3:8b` -- fallback for unspecified tiers.

Users are expected to customize these tiers based on their locally available models.

### OpenAI-Compatible API

Ollama exposes an OpenAI-compatible `/v1` endpoint. The plugin leverages this by configuring `AiOperations` with `providerType: 'ollama'`, which tells LangChain to use the OpenAI-compatible client pointed at the Ollama base URL. This means the plugin benefits from the same request/response handling as the OpenAI plugin without needing a dedicated Ollama SDK.

### Default API Key

The API key defaults to `'ollama'` in both the settings schema and the `AiOperations` initialization. This is a placeholder value since standard Ollama installations do not require authentication. Users only need to change this if they have placed their Ollama server behind an authentication proxy.

### Embedding Support

Unlike Anthropic, the Ollama plugin fully supports embeddings. The `createEmbedding` method delegates directly to `AiOperations.createEmbedding`. Users must ensure an embedding-capable model (such as `nomic-embed-text`) is available on their Ollama server and configured as the model for embedding requests.

### Health Check

The `healthCheck` method always returns `{ status: 'healthy' }` as a simple readiness indicator. Actual server connectivity is verified through `isAvailable`, which calls `AiOperations.testConnection` and returns `false` on any failure.

## Usage Examples

```typescript
// Non-streaming chat completion with Ollama
const response = await ollamaPlugin.createChatCompletion({
	messages: [
		{ role: 'system', content: 'You are a directory content writer.' },
		{ role: 'user', content: 'Write a description for Acme Corp.' }
	],
	settings: {
		baseUrl: 'http://localhost:11434/v1',
		defaultModel: 'llama3.1:8b'
	}
});

// Streaming chat completion
for await (const chunk of ollamaPlugin.createStreamingChatCompletion({
	messages: [{ role: 'user', content: 'Summarize this company...' }],
	settings: { baseUrl: 'http://localhost:11434/v1' }
})) {
	process.stdout.write(chunk.content || '');
}

// Generate embeddings
const embedding = await ollamaPlugin.createEmbedding({
	input: 'AI-powered directory builder',
	settings: {
		baseUrl: 'http://localhost:11434/v1',
		defaultModel: 'nomic-embed-text'
	}
});

// List available models
const models = await ollamaPlugin.listModels({
	baseUrl: 'http://localhost:11434/v1'
});

// Check server availability
const available = await ollamaPlugin.isAvailable({
	baseUrl: 'http://localhost:11434/v1'
});
```

## Rate Limiting & Quotas

- **No API rate limits**: Ollama runs locally, so there are no external rate limits or per-request costs.
- **Hardware-bound**: Throughput is limited by the server's hardware (CPU, GPU, memory). Running multiple concurrent requests on resource-constrained hardware may cause queuing or out-of-memory errors.
- **Max tokens**: Defaults to 4,096 per response, configurable via the `maxTokens` setting.
- **Context window**: Reported as 128,000 tokens via `getCapabilities()`. Actual context length depends on the specific model.
- The plugin does not implement internal rate-limit or queue management.

## Error Handling

- **Plugin not loaded**: All methods throw `Error('Ollama plugin not loaded')` if called before `onLoad`. The `isAvailable` method returns `false` instead of throwing.
- **Connection failures**: `isAvailable` calls `testConnection` and returns `false` if the Ollama server is unreachable, the URL is misconfigured, or the server returns an error.
- **Model not found**: If the requested model is not pulled on the Ollama server, the error from Ollama propagates through LangChain to the caller.
- **LangChain errors**: Errors from the underlying LangChain OpenAI-compatible SDK propagate directly. Common errors include connection refused (server not running) and model not available.

## Related Plugins

- [OpenAI Plugin Deep Dive](./openai-plugin-deep-dive) -- cloud-hosted AI provider with native embedding support.
- [Anthropic Plugin Deep Dive](./anthropic-plugin-deep-dive) -- cloud-hosted AI provider with large context windows.
- [Ollama Plugin](./ollama-plugin) -- overview documentation for the Ollama plugin.
