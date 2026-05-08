# @ever-works/openai-plugin

OpenAI AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `openai`        |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the OpenAI plugin?

This plugin connects Ever Works directly to OpenAI's API, providing access to models such as GPT-4o, GPT-4o mini, and OpenAI's text-embedding models. Use it when you prefer a direct connection to OpenAI with your own API key.

## Why use it?

- **Direct API access** — connect to OpenAI without an intermediary for the lowest possible latency
- **Latest models** — access new OpenAI releases as soon as they become available
- **Embedding support** — use text-embedding-3-small or other models for semantic search within your works
- **Vision capabilities** — models with image understanding for richer content analysis

## How it works in Ever Works

When selected as the AI provider, OpenAI handles content generation during work creation, powers the conversational AI assistant, and produces embeddings for semantic search. You can assign different models to simple, standard, and complex task tiers to control cost and output quality.

## Getting started

1. Obtain an API key from [platform.openai.com](https://platform.openai.com/api-keys)
2. Enable the OpenAI plugin on this page
3. Enter your API key in the settings below
4. Select your preferred models for each task complexity level

## Settings

- **OpenAI API Key** — connects to OpenAI for content generation and chat (secret, per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).
- **Base URL** — OpenAI API endpoint (hidden, advanced).

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the OpenAI dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | OpenAI per-minute, per-token, or per-account quota exhausted                                   | Reduce concurrency, request a quota increase in the OpenAI console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the OpenAI dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                             |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `openai` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR OpenAI endpoint unreachable from the host                                   | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/openai-plugin build
pnpm --filter @ever-works/openai-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [OpenAI homepage](https://platform.openai.com)

## License

AGPL-3.0
