# @ever-works/ollama-plugin

Ollama AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `ollama`        |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

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

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Ollama dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Ollama per-minute, per-token, or per-account quota exhausted                                   | Reduce concurrency, request a quota increase in the Ollama console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Ollama dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                             |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `ollama` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR Ollama endpoint unreachable from the host                                   | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                |

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

AGPL-3.0
