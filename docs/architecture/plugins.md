---
id: plugins
title: Plugin System (End-to-End)
sidebar_label: Plugin System (End-to-End)
---

# Plugin System (End-to-End)

The plugin system is the seam that lets Ever Works swap AI providers,
search backends, content extractors, screenshot services, git hosts,
deployment targets, pipelines, storage backends, prompt providers, and
ad-hoc utilities without touching the API or agent code. This page is the
**one-stop architecture overview** — it traces a request from a facade
call all the way down to the `BaseAiProvider` subclass that talks to the
upstream API, explains how settings are extended via custom JSON-Schema
keywords, and shows how to author a brand-new plugin.

Most pages in the [Plugin System](../plugin-system/index.md) section
zoom into a single concern (settings, a category guide, a specific
plugin). This page is the map that ties them all together.

## The plugin contract in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         API / Agent caller                           │
│                                                                      │
│   AiFacadeService.askJson(...)   SearchFacadeService.search(...)     │
│   DeployFacadeService.deploy(.)  StorageFacade.putObject(.)          │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ provider selection
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  PluginRegistryService (in-memory)                   │
│        id → IPlugin instance,  category → IPlugin[]                  │
│        capability → IPlugin[], default-for-capability → IPlugin      │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ resolved settings
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│   IPlugin instance (BaseAiProvider / BaseGitProvider / ...)          │
│      ▸ onLoad(ctx) → cache, http, env, logger, settings              │
│      ▸ category-specific methods (createChatCompletion, search, ...) │
│      ▸ JSON-Schema settings validation                               │
└──────────────────────────────────────────────────────────────────────┘
```

## End-to-end lifecycle

### 1. Discovery & boot

On NestJS application startup `PluginBootstrapService.bootstrap()`
walks the configured discovery paths
(`./plugins`, `./node_modules/@ever-works`, `./packages/plugins`,
`../plugins`, `../../packages/plugins`), reads each candidate's
`package.json`, and validates the `everworks.plugin` block:

```jsonc
{
	"name": "@ever-works/openai-plugin",
	"version": "1.4.2",
	"everworks": {
		"plugin": {
			"id": "openai",
			"name": "OpenAI",
			"category": "ai-provider",
			"capabilities": ["ai-provider", "transcribe", "embedding"],
			"defaultForCapabilities": ["ai-provider"],
			"configurationMode": "user-required",
			"autoEnable": true,
			"builtIn": true
		}
	}
}
```

Manifests are then **topologically sorted** by inter-plugin dependencies
so providers (e.g. an AI gateway a pipeline depends on) load first.

### 2. Instantiation & `onLoad`

For each valid manifest the loader:

1. Dynamically `import()`s the module.
2. Instantiates the exported plugin class.
3. Persists / upserts a `PluginEntity` row keyed by `pluginId`.
4. Registers the instance in the in-memory `PluginRegistryService`.
5. Builds a `PluginContext` and calls `plugin.onLoad(context)`.

`PluginContext` is the only surface a plugin sees of the platform. It
gives the plugin a **plugin-scoped logger, cache, http client, env-var
accessor, and settings reader**, plus an event bus for plugin-to-plugin
notifications. Plugins **never** touch NestJS, TypeORM, or other
platform internals directly — that's what keeps them swappable.

### 3. `BaseAiProvider` + `AiOperations`

AI providers extend `BaseAiProvider` from `@ever-works/plugin/abstract`,
which in turn delegates the heavy lifting to `AiOperations` in
`@ever-works/plugin/ai`. `AiOperations` is a thin wrapper around
LangChain's chat models and embeddings:

- `createChatCompletion()` and `createStreamingChatCompletion()` build
  a `BaseChatModel` from the provider's settings, normalize tool calls,
  reasoning content, token usage, and stop reasons.
- `createEmbedding()` reuses LangChain's `Embeddings` interface.
- `transcribe()` (optional) is implemented per provider — OpenAI's
  Whisper, Groq's whisper-large, etc.
- Token usage and reasoning traces are emitted via the shared
  `TokenUsageTracker` so the agent's budget guard and PostHog events
  see a uniform shape regardless of upstream.

This is what lets a single `AiFacadeService.askJson()` call work
identically whether the resolved provider is OpenAI, Anthropic, Google,
Groq, Ollama, Mistral, or OpenRouter — providers differ in their
authenticator + base URL + model catalog, not in the call signature
agent code uses.

### 4. Settings extensions

Settings schemas are vanilla JSON Schema with three Ever-Works-specific
extension keywords that drive the web settings UI and the env-var
fallback resolver:

| Keyword    | Effect                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x-widget` | Selects the input control (`text`, `password`, `select`, `model-picker`, `toggle`, `multiline`, ...). The settings UI in `apps/web` renders the right component without the plugin shipping its own React code.    |
| `x-secret` | Marks the value as a secret — it is stored in the encrypted `PluginEntity.secretSettings` column, never logged, and never sent to the browser after the first round-trip.                                          |
| `x-envVar` | Names an environment variable the resolver should fall back to when the operator hasn't set the field in the UI. Lets a self-hosted operator wire `OPENAI_API_KEY` once and have every Work pick it up implicitly. |

