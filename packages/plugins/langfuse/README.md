# @ever-works/langfuse-plugin

Langfuse Plugin - External prompt management with versioning, labels, and A/B testing

## Plugin metadata

| Field        | Value             |
| ------------ | ----------------- |
| ID           | `langfuse`        |
| Category     | `utility`         |
| Capabilities | `prompt-provider` |
| Author       | Ever Works Team   |
| License      | MIT               |
| Built-in     | yes               |
| Auto-enable  | yes               |

## What is the Langfuse plugin?

[Langfuse](https://langfuse.com) is an open-source prompt management and LLM observability platform. It provides a centralized place to author, version, label, and roll out prompt templates for LLM-powered applications, alongside tracing, evaluations, and analytics for every generation.

This plugin lets Ever Works pull its pipeline prompt templates directly from your Langfuse project. Once enabled, prompts that drive item extraction, categorization, comparisons, and other generation steps can be edited, versioned, and promoted between labels (e.g. `staging` → `production`) inside Langfuse — without redeploying the Ever Works platform.

## Why use it?

- **Centralised prompt versioning** — every prompt change is captured as a new Langfuse version with full history
- **A/B-testable prompts** — use Langfuse labels and experiments to compare prompt variants on real generations
- **No-redeploy prompt edits** — update prompts in the Langfuse UI and have them picked up automatically by the platform
- **Observability of generations** — capture LLM calls, latency, token usage, and quality scores alongside the prompts that produced them
- **Traceable prompt iteration** — link outputs back to the exact prompt version, so regressions and improvements are easy to attribute

## How it works in Ever Works

When Langfuse is enabled as the active prompt provider, Ever Works fetches named prompt templates (such as `standard-pipeline.generation`, `comparison.markdown`, `agent-pipeline.parent-system`, and others) from your Langfuse project at generation time and uses them in the corresponding pipeline steps. Outputs, token usage, and trace metadata can be reported back to Langfuse so each generation is observable end-to-end and tied to the prompt version that produced it.

## Getting started

1. Create a Langfuse project at [langfuse.com](https://langfuse.com) (or stand up a self-hosted instance).
2. In [cloud.langfuse.com](https://cloud.langfuse.com) (or your self-hosted dashboard), generate an API key pair: a **public key** (`pk-lf-…`) and a **secret key** (`sk-lf-…`).
3. Paste both keys into the Langfuse plugin settings in Ever Works. For self-hosted instances, also set the **Base URL** to your Langfuse host.
4. Save the settings — Ever Works will validate the connection and start fetching prompts using the configured **Prompt Label** (defaults to `production`).

## Settings

- **Secret Key** (`secretKey`, secret) — Langfuse secret key (`sk-lf-…`). Required. Also readable from `PLUGIN_LANGFUSE_SECRET_KEY`.
- **Public Key** (`publicKey`) — Langfuse public key (`pk-lf-…`). Required. Also readable from `PLUGIN_LANGFUSE_PUBLIC_KEY`.
- **Base URL** (`baseUrl`) — Langfuse base URL, only needed for self-hosted instances. Defaults to `https://cloud.langfuse.com`. Also readable from `PLUGIN_LANGFUSE_BASE_URL`.
- **Prompt Label** (`promptLabel`) — label used to fetch prompts (e.g. `production`, `staging`). Defaults to `production`.
- **Cache TTL (seconds)** (`cacheTtlSeconds`) — how long to cache fetched prompts locally. Defaults to 300, max 86400.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/langfuse-plugin build
pnpm --filter @ever-works/langfuse-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Langfuse homepage](https://langfuse.com)
- [Langfuse cloud console](https://cloud.langfuse.com)

## License

MIT
