# @ever-works/vercel-ai-gateway-plugin

Vercel AI Gateway plugin for Ever Works platform

## Plugin metadata

| Field        | Value               |
| ------------ | ------------------- |
| ID           | `vercel-ai-gateway` |
| Category     | `ai-provider`       |
| Capabilities | `ai-provider`       |
| Author       | Ever Works Team     |
| License      | AGPL-3.0            |
| Built-in     | yes                 |
| Auto-enable  | no                  |

## What is Vercel AI Gateway?

Vercel AI Gateway is a unified API endpoint that provides access to models from providers such as OpenAI, Anthropic, Google, and others through a single OpenAI-compatible API. Rather than managing separate accounts for each provider, you connect once and select any available model.

## Why use it?

- **Unified access** — switch between GPT-4o, Claude, Gemini, and others without managing separate provider accounts
- **OpenAI-compatible** — uses the familiar OpenAI API format for easy integration
- **Cost optimization** — assign economy models to simple tasks and premium models to complex ones
- **Vercel integration** — seamlessly integrates with Vercel deployments and infrastructure

## How it works in Ever Works

Vercel AI Gateway handles content creation, item descriptions, categorization, and summarization during work generation. It also powers the conversational AI assistant and structured data extraction. You can configure three model tiers — simple, standard, and complex — to balance cost and output quality across different pipeline steps.

## Getting started

1. Set up Vercel AI Gateway in your Vercel dashboard
2. Generate an API key from the Vercel AI Gateway settings
3. Enter the key in the **Vercel AI Gateway API Key** field below
4. Select your preferred models for each task complexity level

## Settings

- **Vercel AI Gateway API Key** (`apiKey`, secret) — connects to Vercel AI Gateway to access models from multiple providers. User-scoped, also readable from `PLUGIN_VERCEL_AI_GATEWAY_API_KEY`.
- **Default Model** (`defaultModel`) — model used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** (`simpleModel`) — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** (`mediumModel`) — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** (`complexModel`) — handles full page generation and multi-step analysis.
- **Base URL** (`baseUrl`, hidden) — custom API endpoint for proxies or compatible services. Defaults to `https://ai-gateway.vercel.sh/v1`.
- **Temperature** (`temperature`, hidden) — sampling temperature, 0–2. Defaults to 0.7.
- **Max Tokens** (`maxTokens`, hidden) — limits the length of each AI-generated response. Defaults to 4096.

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Vercel AI Gateway dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Vercel AI Gateway per-minute, per-token, or per-account quota exhausted                        | Reduce concurrency, request a quota increase in the Vercel AI Gateway console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Vercel AI Gateway dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                                        |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `vercel-ai-gateway` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR Vercel AI Gateway endpoint unreachable from the host                        | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                           |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/vercel-ai-gateway-plugin build
pnpm --filter @ever-works/vercel-ai-gateway-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Vercel AI Gateway homepage](https://vercel.com/docs/ai-gateway)

## License

AGPL-3.0