The resolved settings hierarchy is **`work plugin row → user plugin row →
system plugin row → x-envVar fallback → schema default`** — facades call
`getResolvedSettings(scope, scopeId)` and get a single flat object back
with secrets decrypted in memory.

### 5. The plugin-categories registry

Plugins are bucketed by their `category` field. Active categories on
`develop` (see `PLUGIN_CATEGORIES` in `@ever-works/plugin`):

| Category            | What it does                                                              | Default plugin            |
| ------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `ai-provider`       | Chat / embeddings / transcription via LangChain                           | resolved per scope        |
| `search`            | Web search (Tavily, Brave, Exa, SerpAPI, Perplexity, Jina, Linkup, ...)   | `tavily`                  |
| `content-extractor` | URL → markdown (local HTML, Notion, PDF, Scrapfly, ...)                   | `local-content-extractor` |
| `screenshot`        | Page → image (ScreenshotOne, URLBox, Scrapfly)                            | `screenshotone`           |
| `git-provider`      | Clone / commit / push / OAuth (GitHub)                                    | `github`                  |
| `deployment`        | Deploy a generated site (Vercel)                                          | `vercel`                  |
| `pipeline`          | The 15-step standard pipeline plus alt agent pipelines (Claude, Codex...) | `standard-pipeline`       |
| `prompt-provider`   | Versioned prompt registry (Langfuse)                                      | `langfuse`                |
| `utility`           | Cross-cutting helpers (comparison-generator, ...)                         | n/a                       |
| `storage`           | Object storage backend (local-fs, S3, MinIO, github-storage)              | `local-fs` (EW-637)       |

Each capability has a sibling [facade](../architecture/facade-pattern.md)
service that wraps registry lookups + settings resolution + observability
so the rest of the codebase never speaks to plugins directly.

## How `AiFacadeService` selects a provider

The AI facade resolves the right provider for every call in three
deterministic steps. Other facades follow the same shape; AI is the
canonical example because it's used most.

1. **Operator pin** — environment variables let the operator nail a
   provider for a specific job. The KB transcription pipeline, for
   example, honours `KB_TRANSCRIPTION_PROVIDER_ID` (and falls back to
   the activity-log `TranscriptionNotConfiguredError` if no provider
   advertises the `transcribe` capability). This wins outright when set.
2. **Scope-active plugin** — if no operator pin applies, the facade
   asks the registry which plugin the caller's scope has marked
   `active` for the capability. For AI the resolution order is
   `work plugin row → user plugin row → system plugin row`, mirroring
   the settings hierarchy.
