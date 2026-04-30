---
id: mistral-plugin-deep-dive
title: Mistral Plugin Deep Dive
sidebar_label: Mistral
sidebar_position: 67
---

# Mistral Plugin Deep Dive

## Overview

The Mistral plugin (`@ever-works/plugins/mistral`) is an AI provider plugin that integrates Mistral AI's models with Ever Works. Mistral offers a range of models from lightweight to powerful, with strong multilingual capabilities and a focus on efficiency. The plugin also supports embeddings.

Notably, Mistral's API is also used by the PDF Extractor plugin for OCR capabilities, but this plugin focuses specifically on the generative AI provider role.

- **Plugin ID**: `mistral`
- **Category**: `ai-provider`
- **Capabilities**: `ai-provider`
- **Configuration Mode**: `user-required`
- **Source**: `packages/plugins/mistral/src/`

## Architecture

### Inheritance Chain

```
BaseAiProvider (from @ever-works/plugin/abstract)
  └── MistralPlugin
```

### Provider Configuration

| Property            | Value                       |
| ------------------- | --------------------------- |
| Base URL            | `https://api.mistral.ai/v1` |
| Default Model       | `mistral-small-latest`      |
| Simple Tier         | _(uses default)_            |
| Medium Tier         | `mistral-medium-latest`     |
| Complex Tier        | `mistral-large-latest`      |
| Max Context Tokens  | `128000`                    |
| Supports Embeddings | `true`                      |
| Supports Vision     | `true` (inherited default)  |

### Model Tiers

| Tier               | Model                   | Use Case                         |
| ------------------ | ----------------------- | -------------------------------- |
| **Simple/Default** | `mistral-small-latest`  | Fast, efficient tasks            |
| **Medium**         | `mistral-medium-latest` | Balanced capability              |
| **Complex**        | `mistral-large-latest`  | Complex reasoning and generation |

## Configuration

### Settings Schema

| Field              | Type     | Required | Description                                                                       |
| ------------------ | -------- | -------- | --------------------------------------------------------------------------------- |
| `apiKey`           | `string` | Yes      | Mistral API key (`x-secret`, `x-envVar: PLUGIN_MISTRAL_API_KEY`, `x-scope: user`) |
| `model`            | `string` | No       | Override default model (`default: mistral-small-latest`)                          |
| `simpleModel`      | `string` | No       | Model for simple tasks                                                            |
| `mediumModel`      | `string` | No       | Model for medium tasks (`default: mistral-medium-latest`)                         |
| `complexModel`     | `string` | No       | Model for complex tasks (`default: mistral-large-latest`)                         |
| `maxContextTokens` | `number` | No       | Override max context window (`default: 128000`)                                   |

### Environment Variables

| Variable                 | Maps To  |
| ------------------------ | -------- |
| `PLUGIN_MISTRAL_API_KEY` | `apiKey` |

## Capabilities

### AI Provider Interface

Through `BaseAiProvider` and `AiOperations`:

- **Chat Completions** - Text generation with Mistral models
- **Structured Output** - JSON generation with zod schema validation
- **Embeddings** - Text embedding generation (supported)
- **Model Routing** - Three-tier model selection
- **Vision** - Image understanding (inherited default)

### Key Advantages

- **Three Distinct Tiers** - Clear separation between small, medium, and large models for cost optimization
- **Embedding Support** - Native embedding generation
- **Multilingual Strength** - Mistral models have strong multilingual capabilities
- **Competitive Pricing** - Generally more affordable than comparable models from larger providers

## API Reference

### Plugin Class

```typescript
class MistralPlugin extends BaseAiProvider {
	readonly id = 'mistral';
	readonly name = 'Mistral';
	readonly version = '1.0.0';
	readonly providerName = 'Mistral';

	// Inherited from BaseAiProvider:
	async askText(prompt: string, options?: AiRequestOptions): Promise<AiTextResult>;
	async askJson<T>(prompt: string, schema: ZodSchema<T>, options?: AiRequestOptions): Promise<AiJsonResult<T>>;
	async getEmbeddings(text: string): Promise<number[]>;
	resolveConfig(settings: PluginSettings): ProviderConfig;
}
```

