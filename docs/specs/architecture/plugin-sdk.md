# Architecture: Plugin SDK (`@ever-works/plugin`)

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers writing or maintaining Ever Works plugins.

---

## 1. Purpose

`@ever-works/plugin` is the standalone TypeScript SDK that every Ever Works
plugin builds against. It is **NestJS-free**, **runtime-free**, and **MIT
licensed** — plugins are ESM packages that ship `dist/` with a `package.json`
declaring an `everworks.plugin` block.

The SDK gives plugins three things:

1. **Contracts** — interfaces every capability MUST satisfy.
2. **Base classes** — abstract implementations that handle plumbing
   (`BasePlugin`, `BaseAiProvider`, `BaseGitProvider`, `BasePipelineStep`).
3. **Helpers** — JSON Schema utilities, AI operations wrapping LangChain,
   and a typed plugin context.

Everything else (registry, settings store, lifecycle hooks, persistence) is
the platform's concern. Plugins know nothing about how they're loaded or
where their settings live — they ask for context, declare capabilities,
and implement contracts.

## 2. Package Layout

```
packages/plugin/src/
├── index.ts                         # Re-exports the public surface
├── abstract/                        # Base classes
│   ├── base-plugin.ts               # Implements lifecycle scaffolding
│   ├── base-ai-provider.ts          # AI provider with LangChain glue
│   ├── base-git-provider.ts         # Git provider scaffold
│   └── base-pipeline-step.ts        # Step scaffold for pipeline plugins
├── contracts/                       # Interfaces & types
│   ├── plugin.interface.ts          # IPlugin
│   ├── plugin-context.interface.ts  # PluginContext (logger, cache, http, events)
│   ├── plugin-manifest.types.ts     # PLUGIN_CATEGORIES + manifest shape
│   ├── plugin-environment.interface.ts
│   ├── lifecycle.types.ts           # PluginHealthCheck, lifecycle hooks
│   ├── facade-capabilities.ts       # Capability tokens platform exposes
│   ├── provider-categories.ts
│   ├── provider-selection.ts
│   └── capabilities/                # 13 capability interfaces
│       ├── ai-provider.interface.ts
│       ├── content-extractor.interface.ts
│       ├── data-source.interface.ts
│       ├── deployment.interface.ts
│       ├── device-auth-provider.interface.ts
│       ├── form-schema-provider.interface.ts
│       ├── git-provider.interface.ts
│       ├── oauth.interface.ts
│       ├── pipeline-modifier.interface.ts
│       ├── pipeline-plugin.interface.ts
│       ├── prompt-provider.interface.ts
│       ├── screenshot.interface.ts
│       └── search.interface.ts
├── settings/                        # Settings primitives
│   ├── settings.types.ts            # ConfigurationMode, scope, definitions
│   ├── json-schema.types.ts         # JSONSchema7 + Ever Works extensions
│   └── validation.types.ts          # ValidationResult shape
├── ai/                              # AiOperations wrapping LangChain
├── pipeline/                        # Pipeline executor primitives
├── facades/                         # Facade interfaces (not implementations)
├── git/                             # Git-specific helpers
├── events/                          # Event emitters and types
├── helpers/                         # Generic utilities
├── keywords/                        # AI keyword extraction helpers
├── cli-pipeline/                    # CLI generator scaffolding
├── common/                          # Common types
└── testing/                         # Test fixtures consumed by plugin packages
```

The package exposes a flat root entry plus a handful of subpath exports
(`/contracts`, `/pipeline`, `/events`, `/abstract`, `/ai`, `/git`,
`/git-provider`, `/keywords`, `/testing`). Plugins import from whichever
subpath matches their capability, keeping bundles small.

## 3. The `IPlugin` Contract

Every plugin's `dist/index.js` must export an instance (or factory)
implementing `IPlugin`:

