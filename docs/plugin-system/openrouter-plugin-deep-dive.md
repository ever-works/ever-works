---
id: openrouter-plugin-deep-dive
title: OpenRouter Plugin Deep Dive
sidebar_label: OpenRouter
sidebar_position: 68
---

# OpenRouter Plugin Deep Dive

## Overview

The OpenRouter plugin (`@ever-works/plugins/openrouter`) is an AI provider plugin that integrates OpenRouter's multi-provider routing service with Ever Works. OpenRouter acts as a unified API gateway to hundreds of AI models from multiple providers (OpenAI, Anthropic, Google, Meta, Mistral, and many others), allowing users to access any model through a single API key and billing account.

This plugin has a special role in the platform: it is marked as a **system plugin** with **auto-enable** and **default-for-capabilities** flags, meaning it serves as the fallback AI provider when no other provider is configured.

- **Plugin ID**: `openrouter`
- **Category**: `ai-provider`
- **Capabilities**: `ai-provider`
- **Configuration Mode**: `hybrid`
- **System Plugin**: `true`
- **Auto-Enable**: `true`
- **Default for Capabilities**: `ai-provider`
- **Source**: `packages/plugins/openrouter/src/`

## Architecture

### Inheritance Chain

```
BaseAiProvider (from @ever-works/plugin/abstract)
  └── OpenRouterPlugin
```

### Provider Configuration

| Property            | Value                            |
| ------------------- | -------------------------------- |
| Base URL            | `https://openrouter.ai/api/v1`   |
| Default Model       | `openai/gpt-5.1`                 |
| Simple Tier         | `openai/gpt-5-nano`              |
| Medium Tier         | `openai/gpt-4o`                  |
| Complex Tier        | _(uses default: openai/gpt-5.1)_ |
| Max Context Tokens  | `128000`                         |
| Supports Embeddings | `true` (inherited default)       |
| Supports Vision     | `false`                          |

### Model Tiers

| Tier                | Model               | Use Case                                                |
| ------------------- | ------------------- | ------------------------------------------------------- |
| **Simple**          | `openai/gpt-5-nano` | Lightweight tasks (prompt processing, domain detection) |
| **Medium**          | `openai/gpt-4o`     | Balanced tasks (content extraction, search queries)     |
| **Complex/Default** | `openai/gpt-5.1`    | Complex reasoning (AI generation, data aggregation)     |

### System Plugin Role

The OpenRouter plugin is unique among AI providers due to three manifest flags:

```typescript
systemPlugin: true,      // Cannot be uninstalled by users
autoEnable: true,        // Automatically enabled on new installations
defaultForCapabilities: ['ai-provider']  // Used when no other AI provider is active
```

This ensures that the platform always has an AI provider available, even before users configure their own preferred provider.

## Configuration

### Settings Schema

| Field              | Type     | Required | Description                                                                             |
| ------------------ | -------- | -------- | --------------------------------------------------------------------------------------- |
| `apiKey`           | `string` | Yes      | OpenRouter API key (`x-secret`, `x-envVar: PLUGIN_OPENROUTER_API_KEY`, `x-scope: user`) |
| `model`            | `string` | No       | Override default model (`default: openai/gpt-5.1`)                                      |
| `simpleModel`      | `string` | No       | Model for simple tasks (`default: openai/gpt-5-nano`)                                   |
| `mediumModel`      | `string` | No       | Model for medium tasks (`default: openai/gpt-4o`)                                       |
| `complexModel`     | `string` | No       | Model for complex tasks                                                                 |
| `maxContextTokens` | `number` | No       | Override max context window (`default: 128000`)                                         |

### Environment Variables

| Variable                    | Maps To  |
| --------------------------- | -------- |
| `PLUGIN_OPENROUTER_API_KEY` | `apiKey` |

### Configuration Mode: `hybrid`

Unlike other AI providers that use `user-required`, OpenRouter uses `hybrid` mode. This means:

- Admin can set a global API key for all users (admin-level configuration)
- Individual users can override with their own API key (user-level configuration)
- This supports the platform's default provider role -- admin can configure one key for everyone

## Capabilities

### AI Provider Interface

Through `BaseAiProvider` and `AiOperations`:

- **Chat Completions** - Text generation via any OpenRouter-supported model
- **Structured Output** - JSON generation with zod schema validation
- **Model Routing** - Three-tier model selection based on task complexity
- **Embeddings** - Supported (inherited default)

### Limitations

- **No Vision** - The plugin explicitly sets `supportsVision: false`, even though many models accessible through OpenRouter support vision. This is a conservative default.

### Key Advantages

- **Multi-Provider Access** - Access OpenAI, Anthropic, Google, Meta, Mistral, and hundreds more through one API
- **Model Flexibility** - Users can specify any OpenRouter model ID in settings
- **Unified Billing** - Single billing account for all providers
- **Fallback Provider** - Always available as the platform's default AI provider
- **Model Discovery** - Access to new models as they become available on OpenRouter

