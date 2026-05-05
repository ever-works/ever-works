# @ever-works/ollama-plugin

Ollama AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value             |
| ------------ | ----------------- |
| ID           | `ollama`          |
| Category     | `ai-provider`     |
| Capabilities | `ai-provider`     |
| Author       | Ever Works Team   |
| License      | MIT               |
| Built-in     | yes               |
| Auto-enable  | no                |

## What is the Ollama plugin?

This plugin connects Ever Works to an Ollama server for AI inference. Ollama hosts open-source models such as Llama, Mistral, Gemma, and others behind a local or remote API. Because you control the server, your data stays within your infrastructure.

## Why use it?

- **Data privacy** — requests are processed by your Ollama instance, keeping sensitive content off third-party servers
- **No API costs** — run unlimited requests against your own infrastructure
- **Open-source models** — choose from a wide range of community and foundation models
- **Embedding support** — models such as nomic-embed-text enable semantic search within your works

## How it works in Ever Works

When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your Ollama instance. The plugin is used during work generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.

## Getting started

1. Install and run Ollama ([ollama.com](https://ollama.com)) or connect to an existing instance
2. Ensure at least one model is available (e.g. `ollama pull qwen3.5:4b`)
3. Enable the Ollama plugin and set the **Base URL** to your Ollama server address
4. Select your preferred models for each task complexity level

## Settings

- **Ollama Server URL** — address of your Ollama instance, e.g. `http://localhost:11434/v1` (per-user, required).
- **API Key** — usually not needed; only for secured Ollama instances (per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/ollama-plugin build
pnpm --filter @ever-works/ollama-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Ollama homepage](https://ollama.com)

## License

MIT