3. **Registry iteration** — finally, the facade falls back to
   `registry.getDefaultForCapability(capability)` (the plugin whose
   manifest sets `defaultForCapabilities`) and then to
   `registry.getByCapability(capability)[0]` — the first enabled plugin
   for the capability.

Once a plugin is chosen the facade calls
`getResolvedSettings(scope, scopeId)`, runs the plugin call, and emits a
`plugin-usage-event` row so cost, latency, and reasoning metadata flow
to the budget guard and PostHog without the plugin having to opt in.

## Authoring a new plugin

A new plugin is a standalone package under `packages/plugins/<id>`. The
checklist:

### 1. Scaffold the package

```
packages/plugins/my-plugin/
├── package.json          # name, version, everworks.plugin manifest
├── tsup.config.ts        # ESM build to ./dist
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts          # `export { MyPlugin as default } from './my-plugin'`
    ├── my-plugin.ts      # the class
    ├── settings.schema.ts
    └── __tests__/my-plugin.spec.ts
```

### 2. The `everworks.plugin` manifest

The block in `package.json` is read at discovery time:

```jsonc
"everworks": {
  "plugin": {
    "id": "my-plugin",
    "name": "My Plugin",
    "category": "search",
    "capabilities": ["search"],
    "configurationMode": "user-required",
    "autoEnable": false,
    "icon": { "kind": "lucide", "name": "search" }
  }
}
```

### 3. The class

```typescript
import { BasePlugin } from '@ever-works/plugin/abstract';
import type { ISearchPlugin, SearchOptions, SearchResponse } from '@ever-works/plugin';
import { settingsSchema } from './settings.schema.js';

export class MyPlugin extends BasePlugin implements ISearchPlugin {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly category = 'search' as const;
	readonly capabilities = ['search'] as const;
	readonly settingsSchema = settingsSchema;
	readonly providerName = 'my-plugin';

	async search(options: SearchOptions): Promise<SearchResponse> {
		const settings = await this.context.getResolvedSettings();
		const apiKey = settings['apiKey'] as string;
		const res = await this.context.http.post(
			'https://api.example.com/search',
			{
				query: options.query,
				limit: options.limit
			},
			{ headers: { Authorization: `Bearer ${apiKey}` } }
		);
		return { results: res.data.items, source: this.providerName };
	}

	async isAvailable(): Promise<boolean> {
		const settings = await this.context.getResolvedSettings();
		return Boolean(settings['apiKey']);
	}
}
```

### 4. The settings schema

```typescript
export const settingsSchema = {
	type: 'object',
	properties: {
		apiKey: {
			type: 'string',
			title: 'API Key',
			'x-widget': 'password',
			'x-secret': true,
			'x-envVar': 'MY_PLUGIN_API_KEY'
		},
		defaultLimit: {
			type: 'integer',
			default: 10,
			minimum: 1,
			maximum: 50,
			'x-widget': 'number'
		}
	},
	required: ['apiKey']
} as const;
```

### 5. Build & test

`tsup` produces ESM under `./dist`; Vitest tests live alongside the
source. The shared
[`@ever-works/plugin/testing`](../packages/plugin-testing-framework.md)
package provides a `createMockPluginContext()` helper so your tests
don't have to know about NestJS:

```bash
pnpm --filter @ever-works/my-plugin build
pnpm --filter @ever-works/my-plugin test
```

### 6. Publish or bundle

For platform-shipped plugins, add the new package to the workspace and
let Turborepo build it as part of `pnpm build:plugins`. For
third-party plugins, publish to NPM under your own scope and install
into `./plugins` or `./node_modules/@your-scope` at the deployment
target — the discovery paths pick it up automatically.

## Dual-mode distribution (bundled vs dynamic)

Plugins ship in **two distinct modes** today, and a third is on the way
under [EW-693 Dynamic Plugin Distribution](../specs/features/dynamic-plugin-distribution/spec.md):

- **Bundled** — `packages/plugins/*` are workspace packages built by
  Turborepo and pre-installed on every API process. The discovery path
  `./packages/plugins` finds them at boot. This is the path used for
  the 39+ official plugins.
