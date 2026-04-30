---
id: ai-provider-plugins
title: AI Provider Plugins
sidebar_label: AI Providers
sidebar_position: 8
---

# AI Provider Plugins

AI provider plugins connect the Ever Works platform to large language model APIs for content generation, structured output, embeddings, and conversational AI. All AI providers implement the `IAiProviderPlugin` interface and extend the `BaseAiProvider` abstract class.

## Architecture

Every AI provider plugin follows the same pattern:

1. Extends `BaseAiProvider` from `@ever-works/plugin/abstract`
2. Uses `AiOperations` from `@ever-works/plugin/ai` (wraps LangChain for all providers)
3. Declares the `ai-provider` capability
4. Defines settings via JSON Schema with `x-secret`, `x-widget`, and `x-scope` extensions

```typescript
import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';

export class MyProviderPlugin extends BaseAiProvider {
  readonly id = 'my-provider';
  readonly name = 'My Provider';
  readonly version = '1.0.0';
  readonly providerType = 'my-provider';
  readonly providerName = 'My Provider';

  async onLoad(context: PluginContext): Promise<void> {
    await super.onLoad(context);
    this.aiOps = new AiOperations({
      apiKey: '',
      model: 'default-model',
      temperature: 0.7,
      providerType: 'my-provider'
    });
  }

  async createChatCompletion(options: ChatCompletionOptions) {
    return this.aiOps!.createChatCompletion(options, this.resolveConfig(options.settings));
  }

  async listModels(settings?: PluginSettings) {
    return this.aiOps!.listModels(this.resolveConfig(settings));
  }

  protected getDefaultModelId(): string {
    return 'default-model';
  }
}
```

### The `AiOperations` Wrapper

`AiOperations` is the shared AI abstraction layer that wraps LangChain. Every provider creates an instance during `onLoad()` and delegates calls to it. This means providers do not interact with LangChain directly -- they configure `AiOperations` with their provider type, API key, and base URL, and it handles the rest.

Key operations provided by `AiOperations`:

- `createChatCompletion()` -- standard chat completion
- `askJson()` -- structured JSON output using a Zod schema
- `createStreamingChatCompletion()` -- streaming responses
- `createEmbedding()` -- text embeddings
- `listModels()` -- list available models
- `testConnection()` -- verify API key and connectivity

### Settings Resolution

The `resolveConfig()` method on `BaseAiProvider` converts plugin settings into `AiOperationsConfig` overrides:

```typescript
protected resolveConfig(settings?: PluginSettings): Partial<AiOperationsConfig> {
  const config: Partial<AiOperationsConfig> = {};
  if (settings?.apiKey) config.apiKey = settings.apiKey as string;
  if (settings?.defaultModel) config.model = settings.defaultModel as string;
  if (settings?.baseUrl) config.baseURL = settings.baseUrl as string;
  if (settings?.temperature !== undefined) config.temperature = settings.temperature as number;
  if (settings?.maxTokens !== undefined) config.maxTokens = settings.maxTokens as number;
  return config;
}
```

## Available Providers

### OpenAI

| Property | Value |
|---|---|
| Package | `@ever-works/openai-plugin` |
| Provider Type | `openai` |
| Configuration Mode | `user-required` |
| Default Model | `gpt-5.1` |
| Structured Output | Yes |
| Streaming | Yes |
| Tool Calling | Yes |
| Vision | Yes |
| Embeddings | Yes |
| Max Context | 128,000 tokens |

Supports tiered model selection: `simpleModel` (gpt-5-nano), `mediumModel` (gpt-4o-mini), `complexModel` (gpt-5.1). Each tier is used for different task complexity levels during generation.

### Anthropic

| Property | Value |
|---|---|
| Package | `@ever-works/anthropic-plugin` |
| Provider Type | `anthropic` |
| Configuration Mode | `user-required` |
| Default Model | Claude series |
| Structured Output | Yes |
| Streaming | Yes |
| Tool Calling | Yes |
| Vision | Yes |
| Embeddings | No |

### Google (Gemini)

| Property | Value |
|---|---|
| Package | `@ever-works/google-plugin` |
| Provider Type | `google` |
| Configuration Mode | `user-required` |
| Default Model | Gemini series |
| Structured Output | Yes |
| Streaming | Yes |
| Tool Calling | Yes |
| Vision | Yes |
| Embeddings | Yes |

### Groq

| Property | Value |
|---|---|
| Package | `@ever-works/groq-plugin` |
| Provider Type | `groq` |
| Configuration Mode | `user-required` |
| Default Model | Groq-hosted models |
| Structured Output | Yes |
| Streaming | Yes |
| Tool Calling | Yes |
| Vision | Depends on model |
| Embeddings | No |

