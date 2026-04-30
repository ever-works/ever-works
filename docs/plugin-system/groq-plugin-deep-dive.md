---
id: groq-plugin-deep-dive
title: Groq Plugin Deep Dive
sidebar_label: Groq
sidebar_position: 65
---

# Groq Plugin Deep Dive

## Overview

The Groq plugin (`@ever-works/plugins/groq`) is an AI provider plugin that integrates Groq's ultra-fast inference platform with Ever Works. Groq specializes in high-speed inference using their custom Language Processing Unit (LPU) hardware, making it one of the fastest AI providers available.

The plugin extends `BaseAiProvider` from the plugin system, which provides standardized AI operations through the `AiOperations` wrapper (built on LangChain). This means all AI provider plugins share the same interface for chat completions, structured output, and embeddings.

- **Plugin ID**: `groq`
- **Category**: `ai-provider`
- **Capabilities**: `ai-provider`
- **Configuration Mode**: `user-required`
- **Source**: `packages/plugins/groq/src/`

## Architecture

### Inheritance Chain

```
BaseAiProvider (from @ever-works/plugin/abstract)
  └── GroqPlugin
```

`BaseAiProvider` provides:
- Settings schema management with API key, model selection, and custom configuration
- `AiOperations` instantiation for standardized AI calls
- Model tier routing (simple/medium/complex)
- Health check and manifest generation
- Plugin lifecycle management

### Provider Configuration

| Property | Value |
|----------|-------|
| Base URL | `https://api.groq.com/openai/v1` |
| Default Model | `qwen/qwen3-32b` |
| Simple Tier | *(not explicitly overridden, uses default)* |
| Medium Tier | *(not explicitly overridden, uses default)* |
| Complex Tier | *(not explicitly overridden, uses default)* |
| Max Context Tokens | `128000` |
| Supports Embeddings | `false` |
| Supports Vision | `true` (inherited default) |

## Configuration

### Settings Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | `string` | Yes | Groq API key (`x-secret`, `x-envVar: PLUGIN_GROQ_API_KEY`, `x-scope: user`) |
| `model` | `string` | No | Override default model (`default: qwen/qwen3-32b`) |
| `simpleModel` | `string` | No | Model for simple tasks |
| `mediumModel` | `string` | No | Model for medium complexity tasks |
| `complexModel` | `string` | No | Model for complex tasks |
| `maxContextTokens` | `number` | No | Override max context window |

### Environment Variables

| Variable | Maps To |
|----------|---------|
| `PLUGIN_GROQ_API_KEY` | `apiKey` |

### Configuration Mode: `user-required`

Unlike some providers that can work with admin-level configuration only, Groq requires each user to provide their own API key. The `x-scope: user` annotation ensures the API key is stored per-user, not globally.

## Capabilities

### AI Provider Interface

Through `BaseAiProvider` and `AiOperations`, the plugin provides:

- **Chat Completions** - Standard text generation with system/user messages
- **Structured Output** - JSON generation with zod schema validation (`askJson`)
- **Model Routing** - Automatic model selection based on task complexity
- **Token Counting** - Approximate token counting for context management
- **Streaming** - Streaming response support (if supported by model)

### Limitations

- **No Embeddings** - Groq does not support embedding generation. The plugin explicitly sets `supportsEmbeddings: false`.
- **Model Availability** - Available models depend on Groq's current offerings. The default `qwen/qwen3-32b` is a community model hosted on Groq.

## API Reference

### Plugin Class

```typescript
class GroqPlugin extends BaseAiProvider {
    readonly id = 'groq';
    readonly name = 'Groq';
    readonly version = '1.0.0';
    readonly providerName = 'Groq';

    // Inherited from BaseAiProvider:
    async askText(prompt: string, options?: AiRequestOptions): Promise<AiTextResult>;
    async askJson<T>(prompt: string, schema: ZodSchema<T>, options?: AiRequestOptions): Promise<AiJsonResult<T>>;
    async getEmbeddings(text: string): Promise<number[]>; // Throws - not supported
    resolveConfig(settings: PluginSettings): ProviderConfig;
}
```

