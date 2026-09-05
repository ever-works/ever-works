---
id: index
title: Plugin System
sidebar_label: Overview
sidebar_position: 1
---

# Plugin System

The Ever Works Platform uses a **capability-driven plugin architecture** where all external integrations — AI providers, search engines, deployment targets, screenshot services, and more — are implemented as self-contained plugins.

Instead of hardcoding providers, the platform asks "give me a plugin that can do X" and the system resolves which plugin to use based on admin, user, and work-level configuration.

## How It Works

1. **Plugins declare capabilities** — Each plugin implements one or more capability interfaces (e.g., `ai-provider`, `search`, `deployment`).
2. **Facades route requests** — When the platform needs to perform an AI completion or a web search, a facade service resolves the active plugin for the current scope.
3. **Settings cascade** — Plugin configuration follows a three-tier hierarchy: work settings override user settings, which override admin defaults.
4. **Discovery is automatic** — Plugins in `packages/plugins/` are discovered at startup. No manual registration is needed.

## Built-in Plugins

The platform ships with **102 plugins**. That number is the directory count of the plugin workspace: `ls packages/plugins` returns 103 entries, one of which is the workspace `README.md`, so the plugin total is 102. Each directory holds one plugin package whose `package.json` carries an `everworks.plugin` manifest declaring its `id`, `category`, and `capabilities` array.

The table below lists every category that ships with a concrete plugin today, grouped the way the dashboard groups them at `/plugins`.

