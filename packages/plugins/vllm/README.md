# @ever-works/vllm-plugin

vLLM AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `vllm`          |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the vLLM plugin?

This plugin connects Ever Works to a [vLLM](https://docs.vllm.ai) server for AI inference. vLLM is a high-throughput inference engine for open-source models, usually deployed on a GPU server. It exposes an OpenAI-compatible API, so Ever Works can use it for content generation, conversations, and embeddings — and because you run the server, your data stays within your infrastructure.

## Why use it?

- **Data privacy** — requests are processed by your own vLLM server, keeping sensitive content off third-party servers
- **No API costs** — run unlimited requests against your own GPU infrastructure
- **High throughput** — vLLM is optimized for concurrent, batched inference (PagedAttention)
- **Open-source models** — serve any model supported by vLLM

## How it works in Ever Works

When selected as the AI provider, Ever Works routes content generation, conversational AI, and embedding requests to your vLLM server. The plugin is used during work generation to produce item descriptions, summaries, and categorizations. You can assign different models to simple, standard, and complex task tiers to balance speed and quality.

vLLM exposes the same OpenAI-compatible `/v1` API as the other AI providers, so it reuses the shared `AiOperations` (LangChain) backend with a different base URL.

## Getting started

1. Start a vLLM OpenAI-compatible server: `vllm serve <model>` (listens on `http://localhost:8000` by default).
2. If you secured it with `--api-key <token>`, have that token ready.
3. Enable the vLLM plugin and set the **Base URL** to your server address (include the `/v1` suffix).
4. Enter the **API Key** if your server requires one (otherwise leave it as `EMPTY`).
5. Select your preferred model for each task complexity level.

## Settings

- **vLLM Server URL** — address of your vLLM server, e.g. `http://localhost:8000/v1` (per-user, required).
- **API Key** — only required if the server was started with `--api-key`; defaults to `EMPTY` for unsecured servers. Stored encrypted (per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set. No hardcoded default: pick the model your server was launched with (`--model`) after the connection is established.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Networking note (managed cloud vs self-hosted)

vLLM is typically deployed on a GPU server rather than a laptop. For the managed Ever Works cloud to reach it, the **Base URL must be resolvable from where work generation runs** — either a self-hosted Ever Works deployment on the same network, or a vLLM server exposed at a reachable (public or VPN) URL secured with `--api-key`. A `localhost` URL only works when Ever Works itself runs on the same machine/LAN as the vLLM server.

## Troubleshooting

| Symptom                                 | Likely cause                                                       | Fix                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Plugin shows unavailable                | vLLM server not running or not reachable from Ever Works           | Confirm `vllm serve` is up and the Base URL is reachable from where generation runs (see networking note) |
| `401` / `Invalid API key`               | Server started with `--api-key` but no/incorrect token entered     | Enter the exact `--api-key` token in the **API Key** field                                                |
| `Model not found` / `400 invalid model` | Selected model differs from the one vLLM was launched with         | Set the model fields to the value passed to `vllm serve --model ...` (use the model-select dropdown)      |
| No models in the dropdown               | Connection failed before `listModels()` could run                  | Fix the Base URL / API key first, then re-open the model picker                                           |
| Empty / truncated AI output             | **Max Tokens** too low, or context window exceeded                 | Raise **Max Tokens**, or reduce input size                                                                |
| Plugin not selected during generation   | Another AI provider plugin is set as the default for `ai-provider` | In **Settings → Plugins**, set `vllm` as the default for `ai-provider`, or disable competing AI plugins   |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/vllm-plugin build
pnpm --filter @ever-works/vllm-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [vLLM documentation](https://docs.vllm.ai)

## License

AGPL-3.0
