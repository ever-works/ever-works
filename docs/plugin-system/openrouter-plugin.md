---
id: openrouter-plugin
title: 'OpenRouter Plugin'
sidebar_label: 'OpenRouter'
sidebar_position: 30
---

# OpenRouter AI Provider Plugin

The OpenRouter plugin is the **default AI provider** for Ever Works. It connects to the OpenRouter API, which aggregates hundreds of AI models from multiple providers (OpenAI, Anthropic, Google, Meta, and more) behind a single API endpoint. This gives users access to the broadest model selection through one API key.

**Source:** `packages/plugins/openrouter/src/openrouter.plugin.ts`

## Overview

| Property           | Value                           |
| ------------------ | ------------------------------- |
| Plugin ID          | `openrouter`                    |
| Package            | `@ever-works/openrouter-plugin` |
| Category           | `ai-provider`                   |
| Capabilities       | `ai-provider`                   |
| Version            | `1.0.0`                         |
| Configuration Mode | `hybrid`                        |
| Provider Type      | `openrouter`                    |
| Auto-enable        | **Yes**                         |
| Built-in           | Yes                             |
| System Plugin      | **Yes**                         |
| Default For        | `ai-provider`                   |
| Visibility         | `public`                        |

OpenRouter is unique among AI provider plugins because it is a **system plugin** with `autoEnable: true` and `defaultForCapabilities: ['ai-provider']`. This means it is automatically enabled and selected as the default AI provider for new works.

## Architecture

```mermaid
graph TD
    A[AiFacadeService] --> B[OpenRouterPlugin]
    B --> C[BaseAiProvider]
    C --> D[AiOperations]
    D --> E["LangChain OpenAI-compatible Provider"]
    E --> F["OpenRouter API Gateway<br/>openrouter.ai/api/v1"]
    F --> G[OpenAI Models]
    F --> H[Anthropic Models]
    F --> I[Google Models]
    F --> J[Meta / Open Models]
    F --> K[Other Providers]
```

OpenRouter's API is OpenAI-compatible, so the plugin uses the same LangChain OpenAI provider with `baseURL` set to `https://openrouter.ai/api/v1`.

## Configuration

### Settings Schema

| Setting        | Type     | Required | Default                        | Scope    | Widget         | Description                                                  |
| -------------- | -------- | -------- | ------------------------------ | -------- | -------------- | ------------------------------------------------------------ |
| `apiKey`       | `string` | Yes      | --                             | `user`   | --             | OpenRouter API key. Secret. Env: `PLUGIN_OPENROUTER_API_KEY` |
| `defaultModel` | `string` | Yes      | `openai/gpt-6.1-sol`           | `global` | `model-select` | Default model for all AI tasks.                              |
| `simpleModel`  | `string` | No       | `openai/gpt-6-luna`            | `global` | `model-select` | Model for tags, descriptions, classifications.               |
| `mediumModel`  | `string` | No       | `openai/gpt-6.1-sol`           | `global` | `model-select` | Model for listings, summaries, reformatting.                 |
| `complexModel` | `string` | No       | `openai/gpt-6-astra`           | `global` | `model-select` | Model for full page generation, multi-step analysis.         |
| `temperature`  | `number` | No       | `0.7`                          | --       | --             | Sampling temperature (0--2). Hidden.                         |
| `maxTokens`    | `number` | No       | `4096`                         | --       | --             | Max tokens per response. Hidden.                             |
| `baseUrl`      | `string` | No       | `https://openrouter.ai/api/v1` | --       | --             | API endpoint. Hidden.                                        |

Model defaults as of 2026-11-05 — source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models) (each id was listed that day) and OpenAI's [model guide](https://developers.openai.com/api/docs/models). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections. The `onLoad` bootstrap and `getDefaultModelId()` use the simple tier, `openai/gpt-6-luna`.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. The defaults moved from `openai/gpt-5-mini` (default, simple, standard) and `openai/gpt-5` (complex) to `openai/gpt-6.1-sol`, `openai/gpt-6-luna`, `openai/gpt-6.1-sol` and `openai/gpt-6-astra`; OpenAI shuts the old ids down on 2026-12-11. Nothing is migrated, because Ever Works has no production users yet.

### Model Naming Convention

OpenRouter uses a `provider/model` naming convention. Model IDs include the provider prefix:

| Provider  | Example Model IDs                                                                        |
| --------- | ---------------------------------------------------------------------------------------- |
| OpenAI    | `openai/gpt-6-astra`, `openai/gpt-6.1-sol`, `openai/gpt-6-luna`                          |
| Anthropic | `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5` |
| Google    | `google/gemini-4-argon`, `google/gemini-3.8-flash`, `google/gemini-3.5-flash-lite`       |
| xAI       | `x-ai/grok-4.7`, `x-ai/grok-4.3`                                                         |
| Meta      | `meta-llama/llama-4-scout`, `meta-llama/llama-4-maverick`                                |

Example ids as of 2026-11-05 — source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models). Availability depends on your account/plan/region; the picker lists OpenRouter's live models, accepts a custom model id and keeps existing saved selections.

### Model Tiers

