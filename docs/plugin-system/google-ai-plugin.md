---
id: google-ai-plugin
title: 'Google AI (Gemini) Plugin'
sidebar_label: 'Google Gemini'
sidebar_position: 33
---

# Google Gemini AI Provider Plugin

The Google Gemini plugin connects Ever Works to Google's Gemini models, offering an exceptionally large context window (up to 1 million tokens), built-in embedding models, and vision capabilities. It extends `BaseAiProvider` and communicates with Google's API through an OpenAI-compatible endpoint.

**Source:** `packages/plugins/google/src/google.plugin.ts`

## Overview

| Property           | Value                       |
| ------------------ | --------------------------- |
| Plugin ID          | `google`                    |
| Package            | `@ever-works/google-plugin` |
| Category           | `ai-provider`               |
| Capabilities       | `ai-provider`               |
| Version            | `1.0.0`                     |
| Configuration Mode | `user-required`             |
| Provider Type      | `google`                    |
| Auto-enable        | No                          |
| Built-in           | Yes                         |
| Visibility         | `public`                    |

## Architecture

```mermaid
graph TD
    A[AiFacadeService] --> B[GooglePlugin]
    B --> C[BaseAiProvider]
    C --> D[AiOperations]
    D --> E["LangChain OpenAI-compatible Provider"]
    E --> F["Google AI API<br/>generativelanguage.googleapis.com/v1beta/openai/"]
    F --> G["Gemini 3.5 Flash-Lite"]
    F --> H["Gemini 3.8 Flash"]
    F --> I["Gemini 4 Argon"]
```

Google provides an OpenAI-compatible API endpoint at `https://generativelanguage.googleapis.com/v1beta/openai/`, which means the plugin reuses the same LangChain OpenAI provider with a custom `baseURL`.

## Configuration

### Settings Schema

| Setting        | Type     | Required | Default                                                    | Scope    | Widget         | Description                                          |
| -------------- | -------- | -------- | ---------------------------------------------------------- | -------- | -------------- | ---------------------------------------------------- |
| `apiKey`       | `string` | Yes      | --                                                         | `user`   | --             | Google AI API key. Secret.                           |
| `defaultModel` | `string` | Yes      | `models/gemini-3.8-flash`                                  | `global` | `model-select` | Default model for all AI tasks.                      |
| `simpleModel`  | `string` | No       | `models/gemini-3.5-flash-lite`                             | `global` | `model-select` | Model for tags, descriptions, classifications.       |
| `mediumModel`  | `string` | No       | `models/gemini-3.8-flash`                                  | `global` | `model-select` | Model for listings, summaries, reformatting.         |
| `complexModel` | `string` | No       | `models/gemini-4-argon`                                    | `global` | `model-select` | Model for full page generation, multi-step analysis. |
| `temperature`  | `number` | No       | `0.7`                                                      | --       | --             | Sampling temperature (0--2). Hidden.                 |
| `maxTokens`    | `number` | No       | `4096`                                                     | --       | --             | Max tokens per response. Hidden.                     |
| `baseUrl`      | `string` | No       | `https://generativelanguage.googleapis.com/v1beta/openai/` | --       | --             | API endpoint. Hidden.                                |

### Model Tiers

```mermaid
graph LR
    subgraph "Gemini Model Tiers"
        S["Simple Tasks<br/>Tags, classifications"] --> SM["gemini-3.5-flash-lite<br/>Fastest, lowest cost"]
        M["Standard Tasks<br/>Summaries, listings"] --> MM["gemini-3.8-flash<br/>Balanced speed + quality"]
        C["Complex Tasks<br/>Page generation"] --> CM["gemini-4-argon<br/>Flagship"]
    end
```