| Category              | Plugins                                                                                                                                                                                        | Capability                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| AI Providers          | OpenAI, Anthropic, Google Gemini, Grok (xAI), Groq, Mistral, Ollama, LM Studio, vLLM                                                                                                           | `ai-provider`                                                                                                                |
| AI Gateways           | OpenRouter, Vercel AI Gateway                                                                                                                                                                  | `ai-provider`                                                                                                                |
| Search                | Brave, Tavily, SerpAPI, Exa, Perplexity, Bright Data, Firecrawl, Valyu, Linkup                                                                                                                 | `search`                                                                                                                     |
| Git Provider          | GitHub                                                                                                                                                                                         | `git-provider`, `oauth`                                                                                                      |
| Deployment            | Vercel, Kubernetes                                                                                                                                                                             | `deployment`                                                                                                                 |
| Screenshot            | ScreenshotOne, URLBox, Scrapfly                                                                                                                                                                | `screenshot`                                                                                                                 |
| Content Extractor     | Local HTML, Notion, Jina, PDF Extractor, OfficeCLI Extractor, Scrapfly                                                                                                                         | `content-extractor`                                                                                                          |
| Data Source           | Apify                                                                                                                                                                                          | `data-source`                                                                                                                |
| Pipeline              | Standard Pipeline, Agent Pipeline, Claude Code, Claude Managed Agent, Codex, Gemini Generator, OpenCode, Hermes Agent, Go-to-Market Pipeline, Make.com, SIM AI, Zapier, Composio, Activepieces | `pipeline`                                                                                                                   |
| Storage               | Local Filesystem, AWS S3, MinIO, GitHub Storage                                                                                                                                                | `storage`, `put-object`, `get-object`, `presigned-put`                                                                       |
| Database              | PostgreSQL DB                                                                                                                                                                                  | `database`, `datastore`                                                                                                      |
| Vector Store          | pgvector, Qdrant                                                                                                                                                                               | `vector-store`                                                                                                               |
| Email Providers       | Postmark, Resend, Mailgun, SendGrid, Mailchimp Transactional                                                                                                                                   | `email-outbound`, `email-inbound`                                                                                            |
| Notification Channels | Slack, Discord, Telegram, WhatsApp, Novu                                                                                                                                                       | `notification-channel`                                                                                                       |
| Connectors            | Slack, Discord, Linear, Notion, Jira, Zoom, Google Workspace, HubSpot, Pipedrive, Bluesky, Mastodon                                                                                            | `connector`, `event-source`                                                                                                  |
| Metrics               | Stripe, PostHog, Google Analytics, Custom HTTP                                                                                                                                                 | `metrics-provider`                                                                                                           |
| Job Runtimes          | Trigger.dev, Temporal, BullMQ, pg-boss, Inngest, Fleet Node                                                                                                                                    | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`                                    |
| Secret Stores         | HashiCorp Vault, Kubernetes, Infisical, Doppler, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault                                                                                      | `secret-store-resolve`                                                                                                       |
| DNS                   | Cloudflare DNS                                                                                                                                                                                 | `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain`                                             |
| Prompt Management     | Langfuse                                                                                                                                                                                       | `prompt-provider`                                                                                                            |
| Utility               | Comparison Generator, Agent Memory, Agent Memory Hooks, Browser Automation, Ever Works Skills, Ever Works Task Tracker, Local Workspace, Sandbox Workspace, Local PTY Terminal Host            | `agent-memory`, `pipeline-modifier`, `browser-automation`, `skills-provider`, `task-tracker`, `workspace`, `terminal-stream` |

See [Built-in Plugins](./built-in-plugins) for details on each plugin and its configuration.

### How each category is populated

Every plugin declares exactly one `category` in its manifest, so the counts below are unambiguous and add up to the 102 total.

| Category                | Count | Plugin directories under `packages/plugins/`                                                                                                                                                                                            |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`              | 14    | `activepieces`, `agent-pipeline`, `claude-code`, `claude-managed-agent`, `codex`, `composio`, `gemini`, `gtm-pipeline`, `hermes-agent`, `make`, `opencode`, `sim-ai`, `standard-pipeline`, `zapier`                                     |
| `ai-provider`           | 11    | `anthropic`, `google`, `grok`, `groq`, `lm-studio`, `mistral`, `ollama`, `openai`, `openrouter`, `vercel-ai-gateway`, `vllm`                                                                                                            |
| `connector`             | 11    | `bluesky-connector`, `discord-connector`, `google-workspace-connector`, `hubspot-connector`, `jira-connector`, `linear-connector`, `mastodon-connector`, `notion-connector`, `pipedrive-connector`, `slack-connector`, `zoom-connector` |
| `utility`               | 10    | `agentmemory`, `browser-automation`, `comparison-generator`, `everworks-skills`, `everworks-task-tracker`, `langfuse`, `local-workspace`, `memory-pipeline-modifier`, `pty-local`, `sandbox-workspace`                                  |
| `search`                | 9     | `brave`, `brightdata`, `exa`, `firecrawl`, `linkup`, `perplexity`, `serpapi`, `tavily`, `valyu`                                                                                                                                         |
| `secret-store-resolver` | 7     | `secret-store-aws-sm`, `secret-store-azure-kv`, `secret-store-doppler`, `secret-store-gcp-sm`, `secret-store-infisical`, `secret-store-k8s`, `secret-store-vault`                                                                       |
| `content-extractor`     | 6     | `jina`, `local-content-extractor`, `notion-extractor`, `officecli-extractor`, `pdf-extractor`, `scrapfly`                                                                                                                               |
| `job-runtime`           | 6     | `job-runtime-bullmq`, `job-runtime-inngest`, `job-runtime-node`, `job-runtime-pgboss`, `job-runtime-temporal`, `job-runtime-trigger`                                                                                                    |
| `email-provider`        | 5     | `mailchimp-transactional`, `mailgun`, `postmark`, `resend`, `sendgrid`                                                                                                                                                                  |
| `notification-channel`  | 5     | `discord-channel`, `novu-channel`, `slack-channel`, `telegram-channel`, `whatsapp-channel`                                                                                                                                              |
| `storage`               | 4     | `aws-s3`, `github-storage`, `local-fs`, `minio`                                                                                                                                                                                         |
| `metrics`               | 4     | `custom-http-metrics`, `google-analytics-metrics`, `posthog-metrics`, `stripe-metrics`                                                                                                                                                  |
| `deployment`            | 2     | `k8s`, `vercel`                                                                                                                                                                                                                         |
| `screenshot`            | 2     | `screenshotone`, `urlbox`                                                                                                                                                                                                               |
| `vector-store`          | 2     | `pgvector`, `qdrant`                                                                                                                                                                                                                    |
| `git-provider`          | 1     | `github`                                                                                                                                                                                                                                |
| `data-source`           | 1     | `apify`                                                                                                                                                                                                                                 |
| `database`              | 1     | `postgres-db`                                                                                                                                                                                                                           |
| `dns`                   | 1     | `cloudflare-dns`                                                                                                                                                                                                                        |

Two placements are worth calling out, because the manifest category and the everyday label differ:

- **Scrapfly** is categorised `content-extractor` but declares both `screenshot` and `content-extractor` capabilities, so it also appears under Screenshot.
- **Langfuse** is categorised `utility` and declares `prompt-provider`, which is why it shows under Prompt Management rather than as its own category.

