---
id: groq-plugin
title: 'Groq Plugin'
sidebar_label: 'Groq'
sidebar_position: 24
---

# Groq AI Provider Plugin

The Groq plugin provides ultra-fast AI inference through [Groq's](https://groq.com) custom LPU (Language Processing Unit) hardware. It extends `BaseAiProvider` and uses the shared `AiOperations` layer that wraps LangChain under the hood.

**Source:** `packages/plugins/groq/src/groq.plugin.ts`

## Overview

| Property           | Value           |
| ------------------ | --------------- |
| Plugin ID          | `groq`          |
| Category           | `ai-provider`   |
| Capabilities       | `ai-provider`   |
| Version            | `1.0.0`         |
| Configuration Mode | `user-required` |
| Provider Type      | `groq`          |
| Auto-enable        | No              |
| Built-in           | Yes             |
| Visibility         | `public`        |

Groq runs open-weight models such as OpenAI's `gpt-oss` family at significantly higher speeds than conventional cloud providers, making it well suited for works with many items where generation speed is a priority.

## Architecture

```mermaid
graph TD
    A[AiFacadeService] --> B[GroqPlugin]
    B --> C[BaseAiProvider]
    C --> D[AiOperations]
    D --> E[LangChain OpenAI-compatible Provider]
    E --> F[Groq REST API<br/>api.groq.com/openai/v1]
```

Groq exposes an OpenAI-compatible API endpoint, so the plugin uses the same `AiOperations` abstraction as other providers. The `providerType: 'groq'` flag ensures LangChain selects the correct configuration.

## Configuration

### Settings Schema

| Setting        | Type     | Default                          | Scope    | Description                                                 |
| -------------- | -------- | -------------------------------- | -------- | ----------------------------------------------------------- |
| `apiKey`       | `string` | (required)                       | `user`   | Groq API key (marked as secret)                             |
| `defaultModel` | `string` | `openai/gpt-oss-120b`            | `global` | Used for all AI tasks unless a tier-specific model is set   |
| `simpleModel`  | `string` | `openai/gpt-oss-20b`             | `global` | Handles tags, short descriptions, and quick classifications |
| `mediumModel`  | `string` | `openai/gpt-oss-120b`            | `global` | Handles listings, summaries, and content reformatting       |
| `complexModel` | `string` | `openai/gpt-oss-120b`            | `global` | Handles full page generation and multi-step analysis        |
| `baseUrl`      | `string` | `https://api.groq.com/openai/v1` | hidden   | Custom API endpoint for proxies or compatible services      |
| `temperature`  | `number` | `0.7`                            | hidden   | Controls output randomness (0--2)                           |
| `maxTokens`    | `number` | `4096`                           | hidden   | Maximum response length                                     |

Model defaults as of 2026-11-05 — source: [console.groq.com/docs/models](https://console.groq.com/docs/models) (retirements: [deprecations](https://console.groq.com/docs/deprecations)). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. Every tier used to default to `qwen/qwen3-32b`, which Groq retired on 2026-07-17, so this is a fix: unsaved configs move to `openai/gpt-oss-120b` (default, medium, complex, `onLoad` bootstrap and `getDefaultModelId()`) and `openai/gpt-oss-20b` (simple). A saved retired id is still sent to Groq unchanged, and Groq's error then asks you to pick another model.

### Required Fields

- `apiKey` -- users must provide their own Groq API key
- `defaultModel` -- at least one model must be selected

### Schema Extensions

The API key field uses `x-secret: true` to render a masked password input with a show/hide toggle in the dashboard:

```json
{
	"apiKey": {
		"type": "string",
		"title": "Groq API Key",
		"x-secret": true,
		"x-scope": "user"
	}
}
```

The `baseUrl` field uses `x-hidden: true` to keep it out of the standard settings UI. It is only needed when routing requests through a proxy.

## Model Capabilities

| Capability                    | Supported      |
| ----------------------------- | -------------- |
| Structured output (JSON mode) | Yes            |
| Streaming responses           | Yes            |
| Tool calling                  | Yes            |
| Vision (image input)          | Yes            |
| Embeddings                    | **No**         |
| Max context length            | 128,000 tokens |

### Embedding Limitation

Groq does not currently support embedding models. Calling `createEmbedding()` throws an error:

```typescript
async createEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResponse> {
    throw new Error('Embeddings not supported by Groq');
}
```

If your workflow requires embeddings (e.g., for semantic search within works), pair Groq with a second provider that supports embeddings, such as OpenAI or Ollama.

## Tiered Model Assignment

```mermaid
flowchart LR
    subgraph Tasks
        S[Simple: tags, labels]
        M[Medium: summaries, lists]
        C[Complex: full pages, analysis]
    end

    subgraph Models
        SM[simpleModel]
        MM[mediumModel]
        CM[complexModel]
    end

    S --> SM
    M --> MM
    C --> CM
```

Model defaults as of 2026-11-05 — source: [console.groq.com/docs/models](https://console.groq.com/docs/models). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

| Tier    | Use Cases                                 | Default model         |
| ------- | ----------------------------------------- | --------------------- |
| Simple  | Tags, short descriptions, classifications | `openai/gpt-oss-20b`  |
| Medium  | Listings, summaries, content reformatting | `openai/gpt-oss-120b` |
| Complex | Full page generation, multi-step analysis | `openai/gpt-oss-120b` |

Both are Groq production models: `openai/gpt-oss-120b` (featured; 131,072-token context, $0.15 / $0.60 per million input / output tokens on 2026-11-05) and the smaller `openai/gpt-oss-20b` ($0.075 / $0.30). `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` are enterprise-only since 2026-08-16, and `qwen/qwen3-32b` was retired on 2026-07-17.

If a tier-specific model is not set, the `defaultModel` is used for all tiers.

## Lifecycle

### Loading

```typescript
async onLoad(context: PluginContext): Promise<void> {
    await super.onLoad(context);
    this.aiOps = new AiOperations({
        apiKey: '',
        model: DEFAULT_MODEL, // 'openai/gpt-oss-120b', also returned by getDefaultModelId()
        baseURL: 'https://api.groq.com/openai/v1',
        temperature: 0.7,
        maxTokens: 4096,
        providerType: 'groq'
    });
}
```

The `apiKey` is intentionally empty at load time. It is merged from the user's saved settings via `resolveConfig()` before each request.

### Availability Check

`isAvailable()` calls `AiOperations.testConnection()` with the resolved configuration. It returns `false` if no API key is configured or the connection fails.

## API Methods

| Method                                   | Description                                 |
| ---------------------------------------- | ------------------------------------------- |
| `createChatCompletion(options)`          | Single chat completion request              |
| `createStreamingChatCompletion(options)` | Streaming chat completion (async generator) |
| `createEmbedding(options)`               | **Throws error** -- not supported           |
| `listModels(settings)`                   | List available models from Groq             |
| `isAvailable(settings)`                  | Test API key and connection                 |
| `getCapabilities()`                      | Return supported capabilities               |
| `healthCheck()`                          | Return plugin health status                 |

## Comparison: Groq vs Ollama

| Aspect             | Groq                            | Ollama                      |
| ------------------ | ------------------------------- | --------------------------- |
| Hosting            | Cloud (Groq servers)            | Self-hosted                 |
| API key required   | Yes                             | Usually not                 |
| Speed              | Very fast (custom LPU hardware) | Depends on local hardware   |
| Cost               | Free tier + paid plans          | Free (your own hardware)    |
| Embeddings         | Not supported                   | Supported                   |
| Data privacy       | Data sent to Groq servers       | Data stays local            |
| Model availability | Curated set of models           | Any Ollama-compatible model |

## Getting Started

1. Obtain a free API key from [console.groq.com/keys](https://console.groq.com/keys).
2. Enable the Groq plugin in the Ever Works dashboard under **Settings > Plugins**.
3. Enter your API key in the settings.
4. Select your preferred models for each task complexity tier.
5. Groq will be used for content generation during work builds and AI conversations.

## Troubleshooting

| Issue                   | Cause                            | Solution                                                         |
| ----------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Authentication error    | Invalid or missing API key       | Verify your key at [console.groq.com](https://console.groq.com)  |
| Rate limit exceeded     | Too many requests                | Wait and retry, or upgrade your Groq plan                        |
| Embedding request fails | Groq does not support embeddings | Use a different provider for embeddings                          |
| Model not available     | Model removed from Groq          | Check Groq docs for current model list and update your selection |
| Slow responses          | Network latency to Groq servers  | Check your connection; Groq inference itself is fast             |
