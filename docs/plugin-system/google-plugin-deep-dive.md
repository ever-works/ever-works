---
id: google-plugin-deep-dive
title: Google AI Plugin Deep Dive
sidebar_label: Google AI
sidebar_position: 66
---

# Google AI Plugin Deep Dive

## Overview

The Google AI plugin (`@ever-works/plugins/google`) is an AI provider plugin that integrates Google's Gemini models with Ever Works. It provides access to Google's generative AI capabilities including text generation, structured output, and embeddings through the Gemini API's OpenAI-compatible endpoint.

Google's Gemini models are notable for their extremely large context windows (up to 1M tokens) and multi-tier model lineup ranging from the fast, low-cost Gemini 3.5 Flash-Lite to the flagship Gemini 4 Argon.

- **Plugin ID**: `google`
- **Category**: `ai-provider`
- **Capabilities**: `ai-provider`
- **Configuration Mode**: `user-required`
- **Source**: `packages/plugins/google/src/`

## Architecture

### Inheritance Chain

```
BaseAiProvider (from @ever-works/plugin/abstract)
  └── GooglePlugin
```

### Provider Configuration

| Property            | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| Base URL            | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Default Model       | `models/gemini-3.8-flash`                                  |
| Simple Tier         | `models/gemini-3.5-flash-lite`                             |
| Medium Tier         | `models/gemini-3.8-flash` (same as the default)            |
| Complex Tier        | `models/gemini-4-argon`                                    |
| Max Context Tokens  | `1048576` (1,048,576 = 1M tokens)                          |
| Supports Embeddings | `true`                                                     |
| Supports Vision     | `true` (inherited default)                                 |

### Model Tiers

The plugin configures three distinct model tiers for task-based routing:

| Tier               | Model                          | Use Case                                                       |
| ------------------ | ------------------------------ | -------------------------------------------------------------- |
| **Simple**         | `models/gemini-3.5-flash-lite` | Fast, lightweight tasks (prompt processing, domain detection)  |
| **Medium/Default** | `models/gemini-3.8-flash`      | Balanced tasks (item extraction, search queries)               |
| **Complex**        | `models/gemini-4-argon`        | Complex reasoning tasks (data aggregation, AI item generation) |