Several categories exist in `PLUGIN_CATEGORIES` with no concrete plugin shipping under them yet — `form`, `integration`, `theme`, and the contract-only `memory` / `rag` pair. Their interfaces are stable and public so a community plugin can fill them without a platform change; nothing in the product depends on them today.

## Plugin SDK

The Plugin SDK (`@ever-works/plugin`) is a **standalone TypeScript package** with no NestJS dependencies. It provides:

- **`IPlugin` interface** — The contract every plugin implements
- **Base classes** — `BasePlugin`, `BaseAiProvider`, `BaseGitProvider`, `BasePipelineStep`
- **33 capability interfaces** — Typed contracts for each plugin category, one `*.interface.ts` file each under `packages/plugin/src/contracts/capabilities/`
- **Settings types** — JSON Schema with extensions for secrets, environment variables, and scoping
- **Plugin context** — Logger, cache, HTTP client, events, and settings access

See [Architecture](./architecture) for the full technical breakdown.

## Key Concepts

### Capabilities

A capability is a specific function a plugin can perform. One plugin can provide multiple capabilities — for example, the Tavily plugin provides both `search` and `content-extractor`.

Capability ids come from two places, both validated by the platform. The facade-routed set is enumerated in the `PLUGIN_CAPABILITIES` constant (`packages/plugin/src/contracts/facade-capabilities.ts`) and checked by `isValidPluginCapability()`. Newer contracts — `vector-store`, `memory`, `rag`, the DNS ops, the job-runtime verbs — declare their capability strings in their own interface file and are detected with a per-contract type guard (`isVectorStorePlugin()`, `isMemoryPlugin()`, `isRagPlugin()`, …) over the manifest's `capabilities` array.

Available capabilities, one row per interface file:

| Capability                                                                                                                                      | Interface                                     | Description                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-provider`                                                                                                                                   | `IAiProviderPlugin`                           | Chat completions, embeddings, structured output                                                                                                                           |
| `search`                                                                                                                                        | `ISearchPlugin`                               | Web search queries                                                                                                                                                        |
| `content-extractor`                                                                                                                             | `IContentExtractorPlugin`                     | URL content extraction, optionally with JavaScript rendering and selector scoping                                                                                         |
| `screenshot`                                                                                                                                    | `IScreenshotPlugin`                           | Website screenshot capture                                                                                                                                                |
| `data-source`                                                                                                                                   | `IDataSourcePlugin`                           | External data querying, with relevance filtering against the Work prompt                                                                                                  |
| `git-provider`                                                                                                                                  | `IGitProviderPlugin`                          | Repository management, cloning, pushing, plus the shared PR-insights rollup                                                                                               |
| `deployment`                                                                                                                                    | `IDeploymentPlugin`                           | Site deployment and status                                                                                                                                                |
| `oauth`                                                                                                                                         | `IOAuthPlugin`                                | OAuth authentication flows                                                                                                                                                |
| `device-auth`                                                                                                                                   | `IDeviceAuthProvider`                         | Device-code login for CLI-backed plugins (declared by Codex)                                                                                                              |
| `pipeline`                                                                                                                                      | `IPipelinePlugin`                             | Generation pipeline (Standard, Agent, Claude Code, Claude Managed Agent, Codex, Gemini, OpenCode, Hermes, Go-to-Market, Make.com, SIM AI, Zapier, Composio, Activepieces) |
| `pipeline-modifier`                                                                                                                             | `IPipelineModifierPlugin`                     | Injects or wraps steps in a host pipeline, with a build-time skip check                                                                                                   |
| `code-edit`                                                                                                                                     | `ICodeEditPlugin`                             | Edits a checked-out workspace in place; returns changed paths, a summary, and raw agent output                                                                            |
| `form-schema-provider`                                                                                                                          | `IFormSchemaProvider`                         | Dynamic form schema generation for plugin UIs                                                                                                                             |
| `prompt-provider`                                                                                                                               | `IPromptProviderPlugin`                       | External prompt management (e.g. Langfuse)                                                                                                                                |
| `storage`, `put-object`, `get-object`, `presigned-put`                                                                                          | `IStoragePlugin`                              | Object storage for uploads; `presigned-put` is opt-in for backends that can mint a direct-to-cloud upload URL                                                             |
| `database`, `datastore`                                                                                                                         | `IDatastorePlugin`                            | Relational database backend for deployed Works; the per-Work database name is derived as `ew_<workId>`                                                                    |
| `vector-store`                                                                                                                                  | `IVectorStorePlugin`                          | Chunk-embedding storage and similarity query behind the Knowledge Base                                                                                                    |
| `email-outbound`, `email-inbound`                                                                                                               | `IEmailOutboundPlugin`, `IEmailInboundPlugin` | Transactional and agent-driven email send, inbound parsing, and delivery events                                                                                           |
| `notification-channel`                                                                                                                          | `INotificationChannelPlugin`                  | Outbound fan-out to chat surfaces, plus a channel-specific id such as `notification-channel-slack`                                                                        |
| `connector`                                                                                                                                     | `IConnectorPlugin`                            | Bidirectional comms — outbound send plus inbound routing to an Agent or Team — with a provider id such as `connector-linear`                                              |
| `event-source`                                                                                                                                  | `IEventSourcePlugin`                          | Pull-model event ingestion into the normalized `IngestedEventEnvelope` spine, with an optional historical `backfill()`                                                    |
| `metrics-provider`                                                                                                                              | `IMetricsProviderPlugin`                      | Read-only business and operational metrics collection for Goals; any write is a contract violation                                                                        |
| `agent-memory`                                                                                                                                  | `IAgentMemoryPlugin`                          | Per-session persistent memory for coding and generation agents — sessions, observations, search, context build                                                            |
| `memory`                                                                                                                                        | `IMemoryPlugin`                               | Organization-wide memory framework, scoped by tenant / organization / work / mission. Contract-only — no plugin ships with it yet                                         |
| `rag`                                                                                                                                           | `IRagPlugin`                                  | A composed retrieval pipeline over an extractor, an embedder, and a vector store. Contract-only — no plugin ships with it yet                                             |
| `skills-provider`                                                                                                                               | `ISkillsProviderPlugin`                       | Skill catalogs — Markdown bodies plus parsed frontmatter                                                                                                                  |
| `task-tracker`                                                                                                                                  | `ITaskTrackerPlugin`                          | External task trackers behind the platform's own Task UI                                                                                                                  |
| `workspace`                                                                                                                                     | `IWorkspacePlugin`                            | Isolated Git working contexts for agent-executed Tasks — a fresh branch off `origin/<baseRef>`, shipped as a PR                                                           |
| `terminal-stream`                                                                                                                               | `ITerminalStreamPlugin`                       | Hosts a live, typable agent terminal session and pumps frames to the platform relay                                                                                       |
| `browser-automation`                                                                                                                            | `IBrowserAutomationPlugin`                    | Headless navigate / extract / screenshot / act behind a default-deny navigation allow-list re-checked on every redirect hop                                               |
| `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-worker-host`, `job-runtime-bind-tenant` | `IJobRuntimeProvider`                         | Background-job execution backends; the first four are required, the last two optional                                                                                     |
| `secret-store-resolve`                                                                                                                          | `ISecretStoreProvider`                        | Resolves a `<scheme>:<payload>` credential pointer into the plaintext credential bag a job runtime binds with                                                             |
| `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain`                                                                | `IDnsProvider`                                | Idempotent DNS record management for managed subdomains and custom domains                                                                                                |

### Configuration Modes

Each plugin declares how it should be configured:

- **`admin-only`** — Only admins can configure (system infrastructure plugins)
- **`user-required`** — Users must provide their own credentials (e.g., API keys)
- **`hybrid`** — Admin provides defaults, users can override

### Scoped Resolution

Each work can use a different plugin per capability. For example:

- Work A uses **OpenAI** for AI and **Brave** for search
- Work B uses **Anthropic** for AI and **Tavily** for search

This is managed through the [Settings System](./settings) and the work-level plugin management UI.

### Instance-level selectors

Three categories are not resolved per Work at all — they are picked once per deployment by an environment variable, because swapping them mid-flight would strand data or in-flight jobs:

| Selector                   | Chooses                            | Default    |
| -------------------------- | ---------------------------------- | ---------- |
| `STORAGE_BACKEND`          | The upload storage plugin          | `local-fs` |
| `EVER_WORKS_JOB_RUNTIME`   | The active job runtime             | `trigger`  |
| `PLUGIN_DISTRIBUTION_MODE` | Bundled vs. dynamic plugin loading | `bundled`  |

Every other registered plugin in those categories stays loaded but inert, so changing a selector is a restart rather than a migration.

## How to enable and configure a plugin

1. Open **`/plugins`** in the dashboard. The catalog groups every plugin by category and gives you a search box, a category filter, and an **enabled only** toggle.
2. Click a plugin to open **`/plugins/:pluginId`** — its README, its declared capabilities, and its settings schema.
3. Enable it, then fill in the settings. Fields marked `x-secret` (API keys, tokens) are stored encrypted and are never returned by the API; they come back masked or omitted.
4. To edit an already-enabled plugin later, go to **`/settings/plugins`** and pick its category. The per-category page lives at **`/settings/plugins/:category`** — for example `/settings/plugins/ai-provider`, `/settings/plugins/search`, `/settings/plugins/connector`.
5. To override a plugin choice for one Work only, open **`/works/:id/plugins`** and set the plugin for that capability. Work settings win over your user settings, which win over the admin defaults.

## How to manage plugins from the CLI

The CLI mirrors the dashboard, including the dynamic-distribution lifecycle:

```bash
# Interactive plugin manager, optionally filtered by category
ever-works plugins
ever-works plugins --category ai-provider

