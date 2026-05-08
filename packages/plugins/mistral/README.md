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

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Mistral dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Mistral per-minute, per-token, or per-account quota exhausted                                  | Reduce concurrency, request a quota increase in the Mistral console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Mistral dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                              |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `mistral` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR Mistral endpoint unreachable from the host                                  | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                 |

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