Model defaults as of 2026-11-05 — source: [aistudio.google.com/docs/models](https://aistudio.google.com/docs/models) (the `ai.google.dev/gemini-api/docs` pages redirect there; shutdown dates: [deprecations](https://aistudio.google.com/docs/deprecations)). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

| Tier     | Default Model                  | Strengths                                                             |
| -------- | ------------------------------ | --------------------------------------------------------------------- |
| Simple   | `models/gemini-3.5-flash-lite` | Google's fastest, most cost-effective model                           |
| Standard | `models/gemini-3.8-flash`      | Google's most intelligent Flash model, balanced performance           |
| Complex  | `models/gemini-4-argon`        | Google's flagship ($2 / $10 per MTok until 2026-11-30, then $4 / $20) |

The default model, the `onLoad` bootstrap and `getDefaultModelId()` equal the standard tier, `models/gemini-3.8-flash`.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. The defaults moved from `models/gemini-2.0-flash` (simple; shut down 2026-06-01, so this is a fix), `models/gemini-2.5-flash` (default and standard) and `models/gemini-2.5-pro` (complex) to the ids above. The 2.5 models are deprecated since 2026-11-02, serve existing users only and are re-routed from 2026-12-01, so a config that saved one should switch.

From Gemini 3.6 Flash on, Google ignores `temperature`, `top_p` and `top_k`, so the hidden `temperature` setting has no effect on Gemini 3.8 Flash (default and standard tiers) or Gemini 4 Argon (complex tier). Gemini 3.5 Flash-Lite (simple tier) predates that change.

### Model Naming Convention

Google Gemini models use a `models/` prefix:

```
models/gemini-3.5-flash-lite
models/gemini-3.8-flash
models/gemini-4-argon
```

## Capabilities

| Capability         | Supported            | Details                                      |
| ------------------ | -------------------- | -------------------------------------------- |
| Structured Output  | Yes                  | JSON mode and schema-constrained generation  |
| Streaming          | Yes                  | Server-sent events for incremental responses |
| Tool Calling       | Yes                  | Function calling for structured tasks        |
| Vision             | Yes                  | Image analysis and understanding             |
| Max Context Length | **1,048,576 tokens** | 1M token context window                      |

The 1,048,576-token hint is the largest static context hint among the AI provider plugins, and every current Gemini model takes 1,048,576 input tokens, making Gemini well suited to processing large volumes of source material during work generation.

### Context Window Comparison

| Provider                   | Max Context          |
| -------------------------- | -------------------- |
| **Google Gemini**          | **1,048,576 tokens** |
| Mistral                    | 128,000 tokens       |
| OpenAI (via OpenRouter)    | 128,000 tokens       |
| Anthropic (via OpenRouter) | 200,000 tokens       |

## Usage Examples

```typescript
// Chat completion
const response = await googlePlugin.createChatCompletion({
	messages: [{ role: 'user', content: 'Describe this business' }],
	settings: { apiKey: 'AIza...' }
});

// Streaming
for await (const chunk of googlePlugin.createStreamingChatCompletion({
	messages: [{ role: 'user', content: 'Write a detailed description' }],
	settings: { apiKey: 'AIza...' }
})) {
	process.stdout.write(chunk.content ?? '');
}

// Embeddings
const embedding = await googlePlugin.createEmbedding({
	input: 'text for semantic search'
});

// Structured JSON output
const result = await googlePlugin.askJson('Generate category taxonomy', {
	settings: { apiKey: 'AIza...' }
});

// List available models
const models = await googlePlugin.listModels({ apiKey: 'AIza...' });

// Test connectivity
const available = await googlePlugin.isAvailable({ apiKey: 'AIza...' });
```

## Configuration Mode

Google Gemini uses `user-required` configuration mode. Each user must provide their own Google AI API key -- there is no admin-level shared key option.

```mermaid
graph TD
    A["User obtains API key from<br/>Google AI Studio"] --> B[Enter key in plugin settings]
    B --> C[Key stored per-user]
    C --> D{API key present?}
    D -->|Yes| E[AI operations available]
    D -->|No| F[Error: key required]
```

## Why Use Gemini?

| Advantage         | Description                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Extended context  | Process up to 1M tokens -- ideal for large source documents                                                         |
| Embedding support | Built-in text-embedding models for semantic search                                                                  |
| Cost-efficient    | Gemini Flash models deliver strong results at low per-token cost                                                    |
| Vision            | Analyze images and screenshots during content generation                                                            |
| Thinking models   | Gemini 3.x and 4 models reason before answering; Ever Works requests the lowest reasoning effort each model accepts |

## Lifecycle

```mermaid
sequenceDiagram
    participant Engine
    participant Plugin as GooglePlugin
    participant AiOps as AiOperations

    Engine->>Plugin: onLoad(context)
    Plugin->>AiOps: new AiOperations({<br/>  providerType: 'google',<br/>  model: 'models/gemini-3.8-flash',<br/>  baseURL: '...googleapis.com/v1beta/openai/'<br/>})
    Plugin-->>Engine: loaded

    Engine->>Plugin: createChatCompletion(options)
    Plugin->>Plugin: resolveConfig(options.settings)
    Plugin->>AiOps: createChatCompletion(options, resolvedConfig)
    AiOps-->>Plugin: ChatCompletionResponse

    Engine->>Plugin: onUnload()
    Plugin->>Plugin: aiOps = null
```

## Health Check

```typescript
async healthCheck(): Promise<PluginHealthCheck> {
    return {
        status: 'healthy',
        message: 'Google Gemini plugin is ready',
        checkedAt: Date.now()
    };
}
```

To verify API connectivity, call `isAvailable()` with a valid API key. This invokes `testConnection()` against the Google API.

## Dependencies

| Package              | Version   | Purpose                              |
| -------------------- | --------- | ------------------------------------ |
| `@ever-works/plugin` | workspace | Plugin contracts and base classes    |
| `@langchain/openai`  | ^1.7.1    | LangChain OpenAI-compatible provider |
| `@langchain/core`    | ^1.3.0    | LangChain core abstractions          |

## Getting Started

1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Enable the Google Gemini plugin in Ever Works
3. Enter your API key in the settings
4. Select preferred Gemini models for each task complexity level
