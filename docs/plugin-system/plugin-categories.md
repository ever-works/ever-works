---
id: plugin-categories
title: Plugin Categories & Capabilities
sidebar_label: Categories & Capabilities
sidebar_position: 7
---

# Plugin Categories & Capabilities

Every plugin in the Ever Works platform declares a **category** and one or more **capabilities**. The category determines how the platform classifies and displays the plugin, while capabilities define the interfaces the plugin implements and the operations it can perform.

## Plugin Categories

Categories are defined as a single source of truth in `@ever-works/plugin` via the `PLUGIN_CATEGORIES` constant, in `packages/plugin/src/contracts/plugin-manifest.types.ts`. It started at twelve entries and now carries **twenty-four**:

```typescript
const PLUGIN_CATEGORIES = [
	// The original twelve
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme',
	// Infrastructure and communication sockets added since
	'storage', // object storage: local disk, S3, MinIO, GitHub blobs
	'database', // relational backend for a deployed Work
	'email-provider', // outbound + inbound email transport
	'notification-channel', // outbound-only chat delivery
	'connector', // bidirectional channel plugins (send AND receive)
	'vector-store', // embedding storage for the Knowledge Base
	'dns', // DNS record management for deployed sites
	'secret-store-resolver', // credential-pointer resolvers
	'job-runtime', // background execution engines
	'memory', // org-wide memory frameworks (contract only)
	'rag', // composed retrieval pipelines (contract only)
	'metrics' // read-only metric collectors for Goals
] as const;

type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];
```

Each plugin declares exactly one category. The category is set on the plugin class and included in the plugin manifest.

**Nineteen of the twenty-four carry at least one shipped plugin.** The counts below come from the 102 plugin packages under `packages/plugins/` — `ls` returns 103 entries, one of which is the workspace `README.md` — read from each package's `everworks.plugin.category` field. The remaining five (`form`, `integration`, `theme`, `memory`, `rag`) are contracts with nothing registered under them yet.

### Category Overview

Ordered the way the dashboard orders them at `/plugins`.