### Provider Config Resolution

The Mistral plugin overrides `resolveConfig` with stricter type checks compared to the base class:

```typescript
resolveConfig(settings: PluginSettings): ProviderConfig {
    return {
        apiKey: settings.apiKey as string,
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: (settings.model as string) || 'mistral-small-latest',
        mediumModel: (settings.mediumModel as string) || 'mistral-medium-latest',
        complexModel: (settings.complexModel as string) || 'mistral-large-latest',
        maxContextTokens: (settings.maxContextTokens as number) || 128000,
        supportsEmbeddings: true
    };
}
```

Note the explicit `as string` and `as number` casts -- the Mistral plugin applies stricter type assertions than other providers to ensure correct type resolution from the generic `PluginSettings` record.

## Implementation Details

### OpenAI Compatibility

Mistral's API at `https://api.mistral.ai/v1` is OpenAI-compatible, supporting:

- Chat completions (`/chat/completions`)
- Embeddings (`/embeddings`)
- Function/tool calling for structured output

This compatibility means LangChain's `ChatOpenAI` class works seamlessly with a base URL change.

### Model Naming Convention

Mistral uses a `latest` suffix for their model aliases:

- `mistral-small-latest` - Points to the latest small model version
- `mistral-medium-latest` - Points to the latest medium model version
- `mistral-large-latest` - Points to the latest large model version

Users can also specify pinned versions (e.g., `mistral-large-2407`) for reproducibility.

### Stricter Type Resolution

Unlike other AI provider plugins that rely on the base class's generic type handling, the Mistral plugin explicitly casts each setting value:

```typescript
apiKey: settings.apiKey as string,
defaultModel: (settings.model as string) || 'mistral-small-latest',
```

This provides an extra layer of type safety when settings come from the generic `PluginSettings` (`Record<string, unknown>`) type.

## Usage Examples

### Configuration

```typescript
const settings = {
	apiKey: 'your-mistral-api-key'
	// Using defaults:
	// default/simple: mistral-small-latest
	// medium: mistral-medium-latest
	// complex: mistral-large-latest
};
```

### Using with Pipeline

```typescript
// Simple tasks use mistral-small-latest (fast, cheap)
await aiFacade.askJson(
	prompt,
	schema,
	{
		routing: { complexity: 'simple', taskId: 'domain-detection' }
	},
	facadeOptions
);

// Complex tasks use mistral-large-latest (most capable)
await aiFacade.askJson(
	prompt,
	schema,
	{
		routing: { complexity: 'complex', taskId: 'ai-item-generation' }
	},
	facadeOptions
);
```

## Error Handling

### Common Errors

| Error                     | Cause                           | Resolution                                                     |
| ------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `401 Unauthorized`        | Invalid API key                 | Verify key at [console.mistral.ai](https://console.mistral.ai) |
| `429 Rate Limited`        | Quota exceeded                  | Check rate limits, implement backoff                           |
| `400 Bad Request`         | Invalid model or parameters     | Verify model name                                              |
| `Context length exceeded` | Input too large for 128K window | Reduce input or use chunking                                   |

### Health Check

Inherited from `BaseAiProvider`. Verifies API key configuration and provider accessibility.

## Related Plugins

- **[OpenAI](./openai-plugin-deep-dive.md)** - OpenAI provider
- **[Anthropic](./anthropic-plugin-deep-dive.md)** - Anthropic provider
- **[Google](./google-plugin-deep-dive.md)** - Google provider
- **[Groq](./groq-plugin-deep-dive.md)** - Groq provider
- **[OpenRouter](./openrouter-plugin-deep-dive.md)** - Multi-provider router
- **[PDF Extractor](./pdf-extractor-deep-dive.md)** - Uses Mistral's OCR API (separate from this AI provider plugin)
