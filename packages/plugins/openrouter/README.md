# @ever-works/openrouter-plugin

OpenRouter AI provider plugin for Ever Works platform

## Plugin metadata

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| ID            | `openrouter`                                           |
| Category      | `ai-provider`                                          |
| Capabilities  | `ai-provider`                                          |
| Author        | Ever Works Team                                        |
| License       | MIT                                                    |
| Built-in      | yes                                                    |
| Auto-enable   | yes                                                    |

## What is OpenRouter?

OpenRouter is an AI gateway that provides access to hundreds of models from providers such as OpenAI, Anthropic, Google, and Meta through a single API key. Rather than managing separate accounts for each provider, you connect once and select any available model.

## Why use it?

- **Unified access** — switch between GPT-4o, Claude, Gemini, Llama, and others without managing separate provider accounts
- **Cost optimization** — assign economy models to simple tasks and premium models to complex ones
- **Provider redundancy** — OpenRouter can automatically route to an alternative if a provider is unavailable
- **Centralized billing** — track usage and spending across all models from a single dashboard

## How it works in Ever Works

OpenRouter is the default AI provider. During work generation, it handles content creation, item descriptions, categorization, and summarization. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.

## Getting started

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Generate an API key from the OpenRouter dashboard
3. Enter the key in the **OpenRouter API Key** field below
4. Select your preferred models for each task complexity level

## Settings

- **OpenRouter API Key** (`apiKey`, secret) — connects to OpenRouter to access models from multiple providers. User-scoped, also readable from `PLUGIN_OPENROUTER_API_KEY`.
- **Default Model** (`defaultModel`) — model used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** (`simpleModel`) — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** (`mediumModel`) — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** (`complexModel`) — handles full page generation and multi-step analysis.
- **Base URL** (`baseUrl`, hidden) — custom API endpoint for proxies or compatible services. Defaults to `https://openrouter.ai/api/v1`.
- **Temperature** (`temperature`, hidden) — sampling temperature, 0–2. Defaults to 0.7.
- **Max Tokens** (`maxTokens`, hidden) — limits the length of each AI-generated response. Defaults to 4096.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/openrouter-plugin build
pnpm --filter @ever-works/openrouter-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [OpenRouter homepage](https://openrouter.ai)

## License

MIT
