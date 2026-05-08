# @ever-works/groq-plugin

Groq AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `groq`          |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

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

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Groq dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Groq per-minute, per-token, or per-account quota exhausted                                     | Reduce concurrency, request a quota increase in the Groq console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Groq dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                           |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `groq` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR Groq endpoint unreachable from the host                                     | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall              |

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

AGPL-3.0