```ts
export interface IPlugin {
	readonly id: string; // Unique plugin identifier
	readonly name: string; // Display name
	readonly version: string; // semver
	readonly category: PluginCategory; // One of 12 categories
	readonly capabilities: readonly string[]; // Capability ids declared
	readonly settingsSchema: JsonSchema; // JSON Schema (Draft 7) + x-* exts
	readonly configurationMode: ConfigurationMode; // admin-only / user-required / hybrid
	readonly autoEnable?: boolean; // System plugins flip this true
	readonly defaultFor?: string; // Capability id this plugin defaults

	// Lifecycle
	onInit?(ctx: PluginContext): Promise<void>;
	onEnable?(ctx: PluginContext): Promise<void>;
	onDisable?(ctx: PluginContext): Promise<void>;
	onSettingsUpdated?(ctx: PluginContext, settings: PluginSettings): Promise<void>;
	healthCheck?(ctx: PluginContext): Promise<PluginHealthCheck>;

	// Capability methods are mixed in via TypeScript declaration merging
	// when the plugin implements one of the capability interfaces.
}
```

The `everworks.plugin` block in `package.json` mirrors the static fields
(id, name, category, capabilities, version, description, author, icon,
visibility) so the registry can list plugins **without instantiating them**
— important for the dashboard plugins page that shows uninstalled options.

## 4. Plugin Categories (12)

```ts
export const PLUGIN_CATEGORIES = [
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
	'theme'
] as const;
```

A plugin declares **one** category but can advertise **multiple
capabilities**. For example, the Tavily plugin's category is `search`,
but it advertises both `search` and `content-extractor` capabilities, so
the platform can route either kind of request to it.

## 5. Capability Interfaces (13)

Each capability is a typed contract defined in
`contracts/capabilities/<name>.interface.ts`. Plugins implement only the
capabilities they need; capabilities are routed by the corresponding
**facade** on the platform side.

| Capability             | Interface                   | Facade                          | Used by                                 |
| ---------------------- | --------------------------- | ------------------------------- | --------------------------------------- |
| `ai-provider`          | `IAiProviderPlugin`         | `AiFacadeService`               | All generation, chat, structured output |
| `search`               | `ISearchPlugin`             | `SearchFacadeService`           | Pipeline web search                     |
| `content-extractor`    | `IContentExtractorPlugin`   | `ContentExtractorFacadeService` | Pipeline URL fetch + clean              |
| `screenshot`           | `IScreenshotPlugin`         | `ScreenshotFacadeService`       | Item screenshot capture                 |
| `git-provider`         | `IGitProviderPlugin`        | `GitFacadeService`              | Every git operation                     |
| `deployment`           | `IDeploymentPlugin`         | `DeployFacadeService`           | Website deploys, custom domains         |
| `data-source`          | `IDataSourcePlugin`         | `DataSourceFacadeService`       | External data imports                   |
| `oauth`                | `IOAuthPlugin`              | `OAuthFacadeService`            | OAuth login flows                       |
| `device-auth-provider` | `IDeviceAuthProviderPlugin` | `OAuthFacadeService`            | OAuth device flow (CLI)                 |
| `pipeline`             | `IPipelinePlugin`           | (orchestrator)                  | Whole-pipeline plugins                  |
| `pipeline-modifier`    | `IPipelineModifierPlugin`   | (orchestrator)                  | Inject steps into existing pipelines    |
| `form-schema-provider` | `IFormSchemaProviderPlugin` | (web form)                      | Pipeline-specific form fields           |
| `prompt-provider`      | `IPromptProviderPlugin`     | `PromptFacadeService`           | External prompt management (Langfuse)   |

The facade is the platform-side mirror: it holds an `IFacade` interface
in the SDK (so plugins can compose facades when they need to call other
plugins) and a NestJS `*FacadeService` implementation in
`packages/agent/src/facades/`.

## 6. Base Classes

### 6.1 `BasePlugin`

`BasePlugin` implements the `IPlugin` lifecycle scaffold:

- Stores the `PluginContext` from `onInit`.
- Provides a `protected get logger()` shortcut.
- Adds default no-op `onEnable` / `onDisable` / `onSettingsUpdated`
  handlers that subclasses can override.
- Provides `protected resolveSetting<T>(key: string)` that reads the
  current effective setting value (cascade resolved by the platform)
  via the context's settings accessor.

### 6.2 `BaseAiProvider`

Extends `BasePlugin` and adds:

- An `AiOperations` instance that wraps LangChain models for completion,
  streaming, structured output (`askJson`), and embeddings.
- `selectModelForTask(complexity: TaskComplexity, opts?: AiRoutingOptions)`
  that picks a model alias (`simple` / `medium` / `complex`) from the
  provider's settings.