Model defaults as of 2026-11-05 — source: [aistudio.google.com/docs/models](https://aistudio.google.com/docs/models) (the `ai.google.dev/gemini-api/docs` pages redirect there; shutdown dates: [deprecations](https://aistudio.google.com/docs/deprecations)). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. Simple moved from `models/gemini-2.0-flash` (shut down 2026-06-01) to `models/gemini-3.5-flash-lite`, default and medium from `models/gemini-2.5-flash` to `models/gemini-3.8-flash`, and complex from `models/gemini-2.5-pro` to `models/gemini-4-argon`; the `onLoad` bootstrap and `getDefaultModelId()` follow the default. The 2.5 models are deprecated since 2026-11-02 (existing users only, re-routed from 2026-12-01).

## Configuration

### Settings Schema

| Field              | Type     | Required | Description                                                                        |
| ------------------ | -------- | -------- | ---------------------------------------------------------------------------------- |
| `apiKey`           | `string` | Yes      | Google AI API key (`x-secret`, `x-envVar: PLUGIN_GOOGLE_API_KEY`, `x-scope: user`) |
| `defaultModel`     | `string` | Yes      | Default model (`default: models/gemini-3.8-flash`)                                 |
| `simpleModel`      | `string` | No       | Model for simple tasks (`default: models/gemini-3.5-flash-lite`)                   |
| `mediumModel`      | `string` | No       | Model for medium complexity tasks (`default: models/gemini-3.8-flash`)             |
| `complexModel`     | `string` | No       | Model for complex tasks (`default: models/gemini-4-argon`)                         |
| `maxContextTokens` | `number` | No       | Override max context window (`default: 1048576`)                                   |

### Environment Variables

| Variable                | Maps To  |
| ----------------------- | -------- |
| `PLUGIN_GOOGLE_API_KEY` | `apiKey` |

## Capabilities

### AI Provider Interface

Through `BaseAiProvider` and `AiOperations`:

- **Chat Completions** - Text generation with Gemini models
- **Structured Output** - JSON generation with zod schema validation
- **Embeddings** - Text embedding generation (supported by Google models)
- **Model Routing** - Three-tier model selection based on task complexity
- **Vision** - Image understanding capabilities (inherited)

### Key Advantages

- **1M Token Context** - The largest static context hint among the AI provider plugins (every current Gemini model takes 1,048,576 input tokens), enabling processing of very large documents and conversation histories
- **Embedding Support** - Native embedding generation, useful for semantic search and similarity operations
- **Three-Tier Models** - Clear differentiation between fast (3.5 Flash-Lite), balanced (3.8 Flash), and flagship (4 Argon) models

## API Reference

### Plugin Class

```typescript
class GooglePlugin extends BaseAiProvider {
	readonly id = 'google';
	readonly name = 'Google AI';
	readonly version = '1.0.0';
	readonly providerName = 'Google';

	// Inherited from BaseAiProvider:
	async askText(prompt: string, options?: AiRequestOptions): Promise<AiTextResult>;
	async askJson<T>(prompt: string, schema: ZodSchema<T>, options?: AiRequestOptions): Promise<AiJsonResult<T>>;
	async getEmbeddings(text: string): Promise<number[]>;
	resolveConfig(settings: PluginSettings): ProviderConfig;
}
```

### Provider Config Resolution

```typescript
resolveConfig(settings: PluginSettings): ProviderConfig {
    return {
        apiKey: settings.apiKey,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: settings.defaultModel || 'models/gemini-3.8-flash',
        simpleModel: settings.simpleModel || 'models/gemini-3.5-flash-lite',
        mediumModel: settings.mediumModel || 'models/gemini-3.8-flash',
        complexModel: settings.complexModel || 'models/gemini-4-argon',
        maxContextTokens: settings.maxContextTokens || 1048576,
        supportsEmbeddings: true
    };
}
```

## Implementation Details

### OpenAI-Compatible Endpoint

Google provides an OpenAI-compatible API endpoint at:

```
https://generativelanguage.googleapis.com/v1beta/openai/
```

This allows the plugin to use the same LangChain `ChatOpenAI` integration as other providers, simply by changing the base URL and API key. The Google API key is passed as the OpenAI API key parameter.

### Model Naming

Google models use a `models/` prefix in their identifiers:

- `models/gemini-3.8-flash`
- `models/gemini-3.5-flash-lite`
- `models/gemini-4-argon`

This prefix is included in the default model names and must be included when overriding models in settings.

### Context Window

At 1,048,576 tokens (1M), the Google plugin's static context hint is the largest of the AI provider plugins:

- OpenAI plugin: 128K tokens (fallback hint; the GPT-6 family's 1,050,000-token window comes from the live model list)
- Anthropic plugin: 200K tokens (hint; the Claude 5.5 models accept 1M)
- Groq plugin: 128K tokens
- **Google Gemini plugin: 1M tokens**

This large context window is particularly beneficial for:

- Processing very long web pages without chunking
- Maintaining longer conversation histories in the Agent Pipeline
- Reducing the need for context compaction

## Usage Examples

### Configuration

```typescript
// Plugin settings
const settings = {
	apiKey: 'AIza...' // Google AI API key
	// Model tiers (using defaults):
	// simple: models/gemini-3.5-flash-lite
	// default and medium: models/gemini-3.8-flash
	// complex: models/gemini-4-argon
};
```

### Using with Pipeline

```typescript
// AiFacade routes to Google if configured as the active provider
// Simple task - uses gemini-3.5-flash-lite
await aiFacade.askJson(
	prompt,
	schema,
	{
		routing: { complexity: 'simple', taskId: 'prompt-processing' }
	},
	facadeOptions
);

// Complex task - uses gemini-4-argon
await aiFacade.askJson(
	prompt,
	schema,
	{
		routing: { complexity: 'complex', taskId: 'data-aggregation' }
	},
	facadeOptions
);
```

## Error Handling

### Common Errors

| Error                       | Cause                            | Resolution                                                       |
| --------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `401 Unauthorized`          | Invalid API key                  | Verify key at [aistudio.google.com](https://aistudio.google.com) |
| `429 Rate Limited`          | Quota exceeded                   | Check usage quotas, wait and retry                               |
| `400 Bad Request`           | Invalid model name or parameters | Verify model name includes `models/` prefix                      |
| `Context length exceeded`   | Input too large (unlikely at 1M) | Reduce input size                                                |
| `Embedding model not found` | Wrong model for embeddings       | Ensure embedding-capable model is used                           |

### Health Check

Inherited from `BaseAiProvider`. Verifies API key is configured and resolves provider config.

## Related Plugins

- **[OpenAI](./openai-plugin-deep-dive.md)** - OpenAI provider (GPT models)
- **[Anthropic](./anthropic-plugin-deep-dive.md)** - Anthropic provider (Claude models)
- **[Groq](./groq-plugin-deep-dive.md)** - Groq provider (fast inference)
- **[Mistral](./mistral-plugin-deep-dive.md)** - Mistral provider
- **[OpenRouter](./openrouter-plugin-deep-dive.md)** - Multi-provider router
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses AI providers via AiFacade
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses AI providers for parent and worker models
