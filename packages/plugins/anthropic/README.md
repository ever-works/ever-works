# @ever-works/anthropic-plugin

Anthropic AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `anthropic`     |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | MIT             |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the Anthropic plugin?

This plugin connects Ever Works to Anthropic's Claude models. Claude is recognized for producing well-structured, nuanced content and adhering closely to instructions, making it well-suited for work descriptions and detailed content generation.

## Why use it?

- **High-quality output** — Claude produces clear, well-organized content with attention to detail
- **Large context window** — process up to 200,000 tokens of source material per request
- **Precise instruction following** — reliably adheres to formatting preferences and content guidelines
- **Vision capabilities** — Claude can analyze images as part of the content generation process

## How it works in Ever Works

When selected as the AI provider, Claude handles content generation during work creation, powers the conversational AI assistant, and performs structured data extraction. You can assign different Claude models — Haiku for speed, Sonnet for balance, Opus for quality — to simple, standard, and complex task tiers.

## Getting started

1. Obtain an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Enable the Anthropic plugin on this page
3. Enter your API key in the settings below
4. Select your preferred Claude models for each task complexity level

## Settings

- **Anthropic API Key** — connects to Anthropic for content generation and chat (secret, per-user).
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
pnpm --filter @ever-works/anthropic-plugin build
pnpm --filter @ever-works/anthropic-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Anthropic homepage](https://console.anthropic.com)

## License

MIT
