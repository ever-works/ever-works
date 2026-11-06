# @ever-works/anthropic-plugin

Anthropic AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `anthropic`     |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the Anthropic plugin?

This plugin connects Ever Works to Anthropic's Claude models. Claude is recognized for producing well-structured, nuanced content and adhering closely to instructions, making it well-suited for work descriptions and detailed content generation.

## Why use it?

- **High-quality output** — Claude produces clear, well-organized content with attention to detail
- **Large context window** — process up to 200,000 tokens of source material per request
- **Precise instruction following** — reliably adheres to formatting preferences and content guidelines
- **Vision capabilities** — Claude can analyze images as part of the content generation process

## How it works in Ever Works

When selected as the AI provider, Claude handles content generation during work creation, powers the conversational AI assistant, and performs structured data extraction. You can assign different Claude models — Haiku for speed, Sonnet for balance, Opus for quality — to simple, standard, and complex task tiers.

## Getting started

1. Obtain an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Enable the Anthropic plugin on this page
3. Enter your API key in the settings below
4. Select your preferred Claude models for each task complexity level

## Settings

- **Anthropic API Key** — connects to Anthropic for content generation and chat (secret, per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Base URL** — custom API endpoint for proxies or compatible services (hidden, advanced).
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Model defaults

Model defaults as of 2026-11-05 — source: [platform.claude.com models overview](https://platform.claude.com/docs/en/about-claude/models/overview) (retirement dates: [model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)). Availability depends on your account/plan/region; the picker lists the vendor's live models, accepts a custom model id, and keeps existing saved selections.

| Setting                                                  | Default (2026-11-05) | Previous default                                              |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Default Model                                            | `claude-opus-5-5`    | `claude-opus-5-5` (unchanged)                                 |
| Simple Tasks Model                                       | `claude-haiku-5-5`   | `claude-haiku-4-5-20251001`                                   |
| Standard Tasks Model                                     | `claude-sonnet-5-5`  | `claude-sonnet-4-5-20250929` (deprecated, retires 2026-11-30) |
| Complex Tasks Model                                      | `claude-opus-5-5`    | `claude-opus-5-5` (unchanged)                                 |
| Bootstrap and fallback (`onLoad`, `getDefaultModelId()`) | `claude-opus-5-5`    | `claude-opus-5-5` (unchanged)                                 |

Each tier gets the vendor's current model for its role: Haiku 5.5 (fastest) for simple tasks, Sonnet 5.5 for standard tasks and Opus 5.5, the model the vendor recommends starting with, for complex tasks.

**Default shift.** Upgrading moves every config that never saved a simple or standard model to the defaults above. A model you saved explicitly is kept and still sent to the Claude API unchanged; `claude-sonnet-4-5-20250929` stops working when it retires on 2026-11-30, so switch away from it before then. Nothing is migrated: Ever Works has no production users yet, and the owner accepted the shift on 2026-11-05.

**Model picker.** The picker calls `GET https://api.anthropic.com/v1/models` with `Authorization: Bearer <your key>`, which the Claude API accepts (`x-api-key` is the legacy header, and `anthropic-version` is optional on this endpoint), and lists each model's `id` from `data[]`. The endpoint returns active and deprecated models, newest first, 20 per page by default, and the picker reads only the first page, so enter an older id as a custom model id. Source: [List Models](https://platform.claude.com/docs/en/api/models/list), checked 2026-11-05.

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Anthropic dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Anthropic per-minute, per-token, or per-account quota exhausted                                | Reduce concurrency, request a quota increase in the Anthropic console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Anthropic dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                                |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `anthropic` as the default for `ai-provider`, or disable competing AI plugins                                          |
| `healthCheck` reports unhealthy             | API key invalid OR Anthropic endpoint unreachable from the host                                | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                   |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/anthropic-plugin build
pnpm --filter @ever-works/anthropic-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-co/ever-works)
- [Plugin system](../../plugin/README.md)
- [Anthropic homepage](https://console.anthropic.com)

## License

AGPL-3.0