## API Reference

### Plugin Class

```typescript
class OpenRouterPlugin extends BaseAiProvider {
	readonly id = 'openrouter';
	readonly name = 'OpenRouter';
	readonly version = '1.0.0';
	readonly providerName = 'OpenRouter';

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
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: settings.model || 'openai/gpt-5.1',
        simpleModel: settings.simpleModel || 'openai/gpt-5-nano',
        mediumModel: settings.mediumModel || 'openai/gpt-4o',
        maxContextTokens: settings.maxContextTokens || 128000,
        supportsVision: false
    };
}
```

### Manifest

```typescript
getManifest(): PluginManifest {
    return {
        id: 'openrouter',
        name: 'OpenRouter',
        // ...
        builtIn: false,
        systemPlugin: true,        // Cannot be uninstalled
        autoEnable: true,          // Enabled by default
        defaultForCapabilities: ['ai-provider']  // Default AI provider
    };
}
```

## Implementation Details

### OpenRouter Model IDs

OpenRouter uses a `provider/model` naming convention:

- `openai/gpt-5.1` - OpenAI's GPT-5.1 via OpenRouter
- `openai/gpt-5-nano` - OpenAI's GPT-5 Nano via OpenRouter
- `openai/gpt-4o` - OpenAI's GPT-4o via OpenRouter
- `anthropic/claude-sonnet-4-20250514` - Anthropic's Claude via OpenRouter
- `google/gemini-2.5-pro` - Google's Gemini via OpenRouter

Users can override the default models with any valid OpenRouter model ID.

### OpenAI Compatibility

OpenRouter's API at `https://openrouter.ai/api/v1` is fully OpenAI-compatible:

- Chat completions (`/chat/completions`)
- Embeddings (`/embeddings`)
- Function/tool calling
- Streaming responses

### Default Provider Behavior

When the platform needs an AI provider and no user-specific provider is configured:

1. The plugin system checks for active AI providers
2. If none found, `defaultForCapabilities: ['ai-provider']` makes OpenRouter the fallback
3. The admin-configured API key (hybrid mode) is used
4. Operations proceed with OpenRouter's default model tiers

This ensures the platform is functional out of the box with just an admin-level OpenRouter key.

## Usage Examples

### Admin Configuration (Global)

```typescript
// Admin sets a global API key for all users
const adminSettings = {
	apiKey: 'sk-or-v1-...' // OpenRouter API key
	// Default tiers apply:
	// simple: openai/gpt-5-nano
	// medium: openai/gpt-4o
	// complex: openai/gpt-5.1
};
```

### User Override

```typescript
// User overrides with their own key and preferred models
const userSettings = {
	apiKey: 'sk-or-v1-user-key',
	model: 'anthropic/claude-sonnet-4-20250514',
	simpleModel: 'google/gemini-2.0-flash',
	complexModel: 'anthropic/claude-opus-4-20250514'
};
```

### Using Any Model

```typescript
// Users can specify any model available on OpenRouter
const settings = {
	apiKey: 'sk-or-v1-...',
	model: 'meta-llama/llama-4-maverick',
	simpleModel: 'meta-llama/llama-4-scout',
	complexModel: 'deepseek/deepseek-r1'
};
```

## Error Handling

### Common Errors

| Error                     | Cause                | Resolution                                                     |
| ------------------------- | -------------------- | -------------------------------------------------------------- |
| `401 Unauthorized`        | Invalid API key      | Verify key at [openrouter.ai/keys](https://openrouter.ai/keys) |
| `402 Payment Required`    | Insufficient credits | Add credits to OpenRouter account                              |
| `429 Rate Limited`        | Too many requests    | Check rate limits, implement backoff                           |
| `Model not found`         | Invalid model ID     | Verify model exists on OpenRouter                              |
| `Upstream provider error` | Model provider issue | Try different model or wait                                    |

### Health Check

Inherited from `BaseAiProvider`. Since OpenRouter is a system plugin, health check failures are more critical -- they may indicate the platform has no AI provider available.

### Fallback Behavior

If the user's preferred AI provider fails, the platform may fall back to OpenRouter (if configured). This provides resilience against individual provider outages.

## Related Plugins

- **[OpenAI](./openai-plugin-deep-dive.md)** - Direct OpenAI access (alternative to OpenRouter routing)
- **[Anthropic](./anthropic-plugin-deep-dive.md)** - Direct Anthropic access
- **[Google](./google-plugin-deep-dive.md)** - Direct Google access
- **[Groq](./groq-plugin-deep-dive.md)** - Direct Groq access
- **[Mistral](./mistral-plugin-deep-dive.md)** - Direct Mistral access
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses AI providers via AiFacade
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses AI providers for parent and worker models