| Category                | Description                                                              | Example Plugins                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`              | Defines the generation workflow                                          | Standard Pipeline (15 steps), Agent Pipeline (5 steps), Claude Code, Claude Managed Agent, Codex, Gemini CLI, OpenCode, Hermes Agent, Go-to-Market, Make.com, SIM AI, Zapier, Composio, Activepieces (14) |
| `ai-provider`           | Provides AI model access for content generation                          | OpenAI, Anthropic, Google, Grok, Groq, Mistral, Ollama, LM Studio, vLLM, OpenRouter, Vercel AI Gateway (11)                                                                                               |
| `search`                | Web search for discovering work items                                    | Tavily, Exa, SerpAPI, Brave, Perplexity, Bright Data, Firecrawl, Valyu, Linkup (9)                                                                                                                        |
| `content-extractor`     | Extracts structured content from URLs                                    | Local Content Extractor, Jina, Notion Extractor, PDF Extractor, OfficeCLI Extractor, Scrapfly (6)                                                                                                         |
| `screenshot`            | Captures website screenshots                                             | ScreenshotOne, Urlbox (2). Scrapfly also serves this capability from the `content-extractor` category                                                                                                     |
| `git-provider`          | Git hosting API operations and local git                                 | GitHub (1)                                                                                                                                                                                                |
| `deployment`            | Deploys generated works to hosting platforms                             | Vercel, Kubernetes (2)                                                                                                                                                                                    |
| `data-source`           | Imports items from external data APIs                                    | Apify (1)                                                                                                                                                                                                 |
| `storage`               | Object-storage backends for every uploaded byte                          | Local Filesystem, AWS S3, MinIO, GitHub Storage (4)                                                                                                                                                       |
| `database`              | Relational backend for a deployed Work                                   | PostgreSQL DB (1)                                                                                                                                                                                         |
| `vector-store`          | Embedding storage and similarity search for the Knowledge Base           | pgvector, Qdrant (2)                                                                                                                                                                                      |
| `dns`                   | Creates, probes and removes DNS records for deployed sites               | Cloudflare DNS (1)                                                                                                                                                                                        |
| `email-provider`        | Outbound and inbound email transport                                     | Resend, SendGrid, Postmark, Mailgun, Mailchimp Transactional (5)                                                                                                                                          |
| `notification-channel`  | Outbound-only delivery of a notification to a chat target                | Slack, Discord, Telegram, WhatsApp, Novu (5)                                                                                                                                                              |
| `job-runtime`           | Background execution engine behind every queued job                      | Trigger.dev, Temporal, BullMQ, pg-boss, Inngest, Fleet Node (6)                                                                                                                                           |
| `secret-store-resolver` | Turns an opaque credential pointer into a credential bag                 | HashiCorp Vault, Kubernetes, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Doppler, Infisical (7)                                                                                             |
| `form`                  | Provides custom form fields for the generator UI                         | None — pipeline plugins contribute fields through the `form-schema-provider` **capability** instead                                                                                                       |
| `integration`           | Third-party service integrations                                         | None registered today — outside systems arrive through `connector` and `notification-channel`                                                                                                             |
| `utility`               | General-purpose utilities                                                | Comparison Generator, Agent Memory, Memory Pipeline Modifier, Browser Automation, Ever Works Skills, Ever Works Task Tracker, Langfuse, Local Workspace, Sandbox Workspace, Local PTY host (10)           |
| `theme`                 | Visual theme customization                                               | None registered today                                                                                                                                                                                     |
| `connector`             | Bidirectional channel plugins — send outbound **and** accept inbound     | Slack, Discord, Linear, Notion, Jira, Zoom, Google Workspace, HubSpot, Pipedrive, Bluesky, Mastodon (11)                                                                                                  |
| `metrics`               | Read-only metric collectors that Goals are evaluated against             | Stripe, PostHog, Google Analytics, Custom HTTP (4)                                                                                                                                                        |
| `memory`                | Org-wide memory frameworks — storage, retrieval and synthesis            | None — contract only (`IMemoryPlugin`)                                                                                                                                                                    |
| `rag`                   | Composed retrieval pipelines orchestrating extractor, embedder and store | None — contract only (`IRagPlugin`)                                                                                                                                                                       |

### The five categories with no plugin yet

They are all valid manifest values — `isPluginCategory('theme')` returns `true` — so a community plugin can fill any of them without a platform change. Nothing in the product depends on them today.

| Category      | Why it is empty                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `form`        | Custom generator-form fields are contributed by the `form-schema-provider` capability, which every pipeline plugin declares. No plugin needs `form` as its category.                             |
| `integration` | Superseded in practice: bidirectional systems register as `connector`, outbound-only ones as `notification-channel`.                                                                             |
| `theme`       | Open socket. The look of a generated site currently comes from its template, not from a plugin.                                                                                                  |
| `memory`      | Contract only (`capabilities/memory.interface.ts`). The org-wide Memory surface and the per-Work Knowledge Base do not route through it.                                                         |
| `rag`         | Contract only (`capabilities/rag.interface.ts`). Knowledge Base retrieval composes a content extractor, an AI provider and a vector store directly rather than behind one `IRagPlugin` contract. |

### Where each category is documented

Every category that ships a plugin has a user-facing page describing what it does in the product, not just in the manifest.

| Category                | Read next                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ai-provider`           | [AI Provider Plugins](./ai-provider-plugins.md) · [Bring your own AI provider](../guides/bring-your-own-ai-provider.md) |
| `search`                | [Search Plugins](./search-plugins.md)                                                                                   |
| `content-extractor`     | [Content Extraction Plugins](./content-extraction-plugins.md)                                                           |
| `screenshot`            | [ScreenshotOne](./screenshotone-plugin.md) · [Urlbox](./urlbox-plugin.md)                                               |
| `git-provider`          | [GitHub Plugin](./github-plugin.md) · [Git Operations](../features/git-operations.md)                                   |
| `deployment`            | [Deployment Plugins](./deployment-plugins.md) · [Kubernetes Deployment](../features/k8s-deployment.md)                  |
| `data-source`           | [Data Source Plugins](./data-source-plugins.md)                                                                         |
| `pipeline`              | [Pipeline Plugins](./pipeline-plugins.md)                                                                               |
| `storage`               | [Storage Backends](../features/storage-backends.md)                                                                     |
| `database`              | [Managed Hosting](../features/managed-hosting.md)                                                                       |
| `vector-store`          | [Knowledge Base](../features/knowledge-base.md)                                                                         |
| `dns`                   | [Custom Domains](../features/custom-domains.md) · [Managed Hosting](../features/managed-hosting.md)                     |
| `email-provider`        | [Agent Email & Inboxes](../features/agent-email.md) · [Notifications](../features/notifications.md)                     |
| `notification-channel`  | [Notifications](../features/notifications.md)                                                                           |
| `connector`             | [Connectors](../features/connectors.md) · [Integrations](../features/integrations.md)                                   |
| `job-runtime`           | [Job Runtimes](../features/job-runtimes.md) · [Workers](../features/workers.md)                                         |
| `secret-store-resolver` | [Secret Stores](../features/secret-stores.md)                                                                           |
| `metrics`               | [Goals](../features/goals.md)                                                                                           |
| `utility`               | [Built-in Plugins](./built-in-plugins.md)                                                                               |
| Everything else         | [Plugins](../features/plugins.md) — the dashboard view of all twenty-four                                               |