- A typed `getProviderConfig()` returning the resolved
  `AiProviderConfig` (apiKey, baseUrl, model tiers).
- Default `validateConnection()` that pings each configured tier and
  returns per-tier `ModelValidationResult` objects.

### 6.3 `BaseGitProvider`

Adds Octokit-style helpers and isomorphic-git glue. The GitHub plugin is
the canonical implementation.

### 6.4 `BasePipelineStep`

Used by Standard Pipeline step plugins. Provides `name`, `description`,
typed `run(input, ctx)` method, and helpers for attaching results to the
pipeline context.

## 7. Plugin Manifest

The `everworks.plugin` block in a plugin's `package.json`:

```json
{
	"everworks": {
		"plugin": {
			"id": "openai",
			"name": "OpenAI",
			"version": "1.0.0",
			"category": "ai-provider",
			"capabilities": ["ai-provider"],
			"description": "Use OpenAI models for content generation",
			"icon": { "type": "svg", "value": "<svg>...</svg>" },
			"visibility": "public",
			"configurationMode": "user-required",
			"defaultFor": null,
			"autoEnable": false,
			"author": { "name": "Ever Works Team" },
			"license": "MIT"
		}
	}
}
```

`visibility` controls UI exposure:

- `public` — shown to all users (default).
- `hidden` — never shown in the plugin UI (internal infrastructure).
- `user-only` — shown in the user plugins list, hidden from per-work
  plugin pickers.

`configurationMode` decides who provides settings:

- `admin-only` — only admins configure (system infrastructure plugins).
- `user-required` — users must provide their own credentials.
- `hybrid` — admin provides defaults, users may override.

## 8. Settings — JSON Schema with `x-*` Extensions

Plugin settings are defined as JSON Schema Draft 7, extended with Ever
Works `x-*` keywords:

| Extension          | Effect                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `x-widget`         | UI hint (`password`, `textarea`, `select`, etc.). The Web Dashboard renders the matching widget.   |
| `x-secret`         | Value is encrypted at rest, never returned by APIs, masked in logs/exports.                        |
| `x-envVar`         | Environment variable fallback when the setting isn't provided in the DB.                           |
| `x-scope`          | Setting scope: `global` / `user` / `work`.                                                         |
| `x-adminOnly`      | Field is hidden from regular users (used inside `hybrid` plugins).                                 |
| `x-hidden`         | Field is hidden from the settings UI entirely (used for derived state).                            |
| `x-showIf`         | Conditional rendering: `{ field, value }` reveals this field only when another matches a value.    |
| `x-requiredGroups` | "At least one of these groups must be filled" — for plugins that accept multiple credential modes. |

Example slice from the OpenAI plugin:

```ts
const settingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		apiKey: {
			type: 'string',
			title: 'API Key',
			'x-secret': true,
			'x-envVar': 'PLUGIN_OPENAI_API_KEY',
			'x-widget': 'password'
		},
		defaultModel: {
			type: 'string',
			default: 'gpt-5.1',
			'x-widget': 'select'
		}
	},
	required: ['apiKey']
};
```

The settings store enforces `x-secret` redaction at every transport
boundary (export, sync, MCP responses) — this is the canonical
implementation site for [Constitution Principle VII](/specs/) (secret
hygiene). See [Settings System spec](./settings-system.md) for the
three-tier resolution model.

## 9. Plugin Context

`PluginContext` is the runtime gift the platform hands to every plugin
on `onInit`:

```ts
interface PluginContext {
	readonly logger: Logger;
	readonly cache: ICache; // get/set/del with TTL
	readonly http: IHttpClient; // pre-configured fetch with retries
	readonly events: IEventEmitter; // emit + subscribe to pipeline events
	readonly settings: ISettingsAccessor; // resolve current effective settings
	readonly env: PluginEnvironment; // read-only env-var window
	readonly workId?: string; // present in work-scoped invocations
	readonly userId?: string; // present in user-scoped invocations
}
```

Plugins **never** read `process.env` directly; they always go through
`ctx.env` (which the platform restricts to `PLUGIN_<plugin-id>_*` and a
small allowlist) so secrets and env handling stay auditable.

## 10. Lifecycle

The platform calls a plugin's lifecycle hooks in this order:

1. **Discovery** — registry reads `package.json` `everworks.plugin` for
   every package matching the workspace glob `packages/plugins/*`.