```mermaid
graph LR
    subgraph "Default Tier Mapping"
        S["Simple Tasks<br/>Tags, classifications"] --> SM["openai/gpt-6-luna<br/>Cost-sensitive, high volume"]
        M["Standard Tasks<br/>Summaries, listings"] --> MM["openai/gpt-6.1-sol<br/>Balanced"]
        C["Complex Tasks<br/>Page generation"] --> CM["openai/gpt-6-astra<br/>Flagship"]
    end
```

Users can mix and match models from different providers across tiers. For example, using `anthropic/claude-haiku-5.5` for simple tasks and `google/gemini-4-argon` for complex tasks.

### Environment Variables

| Variable                          | Description           |
| --------------------------------- | --------------------- |
| `PLUGIN_OPENROUTER_API_KEY`       | OpenRouter API key    |
| `PLUGIN_OPENROUTER_DEFAULT_MODEL` | Default model ID      |
| `PLUGIN_OPENROUTER_SIMPLE_MODEL`  | Simple tier model ID  |
| `PLUGIN_OPENROUTER_MEDIUM_MODEL`  | Medium tier model ID  |
| `PLUGIN_OPENROUTER_COMPLEX_MODEL` | Complex tier model ID |
| `PLUGIN_OPENROUTER_BASE_URL`      | Custom API endpoint   |

## Capabilities

| Capability         | Supported                      |
| ------------------ | ------------------------------ |
| Structured Output  | Yes                            |
| Streaming          | Yes                            |
| Tool Calling       | Yes                            |
| Vision             | No (depends on selected model) |
| Max Context Length | 128,000 tokens                 |

:::note
Vision support depends on the specific model selected. While the plugin reports `supportsVision: false` at the plugin level, individual models accessed through OpenRouter (such as GPT-6.1 Sol or Claude Sonnet 5.5) do support vision. The capability is determined at the model level, not the provider level.
:::

## Configuration Mode: Hybrid

OpenRouter uses `hybrid` configuration mode, which offers the most flexibility:

```mermaid
graph TD
    A{Who provides the API key?}
    A --> B["Admin: Set PLUGIN_OPENROUTER_API_KEY<br/>env var for shared access"]
    A --> C["User: Enter own key<br/>in plugin settings"]
    B --> D[Shared billing through<br/>admin's OpenRouter account]
    C --> E[Per-user billing through<br/>user's OpenRouter account]
    D --> F[AI Operations]
    E --> F
```

- **Admin-managed**: Set `PLUGIN_OPENROUTER_API_KEY` as an environment variable. All users share this key and billing is centralized.
- **User-managed**: Each user enters their own API key. Billing is distributed to individual OpenRouter accounts.
- **Override**: If both admin and user keys exist, the user's key takes precedence (per the settings resolution hierarchy).

## System Plugin Behavior

As a system plugin, OpenRouter has special behavior:

1. **Auto-enabled**: Automatically activated when the platform starts
2. **Default provider**: Registered as the default for `ai-provider` capability
3. **Fallback**: Other AI providers (OpenAI, Anthropic, etc.) are optional alternatives
4. **Cannot be removed**: System plugins cannot be uninstalled, only disabled

```mermaid
graph TD
    A[Platform Start] --> B{Is OpenRouter loaded?}
    B -->|Yes| C[Auto-enable]
    B -->|No| D[Error: System plugin missing]
    C --> E[Register as default ai-provider]
    E --> F[Available for all works]
```

## Cost Optimization Strategy

Because OpenRouter provides access to models at different price points, the tiered model system enables cost optimization:

| Tier     | Recommended Strategy           | Example Models                                      |
| -------- | ------------------------------ | --------------------------------------------------- |
| Simple   | Use the cheapest/fastest model | `openai/gpt-6-luna`, `google/gemini-3.5-flash-lite` |
| Standard | Balance cost and quality       | `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5.5` |
| Complex  | Use the highest quality model  | `openai/gpt-6-astra`, `anthropic/claude-opus-5.5`   |

Example ids as of 2026-11-05 — source: [openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

## Lifecycle

```mermaid
sequenceDiagram
    participant Engine
    participant Plugin as OpenRouterPlugin
    participant AiOps as AiOperations

    Engine->>Plugin: onLoad(context)
    Plugin->>AiOps: new AiOperations({ providerType: 'openrouter', ... })
    Note right of AiOps: Default model: openai/gpt-6-luna
    Plugin-->>Engine: loaded

    Engine->>Plugin: createChatCompletion(options)
    Plugin->>Plugin: resolveConfig(options.settings)
    Plugin->>AiOps: createChatCompletion(options, config)
    AiOps-->>Plugin: ChatCompletionResponse

    Engine->>Plugin: onUnload()
    Plugin->>Plugin: aiOps = null
```

## Dependencies

| Package              | Version   | Purpose                              |
| -------------------- | --------- | ------------------------------------ |
| `@ever-works/plugin` | workspace | Plugin contracts and base classes    |
| `@langchain/openai`  | ^1.7.1    | LangChain OpenAI-compatible provider |
| `@langchain/core`    | ^1.3.0    | LangChain core abstractions          |

## Getting Started

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Generate an API key from the OpenRouter dashboard
3. Enter the key in the **OpenRouter API Key** field in plugin settings
4. Select your preferred models for each task complexity level
5. OpenRouter is enabled by default -- no additional activation needed