- **Dynamic (filesystem)** — operators can drop additional plugin
  packages into `./plugins` or install them into
  `./node_modules/@ever-works` and the same discovery loop picks them
  up at the next restart. No code changes; nothing recompiled.
- **Dynamic (EW-693)** — a forthcoming distribution channel where
  plugins are pulled from a registry (npm or an Ever Works
  marketplace), staged into a per-tenant cache directory, validated,
  and hot-loaded without an API restart. The contract surface stays
  identical — only the loader changes. See
  [`docs/specs/features/dynamic-plugin-distribution/spec.md`](../specs/features/dynamic-plugin-distribution/spec.md)
  and
  [`docs/specs/architecture/runtime-plugins.md`](../specs/architecture/runtime-plugins.md)
  for the full design.

The important invariant is that the plugin you write today against
`BasePlugin` keeps running unmodified under all three modes.

## Storage plugins, in detail

Storage plugins are the contract every binary upload (KB sources,
generated assets, originals) flows through. The interface
`IStoragePlugin` from `@ever-works/plugin/contracts/capabilities` is
backed by `local-fs` (default), `aws-s3`, `minio`, and
`github-storage`.

The shape:

```typescript
export interface IStoragePlugin extends IPlugin {
	readonly providerName: string;

	putObject(input: StoragePutInput): Promise<StoragePutResult>;
	getObject(key: string): Promise<StorageGetResult>;
	deleteObject(key: string): Promise<void>;

	// Optional capabilities
	presignPut?(input: StoragePresignInput): Promise<StoragePresignResult>;
	deriveKey?(ownerId: string, filename: string, workId?: string): string;
	deleteAllByOwner?(ownerId: string): Promise<{ deleted: number }>;

	isAvailable(): Promise<boolean>;
}
```

Required capabilities are declared in the manifest:

- `put-object` (required)
- `get-object` (required)
- `presigned-put` (optional — only S3 / MinIO advertise it; the web
  uploader fast-paths direct-to-cloud when this is present)

### How the KB uses storage plugins

The Knowledge Base is the heaviest consumer:

1. The workbench (or `kb upload` CLI command, or `POST
/api/works/:id/kb/uploads`) hands the file to the API uploads
   service.
2. The uploads service magic-byte-sniffs the MIME and calls
   `StorageFacade.putObject({ buffer, filename, mimeType, size, ownerId, workId })`.
3. The facade resolves the active storage plugin via
   `STORAGE_BACKEND` (operator pin) → registry default and writes the
   **original** verbatim. The plugin returns `{ key, url }`.
4. A `WorkKnowledgeUpload` row is inserted with that key. The
   downstream pipeline (content-extractor + media-normalize +
   transcribe) reads the buffer via `getObject(key)` and produces the
   agent-readable extract.
5. When a Work is exported or a user account is GC'd,
   `deleteAllByOwner(ownerId)` (optional) reclaims storage in bulk; the
   anonymous-user-cleanup task uses this exact path.

`github-storage` is the only backend that's per-Work aware — it uses
the `workId` argument to resolve the Work's data repo coordinates so
KB sources can be committed straight into the same git history as the
agent-readable extracts. Every other backend ignores `workId` and
writes into a global bucket / directory.

## See also

- [Plugin System overview](../plugin-system/index.md) — index of all plugin pages
- [Plugin Architecture](../plugin-system/architecture.md) — IPlugin / lifecycle deep dive
- [Settings](../plugin-system/settings.md) — JSON Schema + scopes + `x-` keywords
- [Creating a Plugin](../plugin-system/creating-a-plugin.md) — step-by-step
- [Facade Pattern](./facade-pattern.md) — registry → facade → caller
- [Knowledge Base User Guide](../kb/user-guide.md) — what storage plugins back
- [Dynamic Plugin Distribution (EW-693)](../specs/features/dynamic-plugin-distribution/spec.md)
