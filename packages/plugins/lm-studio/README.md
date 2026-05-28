# @ever-works/lm-studio-plugin

LM Studio AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `lm-studio`     |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the LM Studio plugin?

This plugin connects Ever Works to an [LM Studio](https://lmstudio.ai) server for AI inference. LM Studio runs open-source models (Llama, Qwen, Mistral, Gemma, and others) locally and exposes them through an OpenAI-compatible API. Because the server runs on your own machine, your data never leaves your infrastructure.

## Why use it?

- **Data privacy** — requests are processed by your LM Studio instance, keeping sensitive content off third-party servers
- **No API costs** — run unlimited requests against your own hardware
- **Open-source models** — load any GGUF/MLX model supported by LM Studio
- **Friendly UI** — manage and download models from the LM Studio desktop app

## How it works in Ever Works

When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your LM Studio server. The plugin is used during work generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.

LM Studio exposes the same OpenAI-compatible `/v1` API as the other AI providers, so it reuses the shared `AiOperations` (LangChain) backend with a different base URL.

## Getting started

1. Install LM Studio ([lmstudio.ai](https://lmstudio.ai)) and download at least one model.
2. Start the **Local Server** in LM Studio (Developer tab) — it listens on `http://localhost:1234` by default.
3. Enable the LM Studio plugin and set the **Base URL** to your server address (include the `/v1` suffix).
4. Select your preferred model for each task complexity level.

## Settings

- **LM Studio Server URL** — address of your LM Studio server, e.g. `http://localhost:1234/v1` (per-user, required).
- **API Key** — usually not needed; only for instances placed behind an auth proxy. Stored encrypted (per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set. No hardcoded default: pick a model after the connection is established and the model list loads.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Embedding Model** — model used for semantic-search embeddings; only needed if you use KB search.
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Troubleshooting

| Symptom                               | Likely cause                                                       | Fix                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Plugin shows unavailable              | LM Studio local server not started                                 | Open LM Studio → Developer → **Start Server**, then re-test the connection                                   |
| No models in the dropdown             | No model loaded in LM Studio                                       | Load a model in the LM Studio app; the server serves whatever model is currently loaded                      |
| `Connection refused` / wrong base URL | Base URL missing the `/v1` suffix or wrong port                    | Verify the URL is `http://localhost:1234/v1` (or your configured host/port)                                  |
| Empty / truncated AI output           | **Max Tokens** too low, or context window exceeded                 | Raise **Max Tokens**, or split the input into smaller batches                                                |
| Plugin not selected during generation | Another AI provider plugin is set as the default for `ai-provider` | In **Settings → Plugins**, set `lm-studio` as the default for `ai-provider`, or disable competing AI plugins |
| Slow responses                        | Model too large for the available hardware                         | Use a smaller / quantized model, or increase available RAM / VRAM                                            |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/lm-studio-plugin build
pnpm --filter @ever-works/lm-studio-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [LM Studio homepage](https://lmstudio.ai)

## License

AGPL-3.0