### Dashboard grouping and display order

`/plugins` groups cards under category headings and offers one chip per category, using the label and icon maps in `apps/web/src/lib/utils/plugin-category-icons.ts`. The ids above are not what a reader sees — `CATEGORY_LABELS` renames several of them:

| Category id             | Dashboard label       |
| ----------------------- | --------------------- |
| `content-extractor`     | Content Processors    |
| `data-source`           | Data Sources          |
| `secret-store-resolver` | Secret Stores         |
| `job-runtime`           | Job Runtimes          |
| `notification-channel`  | Notification Channels |
| `email-provider`        | Email Providers       |
| `vector-store`          | Vector Stores         |
| `database`              | Databases             |
| `dns`                   | DNS Providers         |
| `memory`                | Memory Frameworks     |
| `rag`                   | RAG Pipelines         |

`CATEGORY_DISPLAY_ORDER` in the same file pins twenty of the twenty-four into a fixed sequence. **`connector`, `metrics`, `memory` and `rag` are absent from that array**, so `compareCategoryOrder()` sorts them to the end, after Themes. A chip only appears for a category that has at least one registered plugin on the install, which is why Memory Frameworks and RAG Pipelines never show up.

## Plugin Capabilities

Capabilities are the functional interfaces a plugin implements. A plugin can declare multiple capabilities. For example, the Exa plugin declares both `search` and `content-extractor` capabilities.

### Capability Constants

```typescript
const PLUGIN_CAPABILITIES = {
	AI_PROVIDER: 'ai-provider',
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	PIPELINE: 'pipeline',
	PIPELINE_MODIFIER: 'pipeline-modifier',
	FORM_SCHEMA_PROVIDER: 'form-schema-provider',
	DEPLOYMENT: 'deployment',
	GIT_PROVIDER: 'git-provider',
	OAUTH: 'oauth'
} as const;
```

That excerpt is the original set. The constant in `packages/plugin/src/contracts/facade-capabilities.ts` now holds **45 entries**, validated by `isValidPluginCapability()` against `ALL_PLUGIN_CAPABILITIES`.

### Capability Interfaces

Each capability maps to a TypeScript interface that the plugin must implement:

| Capability             | Interface                 | Required Methods                                                                                                                      |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-provider`          | `IAiProviderPlugin`       | `createChatCompletion()`, `listModels()`, `getModel()`, `isAvailable()`, `getCapabilities()`                                          |
| `search`               | `ISearchPlugin`           | `search()`, `isAvailable()`                                                                                                           |
| `content-extractor`    | `IContentExtractorPlugin` | `extract()`, `isAvailable()`                                                                                                          |
| `screenshot`           | `IScreenshotPlugin`       | `capture()`, `isAvailable()`                                                                                                          |
| `data-source`          | `IDataSourcePlugin`       | `query()`, `isAvailable()`                                                                                                            |
| `pipeline`             | `IPipelinePlugin`         | `getStepDefinitions()`, `execute()`                                                                                                   |
| `pipeline-modifier`    | `IPipelineModifierPlugin` | `execute()`, `targetPipelines`                                                                                                        |
| `git-provider`         | `IGitProviderPlugin`      | `getAuth()`, `getCloneUrl()`, `createRepository()`, `getRepository()`, `createPullRequest()`, `mergePullRequest()` + `IGitOperations` |
| `deployment`           | `IDeploymentPlugin`       | `deploy()`, `getDeploymentStatus()`                                                                                                   |
| `oauth`                | `IOAuthPlugin`            | `getOAuthConfig()`, `exchangeCode()`, `getUser()`                                                                                     |
| `form-schema-provider` | `IFormSchemaProvider`     | `getFormFields()`, `getFormGroups()`                                                                                                  |

### Capability interfaces added since

One `*.interface.ts` file per contract under `packages/plugin/src/contracts/capabilities/` — 33 files in total.

| Capability             | Interface                    | Required Methods                                                                           |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `storage`              | `IStoragePlugin`             | `putObject()`, `getObject()`, `deleteObject()`, `isAvailable()`; `presignPut()` optional   |
| `datastore`            | `IDatastorePlugin`           | `isAvailable()`, `testDatabaseConnection()`                                                |
| `vector-store`         | `IVectorStorePlugin`         | `upsertChunks()`, `queryChunks()`, `deleteByDocument()`, `deleteByWork()`, `isAvailable()` |
| `email-outbound`       | `IEmailOutboundPlugin`       | `sendEmail()`, `verifyAddress()`                                                           |
| `email-inbound`        | `IEmailInboundPlugin`        | `parseInboundWebhook()`, `verifyWebhookSignature()`                                        |
| `notification-channel` | `INotificationChannelPlugin` | `verifyTarget()`, `send()`                                                                 |
| `connector`            | `IConnectorPlugin`           | `verifyConnection()`, `send()`; `parseInbound()`, `poll()`, `reply()` optional             |
| `event-source`         | `IEventSourcePlugin`         | `pullEvents()`; `backfill()` optional                                                      |
| `metrics-provider`     | `IMetricsProviderPlugin`     | `listMetrics()`, `getMetricValue()`                                                        |
| `secret-store-resolve` | `ISecretStoreProvider`       | `resolveSecret()`                                                                          |
| `job-runtime-*`        | `IJobRuntimeProvider`        | `registerSchedules()`, `cancel()`, `getRunStatus()`, `isEnabled()`                         |
| `dns-*`                | `IDnsProvider`               | `ensureRecord()`, `removeRecord()`, `recordExists()`, `rootDomain()`                       |
| `skills-provider`      | `ISkillsProviderPlugin`      | `listEntries()`, `getEntry()`                                                              |
| `task-tracker`         | `ITaskTrackerPlugin`         | `listTasks()`, `getTask()`, `createTask()`, `updateTask()`, `deleteTask()`                 |
| `workspace`            | `IWorkspacePlugin`           | `provision()`, `finalize()`, `simulateMerge()`, `teardown()`                               |
| `terminal-stream`      | `ITerminalStreamPlugin`      | session `write()` / `resize()` / `kill()`; relay `publish()` / `inbound()` / `close()`     |
| `agent-memory`         | `IAgentMemoryPlugin`         | `openSession()`, `closeSession()`, `saveMemory()`, `searchMemory()`, `buildContext()`      |
| `browser-automation`   | `IBrowserAutomationPlugin`   | `open()`, `navigate()`, `extract()`                                                        |
| `code-edit`            | `ICodeEditPlugin`            | `executeCodeEdit()`                                                                        |
| `prompt-provider`      | `IPromptProviderPlugin`      | `getPrompt()`, `isAvailable()`                                                             |
| `memory`               | `IMemoryPlugin`              | `index()`, `search()` — contract only, no plugin ships under it                            |
| `rag`                  | `IRagPlugin`                 | `ingest()`, `retrieve()`, `getSupportedDocTypes()` — contract only                         |

### Umbrella and verb capabilities

Newer contracts split one job across several capability strings, so a manifest can advertise exactly what a plugin does:

| Pattern                              | Example manifest                                                                                 | Why                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Umbrella + one per provider          | Slack Connector: `connector`, `connector-slack`, `event-source`                                  | The umbrella drives discovery and UI grouping; the provider-specific id lets the platform find _that_ connector without hardcoding a plugin id. |
| Umbrella + optional extras           | AWS S3: `storage`, `put-object`, `get-object`, `presigned-put`                                   | `put-object` and `get-object` are the floor. `presigned-put` is opt-in for backends that can hand the browser a direct-upload URL.              |
| One per verb, no umbrella            | Cloudflare DNS: `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain` | `isDnsProvider()` requires all four before the platform will route a record through the plugin.                                                 |
| One per verb, with an optional extra | Fleet Node: `job-runtime-enqueue`, `-cancel`, `-status`, `-schedule`, `-worker-host`             | The first four are required of every runtime; `job-runtime-worker-host` marks the pull-model runtimes that host their own workers.              |
| A single verb                        | HashiCorp Vault: `secret-store-resolve`                                                          | A resolver does one thing.                                                                                                                      |

Capability ids come from two places, and both are valid. The facade-routed set is enumerated in `PLUGIN_CAPABILITIES`. The newer contracts — `vector-store`, `memory`, `rag`, `datastore`, the DNS verbs, the job-runtime verbs, `secret-store-resolve` — declare their strings in their own interface file and are detected with a per-contract type guard rather than by looking them up in the constant.

### Type Guards

The plugin system provides type guard functions for each capability:

```typescript
import {
	isAiProviderPlugin,
	isSearchPlugin,
	isContentExtractorPlugin,
	isScreenshotPlugin,
	isDataSourcePlugin,
	isPipelinePlugin,
	isPipelineModifierPlugin,
	isGitProviderPlugin,
	isDeploymentPlugin
} from '@ever-works/plugin';

