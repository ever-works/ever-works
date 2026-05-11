# @ever-works/grok-plugin

Grok (xAI) AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `grok`          |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the Grok plugin?

This plugin connects Ever Works to xAI's Grok models via the OpenAI-compatible xAI API. Grok is known for its real-time awareness and direct, unfiltered tone, which makes it a useful choice for content that needs to feel current and conversational.

## Why use it?

- **Long context window** — process up to 131,072 tokens of source material per request
- **Vision support** — Grok can analyze images alongside text prompts
- **Tool calling and structured output** — fits into the same agent patterns as OpenAI and Anthropic
- **OpenAI-compatible API** — drops into the existing Ever Works AI pipeline without bespoke transport

## How it works in Ever Works

When selected as the AI provider, Grok handles content generation during work creation, powers the conversational AI assistant, and performs structured data extraction. You can assign different Grok models to simple, standard, and complex task tiers.

## Getting started

1. Obtain an API key from [console.x.ai](https://console.x.ai)
2. Enable the Grok plugin on this page
3. Enter your API key in the settings below
4. Select your preferred Grok models for each task complexity level

## Settings

- **xAI API Key** — connects to xAI for Grok-powered content generation and chat (secret, per-user; env-var fallback `XAI_API_KEY`).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Base URL** — custom API endpoint for proxies or compatible services (hidden, advanced).
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the xAI dashboard; verify the org/project, or set the `XAI_API_KEY` env var as a default fallback                  |
| `429 Too Many Requests` / rate-limit errors | xAI per-minute, per-token, or per-account quota exhausted                                      | Reduce concurrency, request a quota increase in the xAI console, or set a smaller `Max Tokens` / lower-cost model for the affected tier          |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the xAI dashboard, or set the **Default Model** field to one your account has access to                                 |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                           |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `grok` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR xAI endpoint unreachable from the host                                      | Verify the key with a `curl` against `https://api.x.ai/v1/models` and confirm outbound HTTPS is allowed by the firewall                          |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/grok-plugin build
pnpm --filter @ever-works/grok-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [xAI homepage](https://x.ai)

## License

AGPL-3.0