Groq provides extremely fast inference through custom LPU hardware. Ideal for latency-sensitive tasks.

### Ollama

| Property | Value |
|---|---|
| Package | `@ever-works/ollama-plugin` |
| Provider Type | `ollama` |
| Configuration Mode | `user-required` |
| Default Model | User's local models |
| Structured Output | Model dependent |
| Streaming | Yes |
| Tool Calling | Model dependent |
| Vision | Model dependent |
| Embeddings | Model dependent |

Ollama runs models locally. Users must have Ollama installed and running. The `baseUrl` setting (default: `http://localhost:11434`) points to the local Ollama instance.

### Mistral

| Property | Value |
|---|---|
| Package | `@ever-works/mistral-plugin` |
| Provider Type | `mistral` |
| Configuration Mode | `user-required` |
| Default Model | Mistral series |
| Structured Output | Yes |
| Streaming | Yes |
| Tool Calling | Yes |
| Vision | Model dependent |
| Embeddings | Yes |

### Perplexity

| Property | Value |
|---|---|
| Package | `@ever-works/perplexity-plugin` |
| Provider Type | `perplexity` |
| Configuration Mode | `hybrid` |
| Default Model | Perplexity online models |
| Structured Output | Limited |
| Streaming | Yes |
| Tool Calling | No |
| Vision | No |
| Embeddings | No |

Perplexity specializes in search-augmented AI responses with built-in web citations.

### OpenRouter

| Property | Value |
|---|---|
| Package | `@ever-works/openrouter-plugin` |
| Provider Type | `openrouter` |
| Configuration Mode | `user-required` |
| Default Model | Varies (multi-provider access) |
| Structured Output | Model dependent |
| Streaming | Yes |
| Tool Calling | Model dependent |
| Vision | Model dependent |
| Embeddings | No |

OpenRouter aggregates multiple AI providers behind a single API. It overrides `resolveConfig()` to handle provider-specific model mapping.

### Vercel AI Gateway

| Property | Value |
|---|---|
| Package | `@ever-works/vercel-ai-gateway-plugin` |
| Provider Type | `vercel-ai-gateway` |
| Configuration Mode | `user-required` |
| Default Model | Routed through Vercel |
| Structured Output | Model dependent |
| Streaming | Yes |
| Tool Calling | Model dependent |
| Vision | Model dependent |
| Embeddings | No |

Routes requests through the Vercel AI Gateway for caching, rate limiting, and observability.

## Common Settings Schema

All AI provider plugins share a common settings pattern:

```json
{
  "apiKey":       { "type": "string", "x-secret": true, "x-scope": "user" },
  "defaultModel": { "type": "string", "x-widget": "model-select", "x-scope": "global" },
  "simpleModel":  { "type": "string", "x-widget": "model-select", "x-scope": "global" },
  "mediumModel":  { "type": "string", "x-widget": "model-select", "x-scope": "global" },
  "complexModel": { "type": "string", "x-widget": "model-select", "x-scope": "global" },
  "temperature":  { "type": "number", "default": 0.7, "minimum": 0, "maximum": 2 },
  "maxTokens":    { "type": "number", "default": 4096 },
  "baseUrl":      { "type": "string", "x-hidden": true }
}
```

The `x-widget: 'model-select'` annotation tells the UI to render a model picker that queries `listModels()`.

## Model Capabilities

Each model reports its capabilities through the `AiModelCapabilities` interface:

```typescript
interface AiModelCapabilities {
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  maxContextLength: number;
  maxOutputTokens?: number;
}
```

The platform uses these capabilities to decide which models are suitable for specific generation tasks. For example, structured output is required for the item extraction step, and vision is used for analyzing screenshots.

## Provider Selection and Fallback

The `AiFacadeService` in the agent package consumes AI provider plugins. When a generation request specifies an AI provider, the facade:

1. Resolves user/directory-scoped settings for the selected provider
2. Passes `settings` in every operation call (e.g., `ChatCompletionOptions.settings`)
3. The plugin uses `resolveConfig(settings)` to build the final `AiOperationsConfig`

If the selected provider is unavailable, the platform can fall back to another configured provider based on the `isAvailable()` check.

## Creating a Custom AI Provider

To add a new AI provider:

1. Create a new package in `packages/plugins/your-provider/`
2. Add `@ever-works/plugin` as a peer dependency
3. Extend `BaseAiProvider` and implement the required abstract methods
4. Configure `AiOperations` with your provider's type and base URL
5. Define the settings schema with API key and model configuration
6. Export the plugin class as the default export

See the [Creating a Plugin](./creating-a-plugin.md) guide for the full scaffolding process.