// Usage in facade or platform code
if (isSearchPlugin(plugin)) {
	const results = await plugin.search({ query: 'example' });
}
```

The newer contracts follow the same naming: `isStoragePlugin`, `isVectorStorePlugin`, `isConnectorPlugin`, `isNotificationChannelPlugin`, `isEmailOutboundPlugin`, `isEmailInboundPlugin`, `isEventSourcePlugin`, `isMetricsProviderPlugin`, `isSkillsProviderPlugin`, `isTaskTrackerPlugin`, `isWorkspacePlugin`, `isTerminalStreamPlugin`, `isAgentMemoryPlugin`, `isBrowserAutomationPlugin`, `isCodeEditPlugin`, `isPromptProviderPlugin`, `isMemoryPlugin` and `isRagPlugin` — plus `isDnsProvider`, `isFormSchemaProvider` and `isDeviceAuthProvider`, which are named after the interface rather than suffixed `Plugin`.

## Selectable Provider Categories

Certain capabilities are selectable in the generator form UI. These are defined by `SELECTABLE_PROVIDER_CATEGORIES`:

```typescript
const SELECTABLE_PROVIDER_CATEGORIES = {
	search: { capability: 'search', uiKey: 'search', selectableInForm: true },
	screenshot: { capability: 'screenshot', uiKey: 'screenshot', selectableInForm: true },
	ai: { capability: 'ai-provider', uiKey: 'ai', selectableInForm: true },
	contentExtractor: { capability: 'content-extractor', uiKey: 'contentExtractor', selectableInForm: true },
	pipeline: { capability: 'pipeline', uiKey: 'pipeline', selectableInForm: true }
} as const;
```

When a user creates a work, they can select which plugin to use for each selectable category. Plugins that declare `defaultForCapabilities` in their manifest are pre-selected.

**These five are still the whole list.** None of the categories added since is chosen per Work in the generator form. Storage, job runtime and vector store are resolved from operator or tenant configuration — `STORAGE_BACKEND`, `EVER_WORKS_JOB_RUNTIME` (with the tenant overlay at `/settings/job-runtime`), `KB_VECTOR_STORE_PROVIDER_ID` — a secret store is picked by the scheme prefix of the credential pointer it is asked to resolve, and connectors, notification channels, email providers and metrics providers are chosen where they are used: a channel target, an Agent mailbox, a Goal.

## Plugin Visibility

Each plugin can set a visibility level in its manifest:

| Visibility  | Behavior                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `public`    | Shown to all users in all plugin lists (default)                       |
| `hidden`    | Never shown in the plugin UI; used for internal infrastructure plugins |
| `user-only` | Shown in user plugin settings but not in work plugin lists             |

:::note `operator` is not a fourth level
The six `job-runtime` and seven `secret-store-resolver` packages declare `visibility: 'operator'` in their manifests. `PluginVisibility` has only the three values above, and the filters in `packages/agent/src/plugins/services/plugin-operations.service.ts` test for exactly `'hidden'` and `'user-only'` — so anything else, `operator` included, behaves as `public`, and those plugins do appear in the plugin lists. The word records intent; it does not hide anything.
:::

### Supplementary Plugins

Plugins with `supplementary: true` in their manifest are excluded from manual provider selection dropdowns. They still declare their capability and auto-activate through URL-based routing in the facade layer. This is used for narrow-scope extractors like the Notion Extractor (activates only for `notion.so` URLs) and the PDF Extractor (activates only for `.pdf` URLs).

## Multi-Capability Plugins

A single plugin can implement multiple capabilities. This is common for search and content extraction:

| Plugin            | Capabilities                       |
| ----------------- | ---------------------------------- |
| Exa               | `search`, `content-extractor`      |
| Tavily            | `search`, `content-extractor`      |
| Firecrawl         | `search`, `content-extractor`      |
| Bright Data       | `search`, `content-extractor`      |
| Scrapfly          | `screenshot`, `content-extractor`  |
| GitHub            | `git-provider`, `oauth`            |
| Standard Pipeline | `pipeline`, `form-schema-provider` |
| Agent Pipeline    | `pipeline`, `form-schema-provider` |

The same pattern runs through the categories added since:

| Plugin            | Category            | Capabilities                                                                                                         |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Jina              | `content-extractor` | `search`, `content-extractor`                                                                                        |
| Linkup, Valyu     | `search`            | `search`, `content-extractor`                                                                                        |
| Vercel            | `deployment`        | `deployment`, `oauth`                                                                                                |
| Apify             | `data-source`       | `data-source`, `form-schema-provider`                                                                                |
| Claude Code       | `pipeline`          | `pipeline`, `form-schema-provider`, `code-edit`                                                                      |
| Codex             | `pipeline`          | `pipeline`, `form-schema-provider`, `device-auth`, `code-edit`                                                       |
| Composio          | `pipeline`          | `pipeline`, `form-schema-provider`, `skills-provider`                                                                |
| AWS S3, MinIO     | `storage`           | `storage`, `put-object`, `get-object`, `presigned-put`                                                               |
| GitHub Storage    | `storage`           | `storage`, `put-object`, `get-object`, `lfs`                                                                         |
| PostgreSQL DB     | `database`          | `database`, `datastore`                                                                                              |
| Postmark, Mailgun | `email-provider`    | `email-outbound`, `email-inbound`                                                                                    |
| Slack Connector   | `connector`         | `connector`, `connector-slack`, `event-source`                                                                       |
| Cloudflare DNS    | `dns`               | `dns`, `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain`                              |
| Fleet Node        | `job-runtime`       | `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-worker-host` |

When a plugin provides multiple capabilities, the manifest's `defaultForCapabilities` array specifies which capabilities it should be the default provider for:

```typescript
// A plugin with multiple capabilities, default for only one
{
  capabilities: ['search', 'content-extractor'],
  defaultForCapabilities: ['search']
}
```

## Configuration Modes

Every plugin declares a `configurationMode` that determines how its settings are managed:

| Mode            | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `admin-only`    | Only platform admins can configure the plugin                        |
| `user-required` | Each user must provide their own credentials (e.g., API keys)        |
| `hybrid`        | Admins set global defaults; users can override with their own values |

Most AI provider plugins use `user-required` since users provide their own API keys. Infrastructure plugins like GitHub use `hybrid` with admin-level OAuth app credentials and user-level tokens.

## How to browse plugins by category

### In the dashboard

1. Open **Plugins** in the sidebar (`/plugins`).
2. Pick a **category chip** — **All**, plus one chip per category that has at least one plugin registered on this install. Picking a chip flattens the grouped list into a single grid.
3. Or type into the search box: it matches the plugin **name**, **description**, **category** and **capabilities**, so `connector` and `secret-store-resolve` both work as queries.
4. To walk one category's settings, open `/settings/plugins/<category>` using the id from the table above — for example `/settings/plugins/ai-provider` or `/settings/plugins/secret-store-resolver`. The route validates the segment with `isPluginCategory()`, so a mistyped id returns a 404 — and so does a valid category with nothing enabled in it (every category except `pipeline`).

### From the CLI

```bash
# Every plugin, or just one category
ever-works plugins
ever-works plugins --category connector
ever-works plugins -c job-runtime

# What is installable on a dynamic-distribution install
ever-works plugins catalog
```

### Over the API

```bash
# All plugins, with your installation status
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/plugins

# One category
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3100/api/plugins?category=notification-channel"

# The category-grouped settings navigation
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/plugins/settings-menu
```

## Related

- [Plugin System Overview](./index.md) — per-category plugin counts and the full capability table
- [Plugin Architecture](./architecture.md) — how a declared capability becomes a facade call
- [Built-in Plugins](./built-in-plugins.md) — every shipped plugin with its configuration
- [Creating a Plugin](./creating-a-plugin.md) — picking a category and capability for a new plugin
- [Plugin Settings](./settings.md) — the three-tier settings resolution behind `configurationMode`
- [Plugins](../features/plugins.md) — the dashboard guide to enabling and configuring them
- [Storage Backends](../features/storage-backends.md) · [Secret Stores](../features/secret-stores.md) · [Job Runtimes](../features/job-runtimes.md)
- [Connectors](../features/connectors.md) · [Notifications](../features/notifications.md) · [Managed Hosting](../features/managed-hosting.md)
