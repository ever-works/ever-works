# @ever-works/groq-plugin

Groq AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value             |
| ------------ | ----------------- |
| ID           | `groq`            |
| Category     | `ai-provider`     |
| Capabilities | `ai-provider`     |
| Author       | Ever Works Team   |
| License      | MIT               |
| Built-in     | yes               |
| Auto-enable  | no                |

## What is the Groq plugin?

Groq provides ultra-fast AI inference using custom LPU (Language Processing Unit) hardware. It runs open-source models such as Llama and Mixtral at significantly higher speeds than conventional cloud providers.

## Why use it?

- **Exceptional speed** — responses arrive in milliseconds thanks to Groq's purpose-built hardware
- **Open-source models** — access Llama, Mixtral, and other leading open-weight models
- **Free tier available** — generous free usage limits for evaluation and small-scale use
- **Rapid iteration** — fast inference enables quick experimentation when refining work content

## How it works in Ever Works

When selected as the AI provider, Groq handles content generation during work creation and powers the conversational AI assistant. It is particularly effective for works with many items where generation speed is a priority. Note that Groq does not currently support embedding models.

## Getting started

1. Obtain a free API key from [console.groq.com](https://console.groq.com/keys)
2. Enable the Groq plugin on this page
3. Enter your API key in the settings below
4. Select your preferred models for each task complexity level

## Settings

- **Groq API Key** — connects to Groq for fast AI content generation and chat (secret, per-user).
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
pnpm --filter @ever-works/groq-plugin build
pnpm --filter @ever-works/groq-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Groq homepage](https://console.groq.com)

## License

MIT
