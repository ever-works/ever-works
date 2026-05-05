# @ever-works/mistral-plugin

Mistral AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `mistral`       |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is Mistral?

Mistral AI is a leading AI company that develops high-performance language models optimized for efficiency, speed, and quality. Their models range from compact and fast to large and highly capable, all accessible through an OpenAI-compatible API.

## Why use it?

- **High performance** — Mistral models deliver strong results across reasoning, coding, and multilingual tasks
- **Cost efficient** — competitive pricing with models optimized for different complexity levels
- **Vision support** — Pixtral models support image understanding alongside text
- **European AI** — built by a European company with a focus on open and transparent AI development

## How it works in Ever Works

When enabled, Mistral handles content creation, item descriptions, categorization, and summarization during work generation. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.

## Getting started

1. Create an account at [console.mistral.ai](https://console.mistral.ai)
2. Generate an API key from the Mistral console
3. Enter the key in the **Mistral API Key** field below
4. Select your preferred models for each task complexity level

## Settings

- **Mistral API Key** — connects to Mistral to access their AI models (secret, per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Base URL** — custom API endpoint for proxies or compatible services (hidden, advanced).
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/mistral-plugin build
pnpm --filter @ever-works/mistral-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Mistral homepage](https://mistral.ai)

## License

AGPL-3.0
