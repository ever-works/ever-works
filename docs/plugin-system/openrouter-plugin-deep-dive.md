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

| Property             | Value                          |
| -------------------- | ------------------------------ |
| Base URL             | `https://openrouter.ai/api/v1` |
| Default Model        | `openai/gpt-6.1-sol`           |
| Simple Tier          | `openai/gpt-6-luna`            |
| Medium Tier          | `openai/gpt-6.1-sol`           |
| Complex Tier         | `openai/gpt-6-astra`           |
| Bootstrap / fallback | `openai/gpt-6-luna`            |
| Max Context Tokens   | `128000`                       |
| Supports Embeddings  | `true` (inherited default)     |
| Supports Vision      | `false`                        |

Model defaults as of 2026-11-05 — source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models) (each id was listed that day) and OpenAI's [model guide](https://developers.openai.com/api/docs/models). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. Before the refresh every tier except complex defaulted to `openai/gpt-5-mini` and the complex tier to `openai/gpt-5`; OpenAI shuts both down on 2026-12-11.

### Model Tiers

| Tier               | Model                | Use Case                                                |
| ------------------ | -------------------- | ------------------------------------------------------- |
| **Simple**         | `openai/gpt-6-luna`  | Lightweight tasks (prompt processing, domain detection) |
| **Medium/Default** | `openai/gpt-6.1-sol` | Balanced tasks (content extraction, search queries)     |
| **Complex**        | `openai/gpt-6-astra` | Complex reasoning (AI generation, data aggregation)     |

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
| `defaultModel`     | `string` | Yes      | Default model (`default: openai/gpt-6.1-sol`)                                           |
| `simpleModel`      | `string` | No       | Model for simple tasks (`default: openai/gpt-6-luna`)                                   |
| `mediumModel`      | `string` | No       | Model for medium tasks (`default: openai/gpt-6.1-sol`)                                  |
| `complexModel`     | `string` | No       | Model for complex tasks (`default: openai/gpt-6-astra`)                                 |
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
        defaultModel: settings.defaultModel || 'openai/gpt-6.1-sol',
        simpleModel: settings.simpleModel || 'openai/gpt-6-luna',
        mediumModel: settings.mediumModel || 'openai/gpt-6.1-sol',
        complexModel: settings.complexModel || 'openai/gpt-6-astra',
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

- `openai/gpt-6-astra` - OpenAI's GPT-6 Astra via OpenRouter
- `openai/gpt-6.1-sol` - OpenAI's GPT-6.1 Sol via OpenRouter
- `openai/gpt-6-luna` - OpenAI's GPT-6 Luna via OpenRouter
- `anthropic/claude-sonnet-5.5` - Anthropic's Claude Sonnet 5.5 via OpenRouter
- `google/gemini-4-argon` - Google's Gemini 4 Argon via OpenRouter

Example ids as of 2026-11-05 — source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

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
	// Default tiers apply (as of 2026-11-05):
	// simple: openai/gpt-6-luna
	// medium: openai/gpt-6.1-sol
	// complex: openai/gpt-6-astra
};
```

### User Override

```typescript
// User overrides with their own key and preferred models
const userSettings = {
	apiKey: 'sk-or-v1-user-key',
	defaultModel: 'anthropic/claude-sonnet-5.5',
	simpleModel: 'google/gemini-3.5-flash-lite',
	complexModel: 'anthropic/claude-opus-5.5'
};
```

### Using Any Model

```typescript
// Users can specify any model available on OpenRouter
const settings = {
	apiKey: 'sk-or-v1-...',
	defaultModel: 'meta-llama/llama-4-maverick',
	simpleModel: 'meta-llama/llama-4-scout',
	complexModel: 'deepseek/deepseek-v4-pro'
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