### Provider Config Resolution

```typescript
resolveConfig(settings: PluginSettings): ProviderConfig {
    return {
        apiKey: settings.apiKey,
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: settings.model || 'qwen/qwen3-32b',
        maxContextTokens: settings.maxContextTokens || 128000,
        supportsEmbeddings: false
    };
}
```

## Implementation Details

### How BaseAiProvider Works

All AI provider plugins share the same execution flow through `BaseAiProvider`:

1. **Settings Resolution** - `resolveConfig()` maps plugin settings to a `ProviderConfig`
2. **AiOperations Creation** - `BaseAiProvider` creates an `AiOperations` instance with the config
3. **LangChain Integration** - `AiOperations` uses LangChain's `ChatOpenAI` class with the provider's base URL
4. **Request Routing** - Task complexity (`simple`/`medium`/`complex`) selects the appropriate model tier
5. **Response Handling** - Results include the response, token usage, and cost information

### Model Tier Routing

When the pipeline or facade requests an AI operation with a routing hint:

```typescript
// Example: prompt-processing uses 'simple' complexity
aiFacade.askJson(prompt, schema, {
    routing: { complexity: 'simple', taskId: 'prompt-processing' }
}, facadeOptions);
```

The `BaseAiProvider` resolves the model based on complexity:
- `simple` -> `simpleModel` or `defaultModel`
- `medium` -> `mediumModel` or `defaultModel`
- `complex` -> `complexModel` or `defaultModel`

For Groq, since no tier-specific models are configured by default, all tiers use `qwen/qwen3-32b` unless the user overrides them in settings.

### OpenAI Compatibility

Groq's API is OpenAI-compatible, which means:
- Uses the same request/response format as OpenAI
- Works with LangChain's `ChatOpenAI` class by setting the `baseUrl`
- Supports function/tool calling (used by structured output)
- Supports system messages and multi-turn conversations

## Usage Examples

### Configuration in UI

Users configure the Groq plugin in the Ever Works settings:

1. Navigate to Plugins > AI Providers > Groq
2. Enter your Groq API key (obtained from [console.groq.com](https://console.groq.com))
3. Optionally override the default model
4. Save settings

### Using with Pipeline

Once configured, Groq becomes available as an AI provider for any pipeline:

```typescript
// The AiFacade automatically routes to Groq if it's the active provider
const result = await aiFacade.askJson(
    systemPrompt,
    outputSchema,
    { temperature: 0, routing: { complexity: 'simple' } },
    { userId: user.id, directoryId: directory.id }
);
```

## Error Handling

### Common Errors

| Error | Cause | Resolution |
|-------|-------|------------|
| `401 Unauthorized` | Invalid or expired API key | Check API key in settings |
| `429 Rate Limited` | Too many requests | Reduce concurrency, wait and retry |
| `Model not found` | Invalid model name | Check Groq's available models |
| `Embeddings not supported` | Called `getEmbeddings()` | Use a different provider for embeddings |
| `Context length exceeded` | Input too large for 128K window | Reduce input size or use chunking |

### Health Check

The `healthCheck()` method (inherited from `BaseAiProvider`) verifies:
1. API key is configured
2. Provider config resolves successfully
3. Returns healthy/unhealthy status with descriptive message

### Credential Validation

The `validateCredentials()` method (inherited from `BaseAiProvider`) makes a minimal API call to verify the API key is valid and the provider is accessible.

## Related Plugins

- **[OpenAI](./openai-plugin-deep-dive.md)** - OpenAI provider (GPT models)
- **[Anthropic](./anthropic-plugin-deep-dive.md)** - Anthropic provider (Claude models)
- **[Google](./google-plugin-deep-dive.md)** - Google provider (Gemini models)
- **[Mistral](./mistral-plugin-deep-dive.md)** - Mistral provider
- **[OpenRouter](./openrouter-plugin-deep-dive.md)** - Multi-provider router
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses AI providers via AiFacade for all AI-powered steps
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses AI providers for parent and worker models
