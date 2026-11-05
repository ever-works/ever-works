# @ever-works/google-plugin

Google Gemini AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `google`        |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the Google Gemini plugin?

This plugin connects Ever Works to Google's Gemini models. Gemini provides a strong balance of speed, cost, and output quality, with support for exceptionally long documents and built-in embedding models for semantic search.

## Why use it?

- **Extended context window** — Gemini supports up to 1 million tokens, ideal for processing large volumes of source material
- **Embedding support** — Google's text-embedding models enable semantic search within your works
- **Cost-efficient performance** — Gemini Flash models deliver strong results at a low per-token cost
- **Vision capabilities** — analyze images and screenshots as part of content generation

## How it works in Ever Works

When selected as the AI provider, Gemini handles content generation during work creation, powers the conversational AI assistant, and produces text embeddings for semantic search. Gemini Flash-Lite and Flash are well-suited for simple and standard pipeline tasks, while Gemini 4 Argon handles complex content generation.

## Getting started

1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Enable the Google Gemini plugin on this page
3. Enter your API key in the settings below
4. Select your preferred Gemini models for each task complexity level

## Settings

- **Google AI API Key** — connects to Google Gemini for content generation and chat (secret, per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Base URL** — custom API endpoint for proxies or compatible services (hidden, advanced).
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Model defaults

Model defaults as of 2026-11-05 — source: [aistudio.google.com/docs/models](https://aistudio.google.com/docs/models) (the `ai.google.dev/gemini-api/docs` pages redirect there; shutdown dates: [deprecations](https://aistudio.google.com/docs/deprecations)). Availability depends on your account/plan/region; the picker lists the vendor's live models, accepts a custom model id, and keeps existing saved selections.

| Setting                                                  | Default (2026-11-05)           | Previous default                                  |
| -------------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Default Model                                            | `models/gemini-3.8-flash`      | `models/gemini-2.5-flash` (deprecated 2026-11-02) |
| Simple Tasks Model                                       | `models/gemini-3.5-flash-lite` | `models/gemini-2.0-flash` (shut down 2026-06-01)  |
| Standard Tasks Model                                     | `models/gemini-3.8-flash`      | `models/gemini-2.5-flash` (deprecated 2026-11-02) |
| Complex Tasks Model                                      | `models/gemini-4-argon`        | `models/gemini-2.5-pro` (deprecated 2026-11-02)   |
| Bootstrap and fallback (`onLoad`, `getDefaultModelId()`) | `models/gemini-3.8-flash`      | `models/gemini-2.5-flash`                         |

Each tier gets the vendor's current model for its role: Gemini 3.5 Flash-Lite (fastest, most cost-effective) for simple tasks, Gemini 3.8 Flash for standard tasks and the flagship Gemini 4 Argon for complex tasks. Gemini 4 Argon's price doubles after 2026-11-30 ($2 / $10 per million input / output tokens until then, $4 / $20 after).

**Default shift.** Upgrading moves every config that never saved a model to the defaults above; for the simple tier this is a fix, because `gemini-2.0-flash` no longer answers. A model you saved explicitly is kept and still sent to Gemini unchanged; the deprecated 2.5 models serve existing users only and are re-routed from 2026-12-01, so switch away from them. Nothing is migrated: Ever Works has no production users yet, and the owner accepted the shift on 2026-11-05.

## Troubleshooting

| Symptom                                     | Likely cause                                                                                   | Fix                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Invalid API key`                   | API key missing, revoked, or scoped to a different organization                                | Re-enter the **API Key** from the Google Gemini dashboard; verify the org/project, or set the documented `PLUGIN_*_API_KEY` env var as a default fallback |
| `429 Too Many Requests` / rate-limit errors | Google Gemini per-minute, per-token, or per-account quota exhausted                            | Reduce concurrency, request a quota increase in the Google Gemini console, or set a smaller `Max Tokens` / lower-cost model for the affected tier         |
| `Model not found` / `400 invalid model`     | Model id is not enabled for this account, region, or beta program                              | Pick an enabled model in the Google Gemini dashboard, or set the **Default Model** field to one your account has access to                                |
| Empty / truncated AI output                 | **Max Tokens** too low, **Temperature** too low for creative tasks, or context window exceeded | Raise **Max Tokens**, raise **Temperature** for creative work, or split the input into smaller batches                                                    |
| Plugin not selected during generation       | Another AI provider plugin is set as the default for `ai-provider`                             | In **Settings → Plugins**, set `google` as the default for `ai-provider`, or disable competing AI plugins                                                 |
| `healthCheck` reports unhealthy             | API key invalid OR Google Gemini endpoint unreachable from the host                            | Verify the key with a `curl` against the documented chat/completions endpoint and confirm outbound HTTPS is allowed by the firewall                       |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/google-plugin build
pnpm --filter @ever-works/google-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-co/ever-works)
- [Plugin system](../../plugin/README.md)
- [Google Gemini homepage](https://ai.google.dev)

## License

AGPL-3.0