# Dynamic distribution (requires PLUGIN_DISTRIBUTION_MODE=dynamic)
ever-works plugins catalog              # list distributable plugins from the registry
ever-works plugins install <pluginId>   # install one at runtime
ever-works plugins install-status <pluginId>
ever-works plugins uninstall <pluginId>
```

The same data is available over REST: `GET /api/plugins` (optionally `?category=`), `GET /api/plugins/:pluginId` for the settings schema, and `GET /api/plugins/settings-menu` for the category-grouped navigation. See [API Reference](./api-reference) for the full endpoint list.

## Bundled vs. distributable

Every plugin manifest carries a `distribution` field. **Core** plugins are always baked into the platform image; **distributable** plugins are published to npm as `@ever-works/<id>-plugin` and installed on first enable when `PLUGIN_DISTRIBUTION_MODE=dynamic`. The split today is 27 core and 75 distributable — see [Built-in Plugins](./built-in-plugins) for the exact list and the classification rule.

## Documentation

| Page                                     | Description                                             |
| ---------------------------------------- | ------------------------------------------------------- |
| [Architecture](./architecture)           | Plugin SDK, interfaces, lifecycle, bootstrap, facades   |
| [Settings](./settings)                   | Three-tier settings, JSON Schema extensions, resolution |
| [Creating a Plugin](./creating-a-plugin) | Step-by-step guide for building a new plugin            |
| [Built-in Plugins](./built-in-plugins)   | Built-in plugins with configuration details             |
| [API Reference](./api-reference)         | REST endpoints for plugin management                    |

## Related

- [Plugin Categories & Capabilities](./plugin-categories.md) — the category constant and the capability constants in detail
- [Plugins](../features/plugins.md) — the user-facing guide to picking and configuring plugins
- [Storage Backends](../features/storage-backends.md) — `local-fs`, AWS S3, MinIO, GitHub Storage, and the `STORAGE_BACKEND` selector
- [Job Runtimes](../features/job-runtimes.md) — the six `job-runtime` plugins, the instance selector, and the tenant overlay
- [Secret Stores](../features/secret-stores.md) — the seven credential-pointer resolvers
- [Connectors](../features/connectors.md) — the eleven bidirectional connector plugins
- [Notifications](../features/notifications.md) — the five notification channels and event subscriptions
- [Agent Email & Inboxes](../features/agent-email.md) — what the email-provider plugins are wired into
- [Knowledge Base & Memory](../features/knowledge-base.md) — where the vector-store plugins are used
- [Memory (Org-Wide)](../features/memory.md) — the surface the `agent-memory` plugin feeds
- [Goals](../features/goals.md) — what the `metrics-provider` plugins are evaluated against
- [Managed Hosting](../features/managed-hosting.md) — the `postgres-db` and `cloudflare-dns` plugins in the managed path
- [Kubernetes Deployment](../features/k8s-deployment.md) — the `k8s` deployment plugin
- [Custom Domains](../features/custom-domains.md) — DNS records for a Work's own domain
- [Task Isolation](../features/task-isolation.md) — the `workspace` plugins behind worktree-per-Task
- [Agent Terminals](../features/agent-terminals.md) — the `terminal-stream` plugin behind live agent terminals
- [Skills Catalog](../features/skills-catalog.md) — the `skills-provider` plugin
- [Tasks](../features/tasks.md) — the `task-tracker` plugin
- [Campaigns](../features/campaigns.md) — the Go-to-Market pipeline plugin