2. **`onInit(ctx)`** — once at process start (or the first time the
   plugin is touched). Plugin caches the context.
3. **`onEnable(ctx)`** — when an admin/user enables the plugin (or
   `autoEnable` is true at startup). Plugins make connectivity checks
   here.
4. **Capability calls** — facades route per-request capability calls.
5. **`onSettingsUpdated(ctx, settings)`** — when settings change for a
   scope the plugin cares about. Plugins re-read settings here rather
   than caching them.
6. **`onDisable(ctx)`** — when the plugin is disabled. Plugins clean up
   resources.
7. **`healthCheck(ctx)`** — called by the dashboard to render plugin
   status; returns `PluginHealthCheck`.

The platform never re-instantiates a plugin in-process. If a plugin's
package version changes, the worker restarts.

## 11. Provider Selection

For capability resolution, the platform follows this cascade:

1. **Per-call override** — caller passes a specific plugin id.
2. **Work-scoped binding** — `work_plugins` row picks a plugin
   for the capability for this work.
3. **User-scoped binding** — `user_plugins` row picks a plugin for the
   user (used outside any work context).
4. **`defaultFor` registration** — plugin manifest declares
   `defaultFor: 'search'` and `autoEnable: true`. The first such plugin
   found wins.

The cascade is implemented in `provider-selection.ts` and consumed by
every facade. See [AI Facade architecture](./ai-facade.md) for the
canonical implementation.

## 12. Testing Plugins

`@ever-works/plugin/testing` exports:

- `mockPluginContext()` — produces a `PluginContext` whose `cache`,
  `http`, and `events` are in-memory.
- `expectCapability()` — asserts a plugin advertises a capability.
- `validateSettingsSchema()` — runs the JSON Schema through Ajv to catch
  malformed schemas at test time.
- Per-capability fixtures (e.g. `MockSearchResult`, `MockExtraction`).

Each plugin uses **Vitest**. The shared template under
`@ever-works/plugin/testing` is intentionally tiny — keeps plugin
packages independent of NestJS test plumbing.

## 13. Build & Distribution

Every plugin builds with **tsup**:

- Output: ESM `index.js` + CJS `index.cjs` + `index.d.ts`.
- Side-effects-free unless explicitly declared.
- No bundling of `@ever-works/plugin` (peer dep).
- Tree-shakeable subpath imports.

The platform consumes the built `dist/` at runtime via pnpm workspace
links. CI builds every plugin with strict tsconfig — drift from
`@ever-works/plugin` interfaces fails fast.

## 14. Constitution Reconciliation

| Principle                   | How the SDK respects it                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| I — Plugin-first            | The SDK IS the contract that makes Principle I possible.                                     |
| II — Capability-driven      | Every external integration goes through one of the 13 capability interfaces.                 |
| III — Source-of-truth repos | Plugins call `GitFacadeService` (via `IGitFacade`) — never raw Octokit/isomorphic-git.       |
| IV — Trigger.dev            | Plugins are pure libraries; long-running work runs in Trigger.dev tasks that _use_ plugins.  |
| V — Forward-only migrations | SDK has no DB. Settings schema is forward-only via JSON Schema additions.                    |
| VI — Tests                  | `@ever-works/plugin/testing` provides the fixtures; every plugin ships its own Vitest suite. |
| VII — Secret hygiene        | `x-secret` is the canonical marker. Settings store + facades + export/import all consult it. |
| VIII — Plugin counts        | The platform reads counts from the registry, not the SDK.                                    |
| IX — Behaviour-first        | Capability interfaces describe behaviour; base classes provide implementations.              |
| X — Backwards-compat        | The SDK is semver-versioned; major breaks require a SDK major bump and migration notes.      |

## 15. References

- Source: `packages/plugin/src/`
- User-facing plugin docs: [`docs/plugin-system/`](../../plugin-system/)
- Per-feature retrospective specs that build on this:
    - [`features/plugin-system/spec`](../features/plugin-system/spec.md)
    - [`features/git-operations/spec`](../features/git-operations/spec.md)
- Related architecture specs:
    - [`settings-system`](./settings-system.md)
    - [`ai-facade`](./ai-facade.md)
    - [`pipeline-overview`](./pipeline-overview.md)
- Constitution: [`.specify/memory/constitution.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
