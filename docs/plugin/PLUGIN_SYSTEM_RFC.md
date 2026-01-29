# Ever Works Plugin System - Technical RFC

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Design Principles](#design-principles)
4. [Package Structure](#package-structure)
5. [Plugin Discovery & Eligibility](#plugin-discovery--eligibility)
6. [Plugin Manifest Schema](#plugin-manifest-schema)
7. [Plugin Lifecycle](#plugin-lifecycle)
8. [Plugin Context](#plugin-context)
9. [Core Capabilities](#core-capabilities)
10. [Custom Capabilities (Hybrid System)](#custom-capabilities-hybrid-system)
11. [Current Pipeline Integration](#current-pipeline-integration)
12. [New Pipeline Architecture](#new-pipeline-architecture)
13. [Generator Form Architecture](#generator-form-architecture)
14. [Settings Resolution](#settings-resolution)
15. [User Configuration Flow](#user-configuration-flow)
16. [Event System](#event-system)
17. [Error Handling & Boundaries](#error-handling--boundaries)
18. [API Endpoints](#api-endpoints)
19. [Database Schema](#database-schema)
20. [Built-in Plugins](#built-in-plugins)
21. [Creating a Plugin](#creating-a-plugin)
22. [Plugin Testing](#plugin-testing)
23. [Security Considerations](#security-considerations)
24. [Migration Strategy](#migration-strategy)
25. [Migration from Hardcoded Infrastructure](#migration-from-hardcoded-infrastructure)
26. [Key Principles](#key-principles)

---

## Executive Summary

This document describes the Ever Works Plugin System - a modular architecture that transforms the platform from a tightly-coupled, hardcoded system into a fully extensible, plugin-based platform.

### Goals

- **Extensibility**: Allow third-party plugins for git providers, deployment targets, AI providers, etc.
- **User Control**: Users configure plugins through UI, not server environment variables
- **Type Safety**: Full TypeScript support with compile-time interface checking
- **Backwards Compatibility**: Existing functionality works during incremental migration

### Current State (Before)

Everything is hardcoded:

- GitHub for git operations
- Vercel for deployment
- ScreenshotOne for screenshots
- Fixed 13-step pipeline

### Target State (After)

Everything is plugin-based:

- Any git provider (GitHub, GitLab, Bitbucket)
- Any deployment target (Vercel, Netlify, Railway)
- Any screenshot service (ScreenshotOne, Playwright, Browserless)
- Extensible pipeline with custom steps or full replacements

---

## Design Principles

### Plugins are Standalone Packages (NOT NestJS)

**Critical Principle:** Plugins are **standalone JavaScript/TypeScript packages**. They do NOT depend on NestJS and are NOT NestJS modules.

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLUGIN INDEPENDENCE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ❌ WRONG: Plugin as NestJS Module                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ @Module({ providers: [...], imports: [...] })           │   │
│  │ class MyPlugin { ... }                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ✅ CORRECT: Plugin as Standalone Package                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ class MyPlugin implements IPlugin {                     │   │
│  │     // Pure TypeScript, no NestJS decorators            │   │
│  │     // Dependencies via PluginContext                   │   │
│  │ }                                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Why standalone?**

- **Portability:** Plugins can be used outside NestJS (CLI, workers, etc.)
- **Lighter dependencies:** Plugin authors don't need NestJS knowledge
- **Simpler testing:** Plain unit tests without NestJS TestingModule
- **Future-proof:** If Ever Works moves away from NestJS, plugins still work

**Plugin dependencies:**

```json
{
	"peerDependencies": {
		"@ever-works/plugin": "^1.0.0"
	},
	"dependencies": {
		// Only plugin-specific deps (e.g., "screenshotone-api-sdk")
		// NO NestJS packages!
	}
}
```

### Plugin Context Provides Everything

Instead of NestJS dependency injection, plugins receive a `PluginContext` object:

```typescript
// NestJS way (NOT for plugins)
@Injectable()
class MyService {
	constructor(
		private readonly db: DataSource,
		private readonly cache: CacheManager
	) {}
}

// Plugin way (CORRECT)
class MyPlugin implements IPlugin {
	private context: PluginContext;

	async onLoad(context: PluginContext) {
		this.context = context;
		// Access services via context
		const settings = await context.getSettings();
		const repo = context.getRepository(MyEntity);
	}
}
```

### Type Safety is Non-Negotiable

**Critical Principle:** The plugin system MUST be strongly typed. All interfaces, data flow, and plugin interactions are validated at **compile time**, not runtime.

```
┌─────────────────────────────────────────────────────────────────┐
│                    TYPE SAFETY REQUIREMENTS                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ❌ WRONG: Loose typing with strings                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ dependencies: string[];           // Any typo accepted   │    │
│  │ context.get('extrcted-items');    // Silent undefined   │    │
│  │ provides: ['my-data'];            // No type for data   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ✅ CORRECT: Strong typing with union types and generics        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ dependencies: StepId[];           // Only valid IDs     │    │
│  │ context.get<K>('extracted-items'); // Typed result     │    │
│  │ provides: StepDataKey[];          // Mapped to types   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Type safety applies to:**

| Component             | Type Safety Mechanism                            |
| --------------------- | ------------------------------------------------ |
| Step IDs              | `BuiltInStepId` union type                       |
| Data Keys             | `StepDataKey` union type                         |
| Step Results          | `StepDataTypes` mapped interface                 |
| Plugin Settings       | `JsonSchema` with TypeScript inference           |
| Context Access        | Generic `getStepResult<K extends StepDataKey>()` |
| Capability Interfaces | Strict interface contracts                       |

**Benefits:**

1. **Compile-time error detection** - Typos caught immediately
2. **IDE autocomplete** - Full IntelliSense for all keys and types
3. **Refactoring safety** - Rename a step ID, all references update
4. **Self-documenting** - Types serve as documentation

```typescript
// Example: Type-safe step definition
import { BuiltInStepId, StepDataKey, StepDataTypes } from './step-types';

interface TypedPipelineStepDefinition {
	id: BuiltInStepId | `${string}:${string}`;
	dependencies: (BuiltInStepId | StepDataKey)[];
	provides: StepDataKey[];
}

// Type-safe context access
interface GenerationContext {
	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined;
	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void;
}

// Usage - compiler validates everything
const items = context.getStepResult('extracted-items'); // ✅ Type: ExtractedItem[]
const bad = context.getStepResult('extrcted-items'); // ❌ Compile error!
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           EVER WORKS PLATFORM                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │
│  │   apps/api/     │    │   apps/web/     │    │   apps/cli/     │     │
│  │   (NestJS)      │    │   (Next.js)     │    │   (Commander)   │     │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘     │
│           │                      │                      │               │
│           └──────────────────────┼──────────────────────┘               │
│                                  │                                      │
│                                  ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                      packages/agent/                               │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │ │
│  │  │   Facades   │  │   Plugins   │  │  Pipeline   │                │ │
│  │  │ git.facade  │  │  Registry   │  │   Factory   │                │ │
│  │  │deploy.facade│  │   Loader    │  │   Executor  │                │ │
│  │  │ ai.facade   │  │  Lifecycle  │  │    Steps    │                │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                  │                                      │
│                                  ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                   packages/plugin/                       │ │
│  │  IPlugin, IGitProviderPlugin, IDeploymentPlugin, IScreenshotPlugin │ │
│  │  IAiProviderPlugin, IPipelineStepPlugin, ICustomCapabilityRegistry │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                  │                                      │
│                                  ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                      packages/plugins/                             │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐     │ │
│  │  │ github  │ │ vercel  │ │screenshot│ │ openai  │ │  exa    │     │ │
│  │  │         │ │         │ │   one   │ │         │ │         │     │ │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Package Structure

```
packages/
├── plugin/            # Plugin interfaces & types (light package)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── plugin.interface.ts
│       ├── plugin-context.interface.ts
│       ├── capabilities/
│       │   ├── git-provider.interface.ts
│       │   ├── deployment.interface.ts
│       │   ├── screenshot.interface.ts
│       │   ├── search.interface.ts
│       │   ├── ai-provider.interface.ts
│       │   ├── pipeline-step.interface.ts
│       │   ├── full-pipeline.interface.ts
│       │   ├── form-field.interface.ts
│       │   ├── oauth.interface.ts           # OAuth authentication (NOT app auth)
│       │   └── custom-capability.interface.ts
│       └── types/
│           ├── settings.types.ts
│           ├── pipeline.types.ts
│           └── common.types.ts
│
├── agent/                       # Core runtime (uses plugin)
│   ├── package.json
│   └── src/
│       ├── plugins/
│       │   ├── plugin-registry.service.ts
│       │   ├── plugin-loader.service.ts
│       │   ├── plugin-lifecycle.service.ts
│       │   ├── plugin-settings.service.ts
│       │   ├── plugin-context.factory.ts
│       │   ├── custom-capability-registry.service.ts
│       │   ├── entities/
│       │   │   ├── plugin.entity.ts
│       │   │   ├── user-plugin.entity.ts
│       │   │   └── directory-plugin.entity.ts
│       │   └── plugins.module.ts
│       ├── facades/                 # Design docs: docs/plugin/designs/
│       │   ├── git.facade.ts        # Design ready, impl pending Story 2
│       │   ├── deploy.facade.ts
│       │   ├── screenshot.facade.ts
│       │   ├── search.facade.ts
│       │   └── ai.facade.ts
│       └── pipeline/
│           ├── pipeline-factory.service.ts
│           ├── step-executor.service.ts
│           └── full-pipeline-executor.service.ts
│
└── plugins/                     # Built-in plugins (each is full package)
    ├── github/
    │   ├── package.json
    │   └── src/
    │       ├── index.ts
    │       ├── github.plugin.ts
    │       └── github.service.ts
    ├── vercel/
    ├── screenshotone/
    ├── openai/
    └── ...
```

---

## Plugin Discovery & Eligibility

### What Makes a Plugin Loadable?

A folder is recognized as a valid plugin when it meets ALL of these criteria:

| Requirement                  | Check                               | Required    |
| ---------------------------- | ----------------------------------- | ----------- |
| Has `package.json`           | File exists                         | ✅ Yes      |
| Has `everworks.plugin` field | Field in package.json               | ✅ Yes      |
| Has required metadata        | `id`, `name`, `version`, `category` | ✅ Yes      |
| Has entry point              | `main` field points to valid JS     | ✅ Yes      |
| Exports plugin class         | Default export implements `IPlugin` | ✅ Yes      |
| Version compatible           | `minContractsVersion` check         | ⚠️ Optional |

### Discovery Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLUGIN DISCOVERY FLOW                        │
└─────────────────────────────────────────────────────────────────┘

PluginsModule.forRoot({ paths: ['packages/plugins/*'] })
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. SCAN PATHS                           │
│    Read all directories in paths        │
│    e.g., packages/plugins/github/       │
│          packages/plugins/vercel/       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 2. CHECK package.json                   │
│    Does folder have package.json?       │
│    ├─→ No  → Skip folder               │
│    └─→ Yes → Continue                  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 3. CHECK everworks.plugin FIELD         │
│    Is "everworks.plugin" present?       │
│    ├─→ No  → Skip (not a plugin)       │
│    └─→ Yes → Continue                  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 4. VALIDATE MANIFEST                    │
│    Required: id, name, version, category│
│    ├─→ Missing → Log warning, skip     │
│    └─→ Valid   → Continue              │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 5. CHECK VERSION COMPATIBILITY          │
│    Is minContractsVersion satisfied?    │
│    ├─→ No  → Log warning, skip         │
│    └─→ Yes → Continue                  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 6. LOAD ENTRY POINT                     │
│    require(package.main)                │
│    ├─→ Error → Log error, skip         │
│    └─→ OK    → Continue                │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 7. VALIDATE PLUGIN CLASS                │
│    Does default export implement IPlugin│
│    Has required lifecycle methods?      │
│    ├─→ No  → Log error, skip           │
│    └─→ Yes → Continue                  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 8. REGISTER PLUGIN                      │
│    Add to PluginRegistry                │
│    Call plugin.onLoad(context)          │
│    ✅ Plugin ready for use              │
└─────────────────────────────────────────┘
```

### Environment-Specific Plugin Paths

Plugin paths must be configured differently for development and production (Docker) environments:

```typescript
// apps/api/src/app.module.ts
import { PluginsModule } from '@packages/agent/plugins';
import * as path from 'path';

@Module({
	imports: [
		PluginsModule.forRoot({
			pluginPaths: [
				// In dev: resolve to monorepo packages/plugins
				path.resolve(__dirname, '../../../packages/plugins'),
				// In prod (Docker): ./plugins relative to /app
				'./plugins'
			]
		})
	]
})
export class AppModule {}
```

| Environment                               | `process.cwd()` | Plugin Location                          |
| ----------------------------------------- | --------------- | ---------------------------------------- |
| Development (`pnpm dev` from `apps/api/`) | `apps/api/`     | `packages/plugins/` (via `path.resolve`) |
| Production (Docker)                       | `/app/`         | `/app/plugins/` (copied during build)    |

**Notes:**

- The loader resolves relative paths from `process.cwd()`
- Non-existent paths are silently skipped (no error)
- Both paths can be specified; the loader checks each one

---

## Plugin Manifest Schema

The `everworks.plugin` field in package.json:

```typescript
interface PluginManifest {
	// REQUIRED fields
	id: string; // Unique identifier (e.g., "screenshotone")
	name: string; // Display name (e.g., "ScreenshotOne")
	version: string; // Semantic version (e.g., "1.0.0")
	category: PluginCategory; // Primary category

	// OPTIONAL fields
	capabilities?: string[]; // Additional capabilities beyond category
	description?: string; // Short description for UI
	author?: string; // Plugin author
	homepage?: string; // Documentation URL
	minContractsVersion?: string; // Minimum @ever-works/plugin version
	maxContractsVersion?: string; // Maximum compatible version
	dependencies?: string[]; // Other plugin IDs this depends on

	// ICON (required for UI display)
	icon: PluginIcon; // Plugin icon for UI display

	// AUTO-INSTALL & SYSTEM PLUGINS
	autoInstall?: boolean; // If true, plugin is installed for all users by default
	systemPlugin?: boolean; // If true, users cannot uninstall it (core functionality)

	// ENVIRONMENT VARIABLES (for testability)
	envVars?: PluginEnvVarConfig[]; // Declares which env vars the plugin needs
}

/**
 * Environment variable configuration for plugins.
 * Plugins declare their env var requirements in the manifest.
 */
interface PluginEnvVarConfig {
	name: string; // Env var name (e.g., "GH_CLIENT_ID")
	required: boolean; // Is this required for plugin to work?
	description: string; // Human-readable description
	secret?: boolean; // If true, value is masked in logs/UI
}

// Plugin icon options
interface PluginIcon {
	// Option 1: SVG string (recommended - scalable, themeable)
	svg?: string; // Raw SVG markup (e.g., "<svg>...</svg>")

	// Option 2: URL to icon image
	url?: string; // URL to PNG/SVG icon (e.g., "https://example.com/icon.svg")

	// Option 3: Base64 encoded image
	base64?: string; // Base64 data URI (e.g., "data:image/svg+xml;base64,...")

	// Option 4: Lucide icon name (built-in icons)
	lucide?: string; // Lucide icon name (e.g., "github", "cloud", "camera")

	// Icon colors (optional, for theming)
	color?: string; // Primary color (e.g., "#000000" or "currentColor")
	darkColor?: string; // Color for dark mode
}

type PluginCategory =
	| 'git' // Repository management
	| 'deployment' // Site deployment
	| 'screenshot' // Screenshot capture
	| 'search' // Web search
	| 'content' // Content extraction
	| 'data-source' // Data import
	| 'ai' // AI/LLM providers
	| 'pipeline'; // Pipeline modifications
```

### Auto-Installed vs User-Installed Plugins

| Plugin Type  | `autoInstall` | `systemPlugin` | User Action      | Example                              |
| ------------ | ------------- | -------------- | ---------------- | ------------------------------------ |
| **System**   | `true`        | `true`         | Cannot uninstall | GitHub (core git provider)           |
| **Default**  | `true`        | `false`        | Can uninstall    | ScreenshotOne (default but optional) |
| **Optional** | `false`       | `false`        | Must install     | Notion import, Apify                 |

**Auto-install behavior:**

- On first app startup, all `autoInstall: true` plugins are automatically installed for existing users
- New users get auto-install plugins immediately
- System plugins (`systemPlugin: true`) cannot be disabled or uninstalled

### Example package.json

```json
{
	"name": "@ever-works/plugin-screenshotone",
	"version": "1.0.0",
	"main": "dist/index.js",
	"peerDependencies": {
		"@ever-works/plugin": "^1.0.0"
	},
	"dependencies": {
		"screenshotone-api-sdk": "^1.0.0"
	},
	"everworks": {
		"plugin": {
			"id": "screenshotone",
			"name": "ScreenshotOne",
			"version": "1.0.0",
			"category": "screenshot",
			"capabilities": ["screenshot", "form-fields"],
			"description": "Capture website screenshots using ScreenshotOne API",
			"author": "Ever Works",
			"homepage": "https://docs.ever.works/plugins/screenshotone",
			"minContractsVersion": "1.0.0",
			"autoInstall": true,
			"icon": {
				"svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><circle cx=\"8.5\" cy=\"8.5\" r=\"1.5\"/><polyline points=\"21 15 16 10 5 21\"/></svg>",
				"color": "#6366f1"
			},
			"envVars": [
				{
					"name": "SCREENSHOTONE_ACCESS_KEY",
					"required": false,
					"description": "Default access key (users can override)"
				},
				{
					"name": "SCREENSHOTONE_SECRET_KEY",
					"required": false,
					"description": "Default secret key",
					"secret": true
				}
			]
		}
	}
}
```

### Icon Examples for Different Plugin Types

```json
// GitHub - using Lucide icon
"icon": { "lucide": "github", "color": "#24292f", "darkColor": "#ffffff" }

// Vercel - using SVG
"icon": { "svg": "<svg viewBox=\"0 0 76 65\"><path d=\"M37.5274 0L75.0548 65H0L37.5274 0Z\" fill=\"currentColor\"/></svg>" }

// OpenAI - using URL
"icon": { "url": "https://openai.com/favicon.ico" }

// Custom plugin - using base64
"icon": { "base64": "data:image/svg+xml;base64,PHN2Zy..." }
```

---

## Plugin Lifecycle

### States

```
┌──────────┐    onLoad()     ┌──────────┐   onEnable()   ┌──────────┐
│DISCOVERED│ ──────────────→ │  LOADED  │ ─────────────→ │ ENABLED  │
└──────────┘                 └──────────┘                └──────────┘
                                  │                           │
                                  │ onUnload()                │ onDisable()
                                  ▼                           ▼
                             ┌──────────┐               ┌──────────┐
                             │ UNLOADED │               │ DISABLED │
                             └──────────┘               └──────────┘
```

| State        | Description                                     |
| ------------ | ----------------------------------------------- |
| `DISCOVERED` | Found in filesystem, manifest validated         |
| `LOADED`     | Entry point loaded, `onLoad()` called           |
| `ENABLED`    | User enabled for directory, `onEnable()` called |
| `DISABLED`   | User disabled, `onDisable()` called             |
| `UNLOADED`   | Plugin removed, `onUnload()` called             |

### IPlugin Interface

```typescript
interface IPlugin {
	// Metadata (must match manifest)
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly category: PluginCategory;
	readonly capabilities: string[];

	// Settings schema (JSON Schema for UI form generation)
	readonly settingsSchema: JsonSchema;

	// Lifecycle hooks
	onLoad(context: PluginContext): Promise<void>;
	onEnable(context: PluginContext): Promise<void>;
	onDisable(context: PluginContext): Promise<void>;
	onUnload(): Promise<void>;

	// Settings validation
	validateSettings(settings: unknown): Promise<ValidationResult>;
}
```

---

## Plugin Context

What plugins can access when loaded:

```typescript
interface PluginContext {
	// Database Access
	dataSource: DataSource;
	getRepository<T>(entity: EntityTarget<T>): Repository<T>;

	// Core Services (read-only access to agent services)
	services: {
		directory: DirectoryQueryService;
		user: UserService;
	};

	// TYPE-SAFE Events (see event-types.ts for PluginEventName and PluginEventPayloads)
	eventEmitter: EventEmitter2;
	onEvent<E extends PluginEventName>(
		event: E,
		handler: (payload: PluginEventPayloads[E]) => void | Promise<void>
	): void;
	emitEvent<E extends PluginEventName>(event: E, payload: PluginEventPayloads[E]): void;

	// TYPE-SAFE Configuration (plugin's own settings from database)
	getSettings<T>(): Promise<T>;
	getUserSettings<T>(userId: string): Promise<T>;
	getDirectorySettings<T>(directoryId: string): Promise<T>;

	// ENVIRONMENT VARIABLES (injected, not read directly - for testability)
	env: PluginEnvironment;

	// HTTP (for plugin API routes)
	registerController(controller: Type<any>): void;

	// Custom Capabilities (plugin-to-plugin communication)
	registerCustomCapability<T>(capabilityId: string, implementation: T, metadata?: CapabilityMetadata): void;
	getCustomCapability<T>(capabilityId: string): T | undefined;
	hasCustomCapability(capabilityId: string): boolean;
	listCustomCapabilities(): CapabilityInfo[];

	// Logging
	logger: Logger;

	// Cache
	cache: CacheManager;
}

/**
 * Environment variables are INJECTED into plugins via context.env
 * Plugins should NEVER read process.env directly - this enables:
 * 1. Unit testing with mock env values
 * 2. Validation that required env vars are set at startup
 * 3. Secret masking in logs
 */
interface PluginEnvironment {
	/**
	 * Get an environment variable value.
	 * Returns undefined if not set.
	 */
	get(name: string): string | undefined;

	/**
	 * Get an environment variable, throw if not set.
	 * Use for required env vars.
	 */
	getRequired(name: string): string;

	/**
	 * Check if an environment variable is set.
	 */
	has(name: string): boolean;

	/**
	 * Get all environment variables for this plugin.
	 * Only returns vars declared in the plugin manifest.
	 */
	getAll(): Record<string, string | undefined>;
}
```

### Environment Variable Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ENVIRONMENT VARIABLE HANDLING                     │
└─────────────────────────────────────────────────────────────────────┘

Plugin Manifest (package.json):
{
    "everworks": {
        "plugin": {
            "id": "github",
            "envVars": [
                { "name": "GH_CLIENT_ID", "required": true, "description": "GitHub OAuth Client ID" },
                { "name": "GH_CLIENT_SECRET", "required": true, "secret": true },
                { "name": "GH_CALLBACK_URL", "required": true }
            ]
        }
    }
}
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. STARTUP VALIDATION                   │
│    For each plugin:                     │
│    - Check required env vars are set    │
│    - Log warnings for missing optional  │
│    - FAIL FAST if required missing      │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 2. CREATE PluginEnvironment             │
│    Core system reads process.env        │
│    Creates PluginEnvironment instance   │
│    Injects into PluginContext           │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 3. PLUGIN ACCESSES VIA CONTEXT          │
│    const clientId = context.env.get('GH_CLIENT_ID');             │
│    const secret = context.env.getRequired('GH_CLIENT_SECRET');   │
│    // NEVER: process.env.GH_CLIENT_ID  ❌                        │
└─────────────────────────────────────────┘
```

### Why Inject Env Vars (Testability)

```typescript
// ❌ BAD: Direct env access - hard to test
class GitHubPlugin {
    async connect() {
        const clientId = process.env.GH_CLIENT_ID;  // Can't mock in tests!
        // ...
    }
}

// ✅ GOOD: Injected via context - fully testable
class GitHubPlugin {
    async connect(context: PluginContext) {
        const clientId = context.env.get('GH_CLIENT_ID');  // Easy to mock!
        // ...
    }
}

// In tests:
const mockEnv: PluginEnvironment = {
    get: (name) => mockEnvVars[name],
    getRequired: (name) => mockEnvVars[name] ?? throw new Error(`Missing ${name}`),
    has: (name) => name in mockEnvVars,
    getAll: () => mockEnvVars,
};
const mockContext = { ...baseContext, env: mockEnv };
await plugin.connect(mockContext);  // ✅ Works in tests!
```

---

## Core Capabilities

Core capabilities are **fixed interfaces** called by the core system. They are defined in `plugin` and provide full TypeScript type safety.

**⚠️ TYPE SAFETY:** All capability interfaces use strict typing. No `any` types - use `unknown` for truly dynamic data.

### IGitProviderPlugin

```typescript
interface IGitProviderPlugin extends IPlugin {
	createRepository(options: CreateRepoOptions): Promise<Repository>;
	getRepository(owner: string, repo: string): Promise<Repository>;
	pushChanges(repo: Repository, changes: Changes): Promise<void>;
	createPullRequest(options: PROptions): Promise<PullRequest>;
	mergePullRequest(pr: PullRequest): Promise<void>;
	getUser(): Promise<GitUser>;
	getBranches(repo: Repository): Promise<Branch[]>;
	triggerWorkflow(repo: Repository, workflow: string, inputs?: WorkflowInputs): Promise<void>;
}

/** Type-safe workflow inputs (string values only for GitHub Actions) */
type WorkflowInputs = Record<string, string | boolean | number>;
```

### IDeploymentPlugin

```typescript
interface IDeploymentPlugin extends IPlugin {
	deploy(directory: Directory, options: DeployOptions): Promise<Deployment>;
	getDeploymentStatus(id: string): Promise<DeploymentStatus>;
	getDomains(directory: Directory): Promise<string[]>;
	getTeams(): Promise<Team[]>;
	validateToken(token: string): Promise<ValidationResult>;
}
```

### IScreenshotPlugin

```typescript
interface IScreenshotPlugin extends IPlugin {
	capture(url: string, options: ScreenshotOptions): Promise<Screenshot>;
	bulkCapture(requests: BulkRequest[]): Promise<Screenshot[]>;
	isAvailable(): boolean;
}
```

### IAiProviderPlugin

```typescript
interface IAiProviderPlugin extends IPlugin {
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
	chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatChunk>;
	embed(text: string | string[]): Promise<number[][]>;
	getModels(): Promise<Model[]>;
}
```

### IPipelineStepPlugin

Plugins can modify the pipeline in four ways:

1. **Step Replacement** - Replace an existing step entirely
2. **Step Injection** - Add new steps before/after existing ones
3. **Step Disable** - Remove steps from the pipeline
4. **Append/Prepend** - Add steps at the start or end

**⚠️ TYPE SAFETY:** All step IDs, data keys, and step results are strongly typed. See [Type Safety is Non-Negotiable](#type-safety-is-non-negotiable).

```typescript
// ============================================
// TYPE DEFINITIONS (in step-types.ts)
// ============================================

/** All valid built-in step IDs - compile-time validated */
export const BUILT_IN_STEP_IDS = [
	'prompt-comparison',
	'prompt-processing',
	'domain-detection',
	'search-query-generation',
	'ai-item-generation',
	'web-page-retrieval',
	'content-filtering',
	'item-extraction',
	'data-aggregation',
	'category-processing',
	'source-validation',
	'badge-processing',
	'image-capture',
	'markdown-generation'
] as const;

export type BuiltInStepId = (typeof BUILT_IN_STEP_IDS)[number];

/** All valid data keys that steps produce/consume */
export const STEP_DATA_KEYS = [
	'comparison-result',
	'processed-prompt',
	'subject',
	'featured-hints',
	'domain-analysis',
	'search-queries',
	'ai-items',
	'web-pages',
	'filtered-content',
	'extracted-items',
	'aggregated-items',
	'categorized-items',
	'validated-items',
	'badged-items',
	'items-with-images',
	'final-markdown'
] as const;

export type StepDataKey = (typeof STEP_DATA_KEYS)[number];

/** Map data keys to their TypeScript types */
export interface StepDataTypes {
	'comparison-result': { isIncremental: boolean; diff: PromptDiff };
	'processed-prompt': ProcessedPrompt;
	subject: string;
	'featured-hints': string[];
	'domain-analysis': DomainAnalysis;
	'search-queries': string[];
	'ai-items': GeneratedItem[];
	'web-pages': WebPage[];
	'filtered-content': FilteredContent[];
	'extracted-items': ExtractedItem[];
	'aggregated-items': AggregatedItem[];
	'categorized-items': CategorizedItem[];
	'validated-items': ValidatedItem[];
	'badged-items': BadgedItem[];
	'items-with-images': ItemWithImage[];
	'final-markdown': string;
}

// ============================================
// PIPELINE STEP DEFINITION (TYPE-SAFE)
// ============================================

/**
 * Pipeline step definition with explicit, TYPE-SAFE dependencies.
 * Used by both built-in steps and plugin steps.
 */
interface PipelineStepDefinition {
	/**
	 * Unique step ID.
	 * - Built-in steps: Use BuiltInStepId
	 * - Plugin steps: Use "plugin-name:step-name" format
	 */
	id: BuiltInStepId | `${string}:${string}`;

	/** Display name for UI/logs */
	name: string;

	/** Step description */
	description?: string;

	/**
	 * Dependencies: step IDs or data keys that must exist before this step runs.
	 * TYPE-SAFE: Only valid BuiltInStepId or StepDataKey values accepted.
	 */
	dependencies: (BuiltInStepId | StepDataKey)[];

	/**
	 * What this step produces.
	 * TYPE-SAFE: Must be valid StepDataKey values.
	 */
	provides: StepDataKey[];

	/**
	 * Category this step belongs to (for provider override).
	 * When user selects a sub-provider for this category, it handles the step.
	 */
	category?: 'search' | 'screenshot' | 'ai' | 'content';

	/** Can this step run in parallel with others that share no dependencies? */
	parallelizable?: boolean;

	/** Is this step optional? If true, pipeline continues even if step fails. */
	optional?: boolean;

	/** Timeout in milliseconds for this step. */
	timeout?: number;
}

/**
 * Position directive for step injection/replacement/disable.
 * TYPE-SAFE: stepId must be a valid BuiltInStepId.
 */
type StepPosition =
	| { type: 'before'; stepId: BuiltInStepId } // Insert before existing step
	| { type: 'after'; stepId: BuiltInStepId } // Insert after existing step
	| { type: 'replace'; stepId: BuiltInStepId } // Replace existing step entirely
	| { type: 'disable'; stepId: BuiltInStepId } // Disable/remove existing step
	| { type: 'append' } // Add to end of pipeline
	| { type: 'prepend' }; // Add to start of pipeline

/**
 * TYPE-SAFE Generation Context for step data flow.
 */
interface GenerationContext {
	/** Get step result with full type inference */
	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined;

	/** Set step result with type validation */
	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void;

	/** Check if a step result exists */
	hasStepResult(key: StepDataKey): boolean;
}

/**
 * Plugin that provides pipeline steps.
 * Can inject new steps, replace existing ones, or disable steps.
 */
interface IPipelineStepPlugin extends IPlugin {
	/**
	 * Get the steps this plugin provides.
	 * Can provide multiple steps.
	 */
	getSteps(): PipelineStepDefinition[];

	/**
	 * Get the position directive for each step.
	 * Maps step ID to where it should be placed.
	 */
	getStepPositions(): Map<string, StepPosition>;

	/**
	 * Execute a specific step.
	 * Called by pipeline executor when the step runs.
	 *
	 * @param stepId - The step ID to execute
	 * @param context - TYPE-SAFE generation context
	 * @param options - Plugin-specific options from pluginOptions
	 */
	executeStep(
		stepId: string,
		context: GenerationContext,
		options?: Record<string, unknown>
	): Promise<GenerationContext>;
}
```

**Example: Plugin Injecting New Steps**

```typescript
class ContentEnrichmentPlugin implements IPlugin, IPipelineStepPlugin {
	readonly id = 'content-enrichment';
	readonly name = 'Content Enrichment';
	readonly category = 'pipeline';
	readonly capabilities = ['pipeline-steps'];

	getSteps(): PipelineStepDefinition[] {
		return [
			{
				id: 'content-enrichment:social-data',
				name: 'Social Data Enrichment',
				description: 'Add GitHub stars, Twitter followers, etc.',
				dependencies: ['item-extraction'],
				provides: ['enriched-items']
			},
			{
				id: 'content-enrichment:pricing',
				name: 'Pricing Enrichment',
				description: 'Extract pricing from product pages',
				dependencies: ['content-enrichment:social-data'],
				provides: ['items-with-pricing']
			}
		];
	}

	getStepPositions(): Map<string, StepPosition> {
		return new Map([
			['content-enrichment:social-data', { type: 'after', stepId: 'item-extraction' }],
			['content-enrichment:pricing', { type: 'after', stepId: 'content-enrichment:social-data' }]
		]);
	}

	async executeStep(stepId: string, context: GenerationContext): Promise<GenerationContext> {
		switch (stepId) {
			case 'content-enrichment:social-data':
				return this.enrichWithSocialData(context);
			case 'content-enrichment:pricing':
				return this.enrichWithPricing(context);
			default:
				return context;
		}
	}
}
```

**Example: Plugin Replacing a Step**

```typescript
class ExaPlugin implements IPlugin, ISubProviderPlugin, IPipelineStepPlugin {
	readonly id = 'exa';
	readonly subProviders = [
		{ id: 'exa:search', name: 'Exa Search', capability: 'search', ... },
	];

	// When "exa:search" is selected, it REPLACES search-query-generation
	getSteps(): PipelineStepDefinition[] {
		return [{
			id: 'exa:search-step',
			name: 'Exa Neural Search',
			description: 'Search using Exa neural search API',
			dependencies: ['domain-detection'],
			provides: ['search-queries', 'web-pages'],  // Provides BOTH!
			category: 'search',
			parallelizable: true,
		}];
	}

	getStepPositions(): Map<string, StepPosition> {
		return new Map([
			['exa:search-step', { type: 'replace', stepId: 'search-query-generation' }],
		]);
	}

	async executeStep(stepId: string, context: GenerationContext): Promise<GenerationContext> {
		// Exa search returns both queries AND pages in one call
		const results = await this.exaSearch(context.dto.prompt);
		return {
			...context,
			searchQueries: results.queries,
			webPages: results.pages,  // Skip web-page-retrieval!
		};
	}
}
```

### IFullPipelinePlugin

Full Pipeline plugins have their **OWN steps**. They are NOT a single black-box function - they define a complete step-based pipeline that uses the SAME `PipelineExecutor` as the Standard Pipeline.

**Key characteristics:**

- **Self-contained:** No external plugins can inject/replace/disable steps in a Full Pipeline
- **Own steps:** Defines its own `PipelineStepDefinition[]`
- **Same executor:** Uses `PipelineExecutor` like Standard Pipeline

```typescript
/**
 * Full Pipeline plugins define their own steps.
 * NOT a single black-box function - a complete step-based pipeline.
 */
interface IFullPipelinePlugin extends IPlugin {
	/**
	 * Get this pipeline's steps.
	 * These are executed by PipelineExecutor, NOT a single function.
	 */
	getSteps(): PipelineStepDefinition[];

	/**
	 * Execute a specific step.
	 * Called by PipelineExecutor for each step in this pipeline.
	 */
	executeStep(
		stepId: string,
		context: GenerationContext,
		options?: Record<string, unknown>
	): Promise<GenerationContext>;

	/**
	 * Get supported options schema for the generator form.
	 */
	getOptionsSchema(): JsonSchema;
}

// Example: Exa Websets Full Pipeline with own steps
class ExaWebsetsPlugin implements IFullPipelinePlugin {
	getSteps(): PipelineStepDefinition[] {
		return [
			{ id: 'exa:websets-init', name: 'Initialize Webset', dependencies: [], provides: ['webset-session'] },
			{
				id: 'exa:websets-research',
				name: 'Webset Research',
				dependencies: ['exa:websets-init'],
				provides: ['raw-results']
			},
			{
				id: 'exa:websets-curate',
				name: 'Webset Curation',
				dependencies: ['exa:websets-research'],
				provides: ['curated-items']
			},
			{
				id: 'exa:websets-enrich',
				name: 'Webset Enrichment',
				dependencies: ['exa:websets-curate'],
				provides: ['enriched-items']
			},
			{
				id: 'exa:websets-format',
				name: 'Format Output',
				dependencies: ['exa:websets-enrich'],
				provides: ['final-items']
			}
		];
	}

	async executeStep(stepId: string, context: GenerationContext): Promise<GenerationContext> {
		switch (stepId) {
			case 'exa:websets-init':
				return this.initializeWebset(context);
			case 'exa:websets-research':
				return this.runResearch(context);
			// ... other steps
		}
	}

	getOptionsSchema(): JsonSchema {
		return { type: 'object', properties: { websetMode: { type: 'string' } } };
	}
}
```

### IFormFieldPlugin

```typescript
interface IFormFieldPlugin extends IPlugin {
	getFormFields(): FormFieldDefinition[];
	validateFormInput(values: Record<string, unknown>): ValidationResult;
}
```

### IOAuthPlugin

OAuth is specifically for connecting user accounts to OAuth providers (GitHub, GitLab, Bitbucket, etc.) so the platform can manage resources on their behalf. This is **NOT** for app authentication (logging into Ever Works), which remains hardcoded.

**Why OAuth instead of access tokens?**
Most Ever Works users are not technical and shouldn't need to manually create and paste access tokens. OAuth provides a familiar "Connect with GitHub" flow.

```typescript
interface IOAuthPlugin extends IPlugin {
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string;
	exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;
	refreshAccessToken?(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;
	revokeToken?(token: string): Promise<void>;
	getAuthenticatedUser(token: string): Promise<OAuthUser>;
}
```

### ISubProviderPlugin (Multi-Capability Plugins)

For plugins that offer multiple capabilities (e.g., Exa.ai with Websets AND Search):

```typescript
interface PluginSubProvider {
	id: string; // "exa:websets", "exa:search"
	name: string; // "Exa Websets", "Exa Search"
	description?: string;
	icon?: PluginIcon; // Can override parent plugin icon
	capability: PluginCapability; // "full-pipeline", "search", etc.
	handledConfigFields?: string[]; // ConfigDto fields this handles (['*'] = all)
}

interface ISubProviderPlugin extends IPlugin {
	// Define sub-providers for different uses of this plugin
	readonly subProviders: PluginSubProvider[];

	// Get form fields for a specific sub-provider
	getFormFieldsForSubProvider(subProviderId: string): FormFieldDefinition[];
}

// Example: Exa plugin with multiple sub-providers
class ExaPlugin implements IPlugin, IFullPipelinePlugin, ISearchPlugin, ISubProviderPlugin {
	readonly subProviders: PluginSubProvider[] = [
		{
			id: 'exa:websets',
			name: 'Exa Websets',
			description: 'AI-powered research replacing entire pipeline',
			capability: 'full-pipeline',
			handledConfigFields: ['*']
		},
		{
			id: 'exa:search',
			name: 'Exa Search',
			description: 'Neural search for the search step only',
			capability: 'search',
			handledConfigFields: ['max_search_queries', 'max_results_per_query']
		}
	];
}
```

### IConfigAwarePlugin

Plugins can declare which ConfigDto fields they handle:

```typescript
interface IConfigAwarePlugin extends IPlugin {
	// Returns field names this plugin handles (or ['*'] for all)
	getHandledConfigFields(subProviderId?: string): string[];

	// Optional: Map ConfigDto to plugin-specific options
	mapConfig?(config: ConfigDto, subProviderId?: string): Record<string, unknown>;
}
```

---

## Custom Capabilities (Hybrid System)

The plugin system uses a **hybrid approach**:

1. **Core Capabilities** - Fixed interfaces called by core system
2. **Custom Capabilities** - Dynamic registration for plugin-to-plugin communication

### Why Hybrid?

```
┌─────────────────────────────────────────────────────────────────┐
│                    CAPABILITY SYSTEM                            │
├─────────────────────────────────┬───────────────────────────────┤
│      CORE CAPABILITIES          │     CUSTOM CAPABILITIES       │
│      (Fixed Interfaces)         │     (Dynamic Registry)        │
├─────────────────────────────────┼───────────────────────────────┤
│ • IGitProviderPlugin            │ • Plugin-defined at runtime   │
│ • IDeploymentPlugin             │ • Plugin-to-plugin comms      │
│ • IScreenshotPlugin             │ • Core system ignores these   │
│ • IAiProviderPlugin             │ • Type-safe via generics      │
│ • IPipelineStepPlugin           │                               │
├─────────────────────────────────┼───────────────────────────────┤
│ Called by: Core system          │ Called by: Other plugins      │
│ Type-safe: Full interfaces      │ Type-safe: Generic + runtime  │
│ Versioned: With contracts pkg   │ Versioned: By plugin author   │
└─────────────────────────────────┴───────────────────────────────┘
```

### Custom Capability Example

```typescript
// Custom capability interface (defined by plugin author)
interface INotificationCapability {
	send(message: string, channel: string): Promise<void>;
	getChannels(): Promise<string[]>;
}

// Plugin A registers a custom capability
class SlackNotifierPlugin implements IPlugin {
	async onLoad(context: PluginContext) {
		context.registerCustomCapability<INotificationCapability>('notifications', {
			send: async (message, channel) => {
				await this.slack.postMessage(channel, message);
			},
			getChannels: async () => this.getConfiguredChannels()
		});
	}
}

// Plugin B consumes the custom capability
class DeploymentMonitorPlugin implements IPlugin {
	async onDeployComplete(context: PluginContext, deployment: Deployment) {
		const notifier = context.getCustomCapability<INotificationCapability>('notifications');
		if (notifier) {
			await notifier.send(`Deployed ${deployment.url}`, '#deploys');
		}
	}
}
```

### ICustomCapabilityRegistry

```typescript
interface ICustomCapabilityRegistry {
	register<T>(capabilityId: string, implementation: T, metadata?: CapabilityMetadata): void;
	get<T>(capabilityId: string): T | undefined;
	has(capabilityId: string): boolean;
	list(): CapabilityInfo[];
	unregister(capabilityId: string): void;
}

interface CapabilityMetadata {
	description?: string;
	version?: string;
	schema?: JsonSchema;
}

interface CapabilityInfo {
	id: string;
	providedBy: string; // Plugin ID
	metadata?: CapabilityMetadata;
}
```

### Use Cases for Custom Capabilities

| Custom Capability | Provider Plugin       | Consumer Plugins             |
| ----------------- | --------------------- | ---------------------------- |
| `notifications`   | Slack, Discord, Email | Any plugin needing alerts    |
| `analytics`       | PostHog, Mixpanel     | Plugins tracking events      |
| `storage`         | S3, GCS, Local        | Plugins needing file storage |
| `code-review`     | GitHub, GitLab        | CI/CD plugins                |
| `caching`         | Redis, Memcached      | Performance plugins          |

---

## Current Pipeline Integration

This section documents how the existing pipeline works and how plugins will integrate with it.

### Current Pipeline Architecture

The current pipeline follows a **sequential executor pattern** with the following characteristics:

| Aspect             | Implementation                                             |
| ------------------ | ---------------------------------------------------------- |
| **Step Contract**  | `IPipelineStep` interface (name + async run method)        |
| **Data Passing**   | Single `GenerationContext` object mutated in place         |
| **Execution**      | Sequential with optional parallel steps via `ParallelStep` |
| **Registration**   | Fluent API (`addStep()`) - fully dynamic                   |
| **Error Handling** | Immediate throw, no retry (checkpointing for resume)       |
| **Resumption**     | Checkpoint-based with cache persistence (1 hour TTL)       |

### Current Step Interface

```typescript
// packages/agent/src/items-generator/interfaces/pipeline.interface.ts
export interface IPipelineStep {
	name: string;
	run(context: GenerationContext): Promise<GenerationContext>;
}
```

### Current Pipeline Steps (15 total)

```
1.  PromptComparisonService      - prompt-comparison
2.  PromptProcessingService      - prompt-processing
3.  DomainDetectionService       - domain-detection
4.  ┌ AiItemGenerationService    - ai-first-items-generation  ┐
    │ SearchQueryGenerationService- search-queries-generation │ (PARALLEL)
5.  WebPageRetrievalService      - web-search
6.  ContentFilteringService      - content-filtering
7.  ItemExtractionService        - items-extraction
8.  DataAggregationService       - deduplication-and-data-aggregation
9.  CategoryProcessingService    - categories-tags-processing
10. SourceValidationService      - sources-validation
11. BadgeProcessingService       - badges-processing
12. ImageCaptureService          - image-capture (SmartImageRouter)
13. MarkdownGenerationService    - markdown-generation
```

### GenerationContext Structure

This is the data object passed through all pipeline steps:

```typescript
export interface GenerationContext {
	// Input Data
	directory: Directory;
	dto: CreateItemsGeneratorDto; // Generation parameters
	existing: ExistingItems; // Existing items, categories, tags, brands
	advancedPrompts?: AdvancedPromptsContext; // Custom prompts per directory

	// State accumulated during steps
	extractedUrls: string[];
	searchQueries: string[];
	webPages: WebPageData[];
	processedSourceUrls: Set<string>;
	contentCache: Map<string, string>; // source_url -> raw_content

	// Intermediate Results
	initialAiItems: ItemData[];
	extractedWebItems: ItemData[];
	aggregatedItems: ItemData[];

	// Final Output
	finalItems: ItemData[];
	finalCategories: Category[];
	finalTags: Tag[];
	finalBrands: Brand[];

	// Domain Intelligence
	domainAnalysis?: DomainAnalysis;

	// Metrics
	metrics: ItemsGeneratorMetrics;

	// Control Flow
	shouldStop?: boolean;
}
```

### Generation Parameters (CreateItemsGeneratorDto)

The current generator accepts these parameters:

```typescript
interface CreateItemsGeneratorDto {
	// Required
	name: string; // Generation run name
	prompt: string; // Main prompt (max 5000 chars)

	// Optional - Company
	company?: { name: string; website: string };

	// Optional - Categories & Keywords
	initial_categories?: string[];
	priority_categories?: string[];
	target_keywords?: string[];

	// Optional - Data Sources
	source_urls?: string[]; // Manual URLs to scan

	// Optional - Repository & Deployment
	repository_description?: string;
	generation_method?: 'create-update' | 'recreate';
	update_with_pull_request?: boolean;

	// Optional - Features
	badge_evaluation_enabled?: boolean;
	capture_screenshots?: boolean;

	// Optional - Config
	config?: ConfigDto; // Advanced settings
}

interface ConfigDto {
	max_search_queries?: number; // 1-100, default 10
	max_results_per_query?: number; // 1-100, default 5
	max_pages_to_process?: number; // 1-1000, default 10
	max_items?: number; // Optional limit
	relevance_threshold_content?: number; // 0.01-1.0, default 0.6
	ai_first_generation_enabled?: boolean; // Default false
	content_filtering_enabled?: boolean; // Default true
	data_volume_mode?: 'real' | 'sample'; // Sample auto-limits values
	generate_categories?: boolean; // Default true
	generate_tags?: boolean; // Default true
	generate_brands?: boolean; // Default true
}
```

### Parallel Step Implementation

The current `ParallelStep` wrapper executes multiple steps concurrently:

```typescript
// packages/agent/src/items-generator/pipeline/steps/parallel.step.ts
export class ParallelStep implements IPipelineStep {
	constructor(private readonly steps: IPipelineStep[]) {
		this.name = `Parallel(${steps.map((s) => s.name).join(', ')})`;
	}

	async run(context: GenerationContext): Promise<GenerationContext> {
		// 1. Clone context for each step (shallow clone)
		const promises = this.steps.map((step) => {
			const stepContext = { ...context };
			return step.run(stepContext);
		});

		// 2. Execute all steps concurrently
		const results = await Promise.all(promises);

		// 3. Merge results back (overlay changed properties)
		let mergedContext = { ...context };
		for (const result of results) {
			for (const key in result) {
				if (result[key] !== context[key]) {
					mergedContext[key] = result[key];
				}
			}
		}
		return mergedContext;
	}
}
```

---

## New Pipeline Architecture

### Pipeline Modification Types

Plugins can modify the pipeline in four ways:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PIPELINE MODIFICATION TYPES                       │
├─────────────────────────────────────────────────────────────────────┤
│  1. FULL REPLACEMENT (IFullPipelinePlugin)                          │
│     └── Exa Websets replaces entire pipeline                        │
│                                                                      │
│  2. STEP REPLACEMENT (IPipelineStepPlugin with position: 'replace') │
│     └── Exa Search replaces 'search-query-generation' step          │
│     └── SerpAPI replaces 'search-query-generation' step             │
│                                                                      │
│  3. STEP INJECTION (IPipelineStepPlugin with position: 'before/after')
│     └── ContentEnricher injects after 'item-extraction'             │
│     └── SpamFilter injects after 'data-aggregation'                 │
│     └── Translator injects before 'markdown-generation'             │
│                                                                      │
│  4. STEP DISABLING (IPipelineStepPlugin with position: 'disable')   │
│     └── Disable 'category-processing' for flat directories          │
│     └── Disable 'badge-processing' when not needed                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Built-in Steps Definition

The current pipeline has **14 steps** defined with explicit dependencies:

```typescript
// Built-in step definitions with explicit dependencies
const BUILT_IN_STEPS: PipelineStepDefinition[] = [
	{
		id: 'prompt-comparison',
		name: 'Prompt Comparison',
		description: 'Compare with previous prompts for incremental generation',
		dependencies: [],
		provides: ['comparison-result']
	},
	{
		id: 'prompt-processing',
		name: 'Prompt Processing',
		description: 'Extract intent and parameters from prompt',
		dependencies: ['prompt-comparison'],
		provides: ['processed-prompt', 'subject', 'featured-hints']
	},
	{
		id: 'domain-detection',
		name: 'Domain Detection',
		description: 'Detect directory domain type',
		dependencies: ['prompt-processing'],
		provides: ['domain-analysis']
	},
	{
		id: 'search-query-generation',
		name: 'Search Query Generation',
		description: 'Generate search queries from prompt',
		dependencies: ['domain-detection'],
		provides: ['search-queries'],
		category: 'search', // Can be replaced by search plugins
		parallelizable: true // Runs parallel with ai-item-generation
	},
	{
		id: 'ai-item-generation',
		name: 'AI Item Generation',
		description: 'Generate initial items using AI',
		dependencies: ['domain-detection'],
		provides: ['ai-items'],
		category: 'ai',
		parallelizable: true
	},
	{
		id: 'web-page-retrieval',
		name: 'Web Page Retrieval',
		description: 'Fetch web pages from search results',
		dependencies: ['search-query-generation'],
		provides: ['web-pages', 'content-cache']
	},
	{
		id: 'content-filtering',
		name: 'Content Filtering',
		description: 'Filter irrelevant content from pages',
		dependencies: ['web-page-retrieval'],
		provides: ['filtered-pages']
	},
	{
		id: 'item-extraction',
		name: 'Item Extraction',
		description: 'Extract items from filtered content',
		dependencies: ['content-filtering'],
		provides: ['extracted-items']
	},
	{
		id: 'data-aggregation',
		name: 'Data Aggregation',
		description: 'Combine and deduplicate items from all sources',
		dependencies: ['item-extraction', 'ai-item-generation'],
		provides: ['aggregated-items']
	},
	{
		id: 'category-processing',
		name: 'Category Processing',
		description: 'Categorize items into groups',
		dependencies: ['data-aggregation'],
		provides: ['categorized-items', 'categories', 'tags']
	},
	{
		id: 'source-validation',
		name: 'Source Validation',
		description: 'Validate item source URLs',
		dependencies: ['category-processing'],
		provides: ['validated-items']
	},
	{
		id: 'badge-processing',
		name: 'Badge Processing',
		description: 'Add badges to items',
		dependencies: ['source-validation'],
		provides: ['items-with-badges'],
		optional: true
	},
	{
		id: 'image-capture',
		name: 'Image Capture',
		description: 'Capture images for items',
		dependencies: ['badge-processing'],
		provides: ['items-with-images'],
		category: 'screenshot'
	},
	{
		id: 'markdown-generation',
		name: 'Markdown Generation',
		description: 'Generate markdown content for items',
		dependencies: ['image-capture'],
		provides: ['final-items']
	}
];
```

### PipelineBuilderService

```typescript
@Injectable()
class PipelineBuilderService {
	/**
	 * Build the pipeline for a directory based on enabled plugins.
	 */
	build(directoryId: string, providers: SubProviderSelectionDto): ExecutablePipeline {
		// 1. Start with built-in steps
		let steps = [...BUILT_IN_STEPS];
		const disabledSteps = new Set<string>();
		const replacements = new Map<string, PipelineStepDefinition>();
		const injections: { step: PipelineStepDefinition; position: StepPosition }[] = [];

		// 2. Get all enabled pipeline plugins for this directory
		const pipelinePlugins = this.registry.getEnabledByCapability<IPipelineStepPlugin>(
			directoryId,
			'pipeline-steps'
		);

		// 3. Process each plugin's steps
		for (const plugin of pipelinePlugins) {
			const pluginSteps = plugin.getSteps();
			const positions = plugin.getStepPositions();

			for (const step of pluginSteps) {
				const position = positions.get(step.id);

				switch (position?.type) {
					case 'replace':
						replacements.set(position.stepId, step);
						break;
					case 'disable':
						disabledSteps.add(position.stepId);
						break;
					case 'before':
					case 'after':
					case 'prepend':
					case 'append':
						injections.push({ step, position });
						break;
					default:
						// No position = add based on dependencies
						steps.push(step);
				}
			}
		}

		// 4. Apply replacements
		steps = steps.map((step) => replacements.get(step.id) || step);

		// 5. Remove disabled steps
		steps = steps.filter((step) => !disabledSteps.has(step.id));

		// 6. Apply injections
		for (const { step, position } of injections) {
			steps = this.injectStep(steps, step, position);
		}

		// 7. Apply provider overrides
		steps = this.applyProviderOverrides(steps, providers);

		// 8. Topological sort based on dependencies
		const orderedSteps = this.topologicalSort(steps);

		// 9. Identify parallel groups
		const parallelGroups = this.identifyParallelGroups(orderedSteps);

		return new ExecutablePipeline(orderedSteps, parallelGroups);
	}

	/**
	 * Topological sort respecting dependencies
	 */
	private topologicalSort(steps: PipelineStepDefinition[]): PipelineStepDefinition[] {
		const stepMap = new Map(steps.map((s) => [s.id, s]));
		const visited = new Set<string>();
		const result: PipelineStepDefinition[] = [];

		const visit = (stepId: string) => {
			if (visited.has(stepId)) return;
			visited.add(stepId);

			const step = stepMap.get(stepId);
			if (!step) return;

			for (const dep of step.dependencies) {
				visit(dep);
			}
			result.push(step);
		};

		for (const step of steps) {
			visit(step.id);
		}

		return result;
	}

	/**
	 * Identify steps that can run in parallel
	 */
	private identifyParallelGroups(steps: PipelineStepDefinition[]): ParallelGroup[] {
		// Steps with same dependencies and parallelizable=true can run together
		// Returns groups like: [{steps: [step1], parallel: false}, {steps: [step2, step3], parallel: true}]
	}
}
```

### Visual: Pipeline with Plugins

```
DEFAULT PIPELINE:
┌─────────────────────────────────────────────────────────────────────┐
│  1. prompt-comparison                                               │
│  2. prompt-processing                                               │
│  3. domain-detection                                                │
│  4. ┌─ PARALLEL ─────────────────────────────────────────────────┐  │
│     │  search-query-generation                                   │  │
│     │  ai-item-generation                                        │  │
│     └────────────────────────────────────────────────────────────┘  │
│  5. web-page-retrieval                                              │
│  6. content-filtering                                               │
│  7. item-extraction                                                 │
│  8. data-aggregation                                                │
│  9. category-processing                                             │
│ 10. source-validation                                               │
│ 11. badge-processing                                                │
│ 12. image-capture                                                   │
│ 13. markdown-generation                                             │
└─────────────────────────────────────────────────────────────────────┘

WITH PLUGINS ENABLED (Exa Search + Content Enrichment + Spam Filter + Translation):
┌─────────────────────────────────────────────────────────────────────┐
│  1. prompt-comparison                                               │
│  2. prompt-processing                                               │
│  3. domain-detection                                                │
│  4. ┌─ PARALLEL ─────────────────────────────────────────────────┐  │
│     │  [exa:search-step]      ← REPLACED search-query-generation │  │
│     │  ai-item-generation                                        │  │
│     └────────────────────────────────────────────────────────────┘  │
│  5. web-page-retrieval (may be skipped if Exa provided pages)       │
│  6. content-filtering                                               │
│  7. item-extraction                                                 │
│  8. [content-enrichment:social-data]  ← INJECTED after extraction  │
│  9. [content-enrichment:pricing]      ← INJECTED after social-data │
│ 10. data-aggregation                                                │
│ 11. [spam-filter:check]               ← INJECTED after aggregation │
│ 12. category-processing                                             │
│ 13. source-validation                                               │
│ 14. badge-processing                                                │
│ 15. image-capture                                                   │
│ 16. [translation:translate]           ← INJECTED before markdown   │
│ 17. markdown-generation                                             │
└─────────────────────────────────────────────────────────────────────┘

FULL PIPELINE (Exa Websets) - Has its OWN steps:
┌─────────────────────────────────────────────────────────────────────┐
│  Exa Websets Plugin has its OWN step-based pipeline:                │
│                                                                     │
│  steps = [                                                          │
│    exa:websets-init,       // Initialize webset session             │
│    exa:websets-research,   // AI-powered research                   │
│    exa:websets-curate,     // Curate and filter results             │
│    exa:websets-enrich,     // Enrich with metadata                  │
│    exa:websets-format,     // Format to Item[]                      │
│  ]                                                                  │
│                                                                     │
│  ✓ Uses SAME PipelineExecutor as Standard Pipeline                  │
│  ✗ Self-contained: No external plugin modifications allowed         │
│  ✗ Standard pipeline steps are SKIPPED entirely                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Pipeline Execution Flow

Both Standard and Full Pipelines use the **SAME PipelineExecutor** - just different step arrays.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    PIPELINE EXECUTION FLOW                           │
│     Both Standard and Full Pipelines use the SAME PipelineExecutor   │
└─────────────────────────────────────────────────────────────────────┘

CreateItemsGeneratorDto arrives
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. CHECK FULL PIPELINE PROVIDER         │
│    Is providers.pipeline set?           │
│    ├─→ Yes → Go to FULL PIPELINE branch │
│    └─→ No  → Go to STANDARD branch      │
└─────────────────────────────────────────┘
    │
    ├────────────────────────┬────────────────────────┐
    │                        │                        │
    ▼                        ▼                        │
┌─────────────────────┐   ┌─────────────────────┐    │
│ STANDARD PIPELINE   │   │ FULL PIPELINE       │    │
│                     │   │                     │    │
│ steps = [           │   │ steps =             │    │
│   BUILT_IN_STEPS    │   │  fullPlugin         │    │
│   + plugin inject   │   │    .getSteps()      │    │
│   - plugin replace  │   │                     │    │
│   - plugin disable  │   │ (Self-contained,    │    │
│ ]                   │   │  no modifications)  │    │
│                     │   │                     │    │
│ Topological sort    │   │ Steps already       │    │
│ Parallel groups     │   │ ordered by plugin   │    │
└─────────────────────┘   └─────────────────────┘    │
    │                        │                        │
    └────────────────────────┴────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────┐
│ 2. SAME PipelineExecutor.execute()      │
│    For each step/parallel group:        │
│    - Get executor (built-in or plugin)  │
│    - Call executeStep(stepId, context)  │
│    - Handle errors (optional steps)     │
│    - Save checkpoint                    │
│    - Update metrics                     │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 3. EXECUTE STEPS                        │
│    For each step/parallel group:        │
│    - Get executor (built-in or plugin)  │
│    - Pass context + pluginOptions       │
│    - Handle errors (optional steps)     │
│    - Save checkpoint                    │
│    - Update metrics                     │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 4. RETURN RESULTS                       │
│    - finalItems                         │
│    - finalCategories                    │
│    - finalTags                          │
│    - metrics                            │
└─────────────────────────────────────────┘
```

---

## Generator Form Architecture

This section describes how the generator form handles multiple plugins and provider selection.

### The Problem

Users may install multiple plugins of the same category:

- **Search**: Tavily, Exa.ai, SerpAPI
- **Screenshot**: ScreenshotOne, Playwright
- **AI**: OpenAI, Anthropic, Google
- **Full Pipeline**: Exa.ai (replaces entire pipeline)

Additionally, some plugins like **Exa.ai** have multiple capabilities:

- **Exa Websets**: Full pipeline replacement
- **Exa Search**: Just the search step

We don't want separate plugins - **one plugin should handle all capabilities**.

**How do they choose which one to use for each generation?**

### Multi-Capability Plugins with Sub-Providers

A single plugin can register multiple "sub-providers" with different display names:

```typescript
interface PluginSubProvider {
	id: string; // "exa:websets", "exa:search"
	name: string; // "Exa Websets", "Exa Search"
	description?: string;
	icon?: PluginIcon; // Can override plugin icon
	capability: string; // "full-pipeline", "search"
	handledConfigFields?: string[]; // Which ConfigDto fields this handles
}

class ExaPlugin implements IPlugin, IFullPipelinePlugin, ISearchPlugin {
	readonly id = 'exa';
	readonly name = 'Exa.ai';
	readonly capabilities = ['full-pipeline', 'search', 'form-fields'];

	readonly subProviders: PluginSubProvider[] = [
		{
			id: 'exa:websets',
			name: 'Exa Websets',
			description: 'AI-powered web research replacing entire pipeline',
			capability: 'full-pipeline',
			handledConfigFields: ['*'] // Handles ALL config
		},
		{
			id: 'exa:search',
			name: 'Exa Search',
			description: 'Neural search API for the search step',
			capability: 'search',
			handledConfigFields: ['max_search_queries', 'max_results_per_query']
		}
	];

	// Form fields depend on which sub-provider is selected
	getFormFields(subProviderId: string): FormFieldDefinition[] {
		if (subProviderId === 'exa:websets') {
			return [
				/* Websets-specific fields */
			];
		}
		if (subProviderId === 'exa:search') {
			return [
				/* Search-specific fields */
			];
		}
		return [];
	}
}
```

### ConfigDto Handling

Plugins declare which ConfigDto fields they handle. The UI grays out those fields:

```typescript
// Existing ConfigDto (for standard pipeline)
interface ConfigDto {
	max_search_queries: number; // Handled by search plugins
	max_results_per_query: number; // Handled by search plugins
	max_pages_to_process: number; // Handled by content retrieval
	relevance_threshold_content: number;
	ai_first_generation_enabled: boolean;
	// ... etc
}

// Plugin declares which fields it handles
interface IConfigAwarePlugin {
	// Returns field names this plugin handles (or ['*'] for all)
	getHandledConfigFields(subProviderId?: string): string[];
}
```

When a plugin handles a config field:

- UI shows the field as "handled by [Plugin Name]"
- Field is grayed out but still visible
- Plugin receives the value and can use/ignore it

### Three Levels of Configuration

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install plugins                                                │
│    - Configure API keys                                             │
│    - Set global defaults                                            │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Enable/disable plugins for this directory                      │
│    - Set DEFAULT provider per category                              │
│    - Override plugin settings (e.g., viewport for screenshots)      │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider selection for THIS generation                │
│    - Configure plugin-specific options                              │
│    - Select full pipeline vs standard                               │
└─────────────────────────────────────────────────────────────────────┘
```

### Generator Form UI

```
┌─────────────────────────────────────────────────────────────────────┐
│                      GENERATOR FORM                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Name:   [_________________________________________________]        │
│  Prompt: [_________________________________________________]        │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PIPELINE MODE                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  ○ Standard Pipeline (step-by-step)                                 │
│  ● Full Pipeline Provider: [Exa.ai ▼]                               │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PROVIDER SELECTION (when Standard Pipeline selected)               │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  Search Provider:     [🔍 Tavily ▼]  (directory default)            │
│  Screenshot Provider: [📷 ScreenshotOne ▼]                          │
│  AI Provider:         [🤖 OpenAI GPT-4 ▼]                           │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PLUGIN OPTIONS (dynamic, from IFormFieldPlugin)                    │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  [Exa.ai specific fields when Exa selected]                         │
│  │ Search depth: [● Basic  ○ Deep]                                  │
│  │ Include similar: [✓]                                             │
│                                                                     │
│  [ScreenshotOne fields when selected]                               │
│  │ Viewport: [1280] x [800]                                         │
│  │ Block ads: [✓]                                                   │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  EXISTING GENERATOR OPTIONS                                         │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  Generation Method:     [● Create/Update  ○ Recreate]               │
│  Capture Screenshots:   [✓]                                         │
│  Badge Evaluation:      [ ]                                         │
│  Data Volume Mode:      [● Real  ○ Sample]                          │
│                                                                     │
│  [Advanced Config ▼]                                                │
│  │ max_search_queries:     [10]                                     │
│  │ max_results_per_query:  [5]                                      │
│  │ max_pages_to_process:   [10]                                     │
│  │ ...                                                              │
│                                                                     │
│                                          [Generate]                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Models

```typescript
// Directory-level defaults (stored in DirectoryPlugin entity)
interface DirectoryPluginConfig {
	directoryId: string;

	// Default provider per category
	defaults: {
		search?: string; // "tavily" | "exa" | "serpapi"
		screenshot?: string; // "screenshotone" | "playwright"
		ai?: string; // "openai" | "anthropic"
		pipeline?: string; // null = standard, "exa" = full pipeline
	};

	// Plugin-specific settings
	pluginSettings: Record<string, unknown>;
}

// Generation-level overrides (passed to pipeline)
interface GenerationOptions {
	// Existing generator DTO fields
	name: string;
	prompt: string;
	generation_method?: 'create-update' | 'recreate';
	capture_screenshots?: boolean;
	badge_evaluation_enabled?: boolean;
	config?: ConfigDto;
	// ... all other existing fields

	// NEW: Provider overrides (null = use directory default)
	providers?: {
		search?: string | null;
		screenshot?: string | null;
		ai?: string | null;
		pipeline?: string | null; // If set, uses full pipeline
	};

	// NEW: Plugin-specific options for this generation
	pluginOptions?: Record<string, unknown>;
}
```

### API: Get Generator Form Schema

```typescript
// GET /directories/:id/generator-form
interface GeneratorFormSchema {
	// Available sub-providers per category (with icons!)
	providers: {
		search: SubProviderOption[]; // Includes "Exa Search", "Tavily"
		screenshot: SubProviderOption[];
		ai: SubProviderOption[];
		fullPipeline: SubProviderOption[]; // Includes "Exa Websets"
		dataSource: SubProviderOption[];
	};

	// Directory defaults (using sub-provider IDs)
	defaults: {
		search: string; // "exa:search" or "tavily"
		screenshot: string; // "screenshotone"
		ai: string; // "openai"
		pipeline: string | null; // "exa:websets" or null for standard
	};

	// Dynamic form fields keyed by sub-provider ID
	pluginFields: Record<string, FormFieldDefinition[]>;
	// e.g., { "exa:websets": [...], "exa:search": [...], "tavily": [...] }

	// Which ConfigDto fields are handled by each sub-provider
	handledConfigFields: Record<string, string[]>;
	// e.g., { "exa:websets": ["*"], "exa:search": ["max_search_queries", "max_results_per_query"] }
}

interface SubProviderOption {
	id: string; // "exa:websets", "exa:search", "tavily"
	pluginId: string; // "exa", "tavily" (parent plugin)
	name: string; // "Exa Websets", "Exa Search", "Tavily"
	icon: PluginIcon; // Icon for dropdown display
	description?: string;
	isDefault?: boolean; // Mark directory default
	isInstalled: boolean; // User has configured the parent plugin
	handledConfigFields: string[]; // For UI to gray out fields
}
```

### Behavior: Full Pipeline vs Standard Pipeline

**When Full Pipeline is Selected (e.g., Exa.ai):**

```
User selects "Exa.ai" as Full Pipeline
    │
    ├─→ HIDE: Search, Screenshot, AI provider dropdowns
    │         (Exa handles everything internally)
    │
    ├─→ SHOW: Exa-specific form fields
    │         (from exa plugin's getFormFields())
    │
    └─→ On generate:
        └─→ Pipeline uses FullPipelineExecutor with Exa
            └─→ Exa.ai does search, extraction, categorization
```

**When Standard Pipeline is Selected:**

```
User selects "Standard Pipeline"
    │
    ├─→ SHOW: All provider category dropdowns
    │
    ├─→ SHOW: Form fields from ALL selected plugins
    │         (e.g., ScreenshotOne viewport options)
    │
    └─→ On generate:
        └─→ Pipeline uses StepPipelineExecutor
            ├─→ Search step uses selected search provider
            ├─→ Screenshot step uses selected screenshot provider
            └─→ AI steps use selected AI provider
```

### Plugin Form Fields (IFormFieldPlugin)

Each plugin can provide dynamic form fields:

```typescript
class ExaPlugin implements IFullPipelinePlugin, IFormFieldPlugin {
	getFormFields(): FormFieldDefinition[] {
		return [
			{
				id: 'searchDepth',
				type: 'select',
				label: 'Search Depth',
				options: [
					{ value: 'basic', label: 'Basic (faster)' },
					{ value: 'deep', label: 'Deep (more results)' }
				],
				defaultValue: 'basic'
			},
			{
				id: 'includeSimilar',
				type: 'checkbox',
				label: 'Include similar results',
				defaultValue: true
			}
		];
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		// Validate plugin-specific form inputs
		return { valid: true };
	}
}
```

### FormFieldDefinition Types

```typescript
interface FormFieldDefinition {
	id: string;
	type: 'text' | 'number' | 'checkbox' | 'select' | 'textarea' | 'url' | 'tags';
	label: string;
	description?: string;
	placeholder?: string;
	defaultValue?: unknown;
	required?: boolean;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
	};
	// For select type
	options?: { value: string; label: string }[];
	// For conditional display
	showWhen?: { field: string; value: unknown };
}
```

### Frontend Component: ProviderSelector

```tsx
// components/directories/detail/generator/ProviderSelector.tsx
interface ProviderSelectorProps {
	category: 'search' | 'screenshot' | 'ai' | 'fullPipeline';
	providers: ProviderOption[];
	value: string | null;
	onChange: (providerId: string | null) => void;
	defaultValue: string;
}

function ProviderSelector({ category, providers, value, onChange, defaultValue }: ProviderSelectorProps) {
	return (
		<Select value={value || defaultValue} onValueChange={onChange}>
			<SelectTrigger>
				<SelectValue>
					<PluginIcon icon={selectedProvider.icon} />
					{selectedProvider.name}
					{selectedProvider.isDefault && <Badge>Default</Badge>}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{providers.map((provider) => (
					<SelectItem key={provider.id} value={provider.id}>
						<PluginIcon icon={provider.icon} />
						{provider.name}
						{provider.isDefault && <Badge variant="outline">Default</Badge>}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
```

---

## Settings Resolution

Settings are resolved using a **4-level hierarchy**, with behavior controlled by the plugin's `configurationMode`:

```
When a plugin needs settings:

1. Plugin.defaultSettings       // Plugin's built-in defaults (hardcoded)
         ↓ merge
2. AdminPlugin.settings         // Platform-wide admin settings (database)
         ↓ merge
3. UserPlugin.settings          // User's configured values (database)
         ↓ merge
4. DirectoryPlugin.settings     // Directory-specific overrides (database)

NO environment variable fallback for user settings.
Environment variables are ONLY for OAuth configs and truly platform-level settings.
```

### Configuration Modes

Plugins declare how they can be configured via `configurationMode`:

| Mode               | Admin Settings    | User Settings     | Directory Settings | Use Case                          |
| ------------------ | ----------------- | ----------------- | ------------------ | --------------------------------- |
| `admin-only`       | Required          | Ignored           | Ignored            | Platform-provided shared API keys |
| `user-required`    | Ignored           | Required          | Optional           | Users must bring their own keys   |
| `hybrid` (default) | Optional fallback | Optional override | Optional override  | Most flexible                     |

**Resolution by Mode:**

```typescript
// admin-only: Stop at admin settings
settings = { ...pluginDefaults, ...adminSettings };

// user-required: Skip admin settings
settings = { ...pluginDefaults, ...userSettings, ...directorySettings };

// hybrid: Full chain
settings = { ...pluginDefaults, ...adminSettings, ...userSettings, ...directorySettings };
```

### Admin Settings Use Cases

| Scenario                             | Admin Settings | User Settings | Result             |
| ------------------------------------ | -------------- | ------------- | ------------------ |
| **Platform provides shared API key** | OpenAI key     | None          | Use admin key      |
| **User brings own key**              | Fallback key   | User key      | Use user key       |
| **Admin-only plugin**                | Configured     | Not allowed   | Use admin key only |
| **User-only plugin**                 | None           | Required      | Must have user key |

### Why This Architecture?

- **Admin settings layer** enables platform-provided defaults without env vars
- **configurationMode** allows plugins to declare their requirements
- Users configure through UI, not server access
- Multi-tenant SaaS: each user can have their own credentials
- Security: API keys stored encrypted in database, not env files

### Settings Schema with Security Markers

Plugins define their settings using a JSON Schema with additional security markers. These markers tell the platform how to handle sensitive fields:

```typescript
/**
 * Extended JSON Schema property with security markers.
 * Plugins use these to declare which fields need special handling.
 */
export interface JsonSchemaProperty {
	// Standard JSON Schema fields
	type: 'string' | 'number' | 'boolean' | 'object' | 'array';
	description?: string;
	title?: string;
	default?: unknown; // Use unknown instead of any for type safety
	enum?: readonly unknown[]; // Use unknown instead of any
	format?: string; // 'email', 'uri', 'password', etc.
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	pattern?: string;
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];

	// SECURITY MARKERS (Platform-specific extensions)

	/**
	 * Encrypt this field at rest in the database.
	 * Use for: API keys, tokens, secrets, passwords.
	 * Platform encrypts on save, decrypts on read (internal only).
	 */
	secret?: boolean;

	/**
	 * Display as "********" in UI forms (for existing values).
	 * Use for: Any field that shouldn't be readable after entry.
	 * Field is still editable - new values replace masked ones.
	 */
	masked?: boolean;

	/**
	 * Exclude from API GET responses entirely.
	 * Use for: Fields that should never leave the server.
	 * Combined with secret for maximum protection.
	 */
	writeOnly?: boolean;
}

export interface JsonSchema {
	type: 'object';
	properties: Record<string, JsonSchemaProperty>;
	required?: string[];
	title?: string;
	description?: string;
}
```

**Example Plugin Settings Schema:**

```typescript
class ScreenshotOnePlugin implements IPlugin, IScreenshotPlugin {
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			accessKey: {
				type: 'string',
				title: 'Access Key',
				description: 'Your ScreenshotOne API access key',
				secret: true, // Encrypt in database
				masked: true, // Show ******** in UI
				writeOnly: true // Never return via API
			},
			secretKey: {
				type: 'string',
				title: 'Secret Key',
				description: 'Your ScreenshotOne API secret key',
				secret: true,
				masked: true,
				writeOnly: true
			},
			defaultViewport: {
				type: 'object',
				title: 'Default Viewport',
				properties: {
					width: { type: 'number', default: 1280 },
					height: { type: 'number', default: 800 }
				}
			},
			cacheEnabled: {
				type: 'boolean',
				title: 'Enable Caching',
				default: true
				// No security markers - safe to display
			}
		},
		required: ['accessKey']
	};
}
```

**Platform Handling (PluginSettingsService):**

| Marker            | On Save       | On Internal Read | On API Response             |
| ----------------- | ------------- | ---------------- | --------------------------- |
| `secret: true`    | Encrypt field | Decrypt field    | (depends on other markers)  |
| `masked: true`    | (no change)   | (no change)      | Replace with "**\*\*\*\***" |
| `writeOnly: true` | (no change)   | (no change)      | Omit field entirely         |

Common combinations:

- `secret + masked + writeOnly`: Maximum security (API keys, passwords)
- `secret + masked`: Encrypted, masked in UI, but returned via API
- `masked` only: Not encrypted, but hidden in UI (e.g., webhook URLs)

---

## User Configuration Flow

### 1. User Installs Plugin

```
User: Settings > Plugins > Browse
    │
    ├─→ Sees available plugins (discovered from packages/plugins/)
    │
    ├─→ Clicks "Install" on ScreenshotOne
    │
    ├─→ UI shows form generated from plugin.settingsSchema:
    │   ┌─────────────────────────────────────────┐
    │   │ Access Key: [____________________]      │
    │   │ Secret Key: [____________________]      │
    │   │                                         │
    │   │ [Validate & Install]                    │
    │   └─────────────────────────────────────────┘
    │
    ├─→ API calls plugin.validateSettings(userInput)
    │
    └─→ Settings saved to UserPlugin entity (encrypted in DB)
```

### 2. User Enables Plugin for Directory

```
User: Directory > Apps
    │
    ├─→ Sees plugins they've installed
    │
    ├─→ Enables "ScreenshotOne" for this directory
    │
    └─→ Optionally configures directory-specific overrides:
        ┌─────────────────────────────────────────┐
        │ ☑ Custom viewport for this directory    │
        │   Width: [1920]  Height: [1080]         │
        └─────────────────────────────────────────┘
```

---

## Event System

Plugins can emit and listen to events for loose coupling and cross-plugin communication.

### Built-in Events

```typescript
// Plugin lifecycle events
'plugin:loaded'; // { pluginId: string }
'plugin:enabled'; // { pluginId: string, directoryId: string }
'plugin:disabled'; // { pluginId: string, directoryId: string }
'plugin:unloaded'; // { pluginId: string }
'plugin:error'; // { pluginId: string, error: Error }

// Pipeline events
'pipeline:started'; // { directoryId: string, generationId: string }
'pipeline:step:started'; // { stepName: string, directoryId: string }
'pipeline:step:completed'; // { stepName: string, directoryId: string, metrics: StepMetrics }
'pipeline:step:failed'; // { stepName: string, error: Error }
'pipeline:completed'; // { directoryId: string, metrics: PipelineMetrics }
'pipeline:failed'; // { directoryId: string, error: Error }

// Item events
'item:created'; // { directoryId: string, item: Item }
'item:updated'; // { directoryId: string, item: Item }
'item:deleted'; // { directoryId: string, itemId: string }

// Deployment events
'deployment:started'; // { directoryId: string, provider: string }
'deployment:completed'; // { directoryId: string, url: string }
'deployment:failed'; // { directoryId: string, error: Error }
```

### Using Events in Plugins

```typescript
class MyPlugin implements IPlugin {
	async onLoad(context: PluginContext) {
		// Listen to events
		context.onEvent('pipeline:completed', async (payload) => {
			const { directoryId, metrics } = payload;
			context.logger.log(`Pipeline completed: ${metrics.items_extracted} items`);

			// Maybe notify via custom capability
			const notifier = context.getCustomCapability<INotificationCapability>('notifications');
			if (notifier) {
				await notifier.send(`Generated ${metrics.items_extracted} items`, '#general');
			}
		});

		// Emit custom events
		context.emitEvent('my-plugin:initialized', { version: this.version });
	}
}
```

### Event Handler Registration

```typescript
// TYPE-SAFE event handling (see event-types.ts for full definitions)
interface PluginContext {
	// Register event handler (automatically cleaned up on plugin unload)
	onEvent<E extends PluginEventName>(
		event: E,
		handler: (payload: PluginEventPayloads[E]) => void | Promise<void>
	): () => void;

	// Emit event to all listeners
	emitEvent<E extends PluginEventName>(event: E, payload: PluginEventPayloads[E]): void;

	// Internal: EventEmitter2 instance
	eventEmitter: EventEmitter2;
}

// Example usage - fully typed!
context.onEvent('generation:completed', (payload) => {
	// payload is typed as { directoryId: string; generationId: string; itemCount: number }
	console.log(`Generated ${payload.itemCount} items for ${payload.directoryId}`);
});
```

---

## Error Handling & Boundaries

### Plugin Error Isolation

Plugins run in error boundaries to prevent one plugin from crashing the entire system:

```typescript
class PluginErrorBoundary {
	async executeWithBoundary<T>(pluginId: string, operation: string, fn: () => Promise<T>): Promise<T | null> {
		try {
			return await fn();
		} catch (error) {
			this.logger.error(`Plugin ${pluginId} error in ${operation}: ${error.message}`);

			// Emit error event
			this.eventEmitter.emit('plugin:error', {
				pluginId,
				operation,
				error,
				timestamp: new Date()
			});

			// Track error for plugin health
			this.pluginHealth.recordError(pluginId, error);

			// Return null - caller decides how to handle
			return null;
		}
	}
}
```

### Plugin Health Tracking

```typescript
interface PluginHealth {
	pluginId: string;
	status: 'healthy' | 'degraded' | 'unhealthy';
	errorCount: number;
	lastError?: {
		message: string;
		timestamp: Date;
		operation: string;
	};
	consecutiveFailures: number;
	lastSuccess?: Date;
}

// Auto-disable after too many failures
const MAX_CONSECUTIVE_FAILURES = 5;
```

### Graceful Degradation

```typescript
// In pipeline execution
class StepPipelineExecutor {
	async executeStep(step: PipelineStep, context: PipelineContext): Promise<void> {
		const plugin = this.registry.getPluginForStep(step.id);

		if (plugin) {
			const result = await this.errorBoundary.executeWithBoundary(plugin.id, `step:${step.id}`, () =>
				step.execute(context)
			);

			if (result === null) {
				// Plugin failed - check if step is required
				if (step.required) {
					throw new PipelineError(`Required step ${step.id} failed`);
				}
				// Optional step - continue without it
				this.logger.warn(`Skipping optional step ${step.id} due to plugin error`);
			}
		}
	}
}
```

### Retry Configuration

```typescript
interface PluginRetryConfig {
    maxRetries: number;           // Default: 3
    initialDelayMs: number;       // Default: 1000
    maxDelayMs: number;           // Default: 30000
    backoffMultiplier: number;    // Default: 2
    retryableErrors?: string[];   // Error types to retry
}

// Per-plugin retry config (in plugin manifest)
"everworks": {
    "plugin": {
        "id": "screenshotone",
        "retry": {
            "maxRetries": 3,
            "initialDelayMs": 2000,
            "retryableErrors": ["TIMEOUT", "RATE_LIMIT"]
        }
    }
}
```

---

## API Endpoints

### Plugin Management

```
GET    /plugins                      # List available plugins
GET    /plugins/:id                  # Get plugin details
POST   /plugins/:id/install          # Install plugin for user
DELETE /plugins/:id/uninstall        # Uninstall plugin

GET    /users/me/plugins             # List user's installed plugins
GET    /users/me/plugins/:id/settings      # Get plugin settings
PATCH  /users/me/plugins/:id/settings      # Update plugin settings
```

### Directory Plugin Management

```
GET    /directories/:id/plugins              # List enabled plugins
POST   /directories/:id/plugins/:pluginId    # Enable plugin for directory
DELETE /directories/:id/plugins/:pluginId    # Disable plugin
PATCH  /directories/:id/plugins/:pluginId/settings  # Directory overrides
```

### Generic Provider Endpoints

```
# Replaces /vercel/*, /github/*, etc.
POST   /deploy/:provider/deploy              # Deploy via provider
GET    /deploy/:provider/status/:id          # Get deployment status
GET    /deploy/:provider/teams               # Get provider teams
POST   /deploy/:provider/validate-token      # Validate provider token

# Git provider OAuth (for connecting user's git accounts, NOT app auth)
GET    /git/:provider/oauth/auth-url        # Get OAuth URL for git provider
POST   /git/:provider/oauth/callback        # Handle OAuth callback
```

---

## Database Schema

### Plugin Entity

```typescript
@Entity('plugins')
class Plugin {
	@PrimaryColumn()
	id: string; // e.g., "screenshotone"

	@Column()
	name: string;

	@Column()
	version: string;

	@Column()
	category: string;

	@Column('simple-json')
	capabilities: string[];

	@Column('simple-json')
	manifest: PluginManifest;

	@Column()
	path: string; // Filesystem path

	@Column()
	state: PluginState;

	@CreateDateColumn()
	loadedAt: Date;
}
```

### UserPlugin Entity

```typescript
@Entity('user_plugins')
class UserPlugin {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	userId: string;

	@ManyToOne(() => User)
	user: User;

	@Column()
	pluginId: string;

	@Column('simple-json')
	settings: Record<string, unknown>; // Encrypted

	@Column({ default: true })
	enabled: boolean;

	@CreateDateColumn()
	installedAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
```

### DirectoryPlugin Entity

```typescript
@Entity('directory_plugins')
class DirectoryPlugin {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	directoryId: string;

	@ManyToOne(() => Directory)
	directory: Directory;

	@Column()
	pluginId: string;

	@Column('simple-json', { nullable: true })
	settings: Record<string, unknown>; // Directory-specific overrides

	@Column({ default: true })
	enabled: boolean;

	@CreateDateColumn()
	enabledAt: Date;
}
```

---

## Built-in Plugins

| Plugin          | Category   | Capabilities                               | Description                     |
| --------------- | ---------- | ------------------------------------------ | ------------------------------- |
| `github`        | git        | `IGitProviderPlugin`, `IOAuthPlugin`       | GitHub repository management    |
| `gitlab`        | git        | `IGitProviderPlugin`, `IOAuthPlugin`       | GitLab repository management    |
| `bitbucket`     | git        | `IGitProviderPlugin`, `IOAuthPlugin`       | Bitbucket repository management |
| `vercel`        | deployment | `IDeploymentPlugin`                        | Vercel deployment               |
| `netlify`       | deployment | `IDeploymentPlugin`                        | Netlify deployment              |
| `screenshotone` | screenshot | `IScreenshotPlugin`                        | ScreenshotOne API               |
| `openai`        | ai         | `IAiProviderPlugin`                        | OpenAI GPT models               |
| `anthropic`     | ai         | `IAiProviderPlugin`                        | Anthropic Claude models         |
| `tavily`        | search     | `ISearchPlugin`, `IContentExtractorPlugin` | Tavily search API               |
| `exa`           | pipeline   | `IFullPipelinePlugin`, `ISearchPlugin`     | Exa.ai full pipeline            |

---

## Creating a Plugin

### Step 1: Create Package Structure

```bash
mkdir -p packages/plugins/my-plugin/src
cd packages/plugins/my-plugin
```

### Step 2: Create package.json

```json
{
	"name": "@ever-works/plugin-my-plugin",
	"version": "1.0.0",
	"main": "dist/index.js",
	"scripts": {
		"build": "tsc",
		"dev": "tsc --watch"
	},
	"peerDependencies": {
		"@ever-works/plugin": "^1.0.0"
	},
	"everworks": {
		"plugin": {
			"id": "my-plugin",
			"name": "My Plugin",
			"version": "1.0.0",
			"category": "screenshot",
			"capabilities": ["screenshot"],
			"description": "My custom screenshot plugin"
		}
	}
}
```

### Step 3: Implement Plugin Class

```typescript
// src/index.ts
import {
	IPlugin,
	IScreenshotPlugin,
	PluginContext,
	ScreenshotOptions,
	Screenshot,
	ValidationResult
} from '@ever-works/plugin';

export class MyPlugin implements IPlugin, IScreenshotPlugin {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly category = 'screenshot' as const;
	readonly capabilities = ['screenshot'];

	readonly settingsSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your API key'
			}
		},
		required: ['apiKey']
	};

	private context: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('My Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('My Plugin enabled for directory');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('My Plugin disabled');
	}

	async onUnload(): Promise<void> {
		// Cleanup
	}

	async validateSettings(settings: unknown): Promise<ValidationResult> {
		const { apiKey } = settings as { apiKey: string };
		if (!apiKey) {
			return { valid: false, message: 'API key is required' };
		}
		// Validate with actual API call if needed
		return { valid: true };
	}

	async capture(url: string, options: ScreenshotOptions): Promise<Screenshot> {
		const settings = await this.context.getSettings<{ apiKey: string }>();
		// Implement screenshot capture
		return {
			url: 'https://...',
			buffer: Buffer.from([])
		};
	}

	async bulkCapture(requests: BulkRequest[]): Promise<Screenshot[]> {
		return Promise.all(requests.map((r) => this.capture(r.url, r.options)));
	}
}

export default MyPlugin;
```

### Step 4: Build and Test

```bash
pnpm build
# Plugin will be auto-discovered on next server start
```

---

## Plugin Testing

Since plugins are standalone packages (not NestJS modules), they can be tested with simple unit tests.

### Unit Testing a Plugin

```typescript
// packages/plugins/screenshotone/src/__tests__/screenshotone.plugin.test.ts
import { ScreenshotOnePlugin } from '../screenshotone.plugin';
import { createMockPluginContext } from '@ever-works/plugin/testing';

describe('ScreenshotOnePlugin', () => {
	let plugin: ScreenshotOnePlugin;
	let mockContext: MockPluginContext;

	beforeEach(() => {
		plugin = new ScreenshotOnePlugin();
		mockContext = createMockPluginContext({
			settings: { accessKey: 'test-key', secretKey: 'test-secret' }
		});
	});

	describe('onLoad', () => {
		it('should load without errors', async () => {
			await expect(plugin.onLoad(mockContext)).resolves.not.toThrow();
		});
	});

	describe('validateSettings', () => {
		it('should validate correct settings', async () => {
			const result = await plugin.validateSettings({
				accessKey: 'valid-key',
				secretKey: 'valid-secret'
			});
			expect(result.valid).toBe(true);
		});

		it('should reject missing access key', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.message).toContain('Access key');
		});
	});

	describe('capture', () => {
		it('should capture screenshot', async () => {
			// Mock the external API
			jest.spyOn(plugin as any, 'callScreenshotOneApi').mockResolvedValue({
				url: 'https://cdn.screenshotone.com/image.png',
				buffer: Buffer.from('fake-image')
			});

			const result = await plugin.capture('https://example.com', {});

			expect(result.url).toBeDefined();
			expect(result.buffer).toBeInstanceOf(Buffer);
		});
	});
});
```

### Mock Plugin Context

```typescript
// packages/plugin/src/testing/mock-context.ts
export function createMockPluginContext(options?: {
	settings?: Record<string, unknown>;
	userSettings?: Record<string, unknown>;
	directorySettings?: Record<string, unknown>;
}): MockPluginContext {
	const eventHandlers = new Map<string, Function[]>();

	return {
		dataSource: createMockDataSource(),
		getRepository: jest.fn(),

		services: {
			directory: createMockDirectoryService(),
			user: createMockUserService()
		},

		getSettings: jest.fn().mockResolvedValue(options?.settings || {}),
		getUserSettings: jest.fn().mockResolvedValue(options?.userSettings || {}),
		getDirectorySettings: jest.fn().mockResolvedValue(options?.directorySettings || {}),

		onEvent: jest.fn((event, handler) => {
			const handlers = eventHandlers.get(event) || [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
			return () => {
				/* unsubscribe */
			};
		}),

		emitEvent: jest.fn((event, payload) => {
			const handlers = eventHandlers.get(event) || [];
			handlers.forEach((h) => h(payload));
		}),

		registerCustomCapability: jest.fn(),
		getCustomCapability: jest.fn(),
		hasCustomCapability: jest.fn().mockReturnValue(false),
		listCustomCapabilities: jest.fn().mockReturnValue([]),

		logger: {
			log: jest.fn(),
			error: jest.fn(),
			warn: jest.fn(),
			debug: jest.fn()
		},

		cache: createMockCacheManager()
	};
}
```

### Integration Testing

```typescript
// packages/plugins/screenshotone/src/__tests__/screenshotone.integration.test.ts
import { PluginTestHarness } from '@ever-works/plugin/testing';

describe('ScreenshotOnePlugin Integration', () => {
	let harness: PluginTestHarness;

	beforeAll(async () => {
		harness = await PluginTestHarness.create({
			plugins: ['screenshotone'],
			database: 'sqlite::memory:'
		});
	});

	afterAll(async () => {
		await harness.close();
	});

	it('should register as screenshot capability', async () => {
		const plugin = harness.getPlugin('screenshotone');
		expect(plugin.capabilities).toContain('screenshot');
	});

	it('should capture real screenshot (requires API key)', async () => {
		// Skip if no API key
		if (!process.env.SCREENSHOTONE_ACCESS_KEY) {
			return;
		}

		harness.setPluginSettings('screenshotone', {
			accessKey: process.env.SCREENSHOTONE_ACCESS_KEY,
			secretKey: process.env.SCREENSHOTONE_SECRET_KEY
		});

		const screenshot = await harness.executeCapability<IScreenshotPlugin>('screenshotone', 'capture', [
			'https://example.com',
			{}
		]);

		expect(screenshot.url).toMatch(/^https:\/\//);
	});
});
```

### Testing Pipeline Steps

```typescript
// packages/plugins/my-step-plugin/src/__tests__/my-step.test.ts
describe('MyStepPlugin', () => {
	it('should inject step after item-extraction', async () => {
		const plugin = new MyStepPlugin();
		const steps = plugin.getSteps();

		expect(steps).toHaveLength(1);
		expect(steps[0].id).toBe('my-custom-step');
		expect(plugin.getStepPosition()).toBe('after');
		expect(plugin.getTargetStep()).toBe('items-extraction');
	});

	it('should execute step correctly', async () => {
		const plugin = new MyStepPlugin();
		await plugin.onLoad(createMockPluginContext());

		const context = createMockGenerationContext({
			extractedWebItems: [{ name: 'Test Item', source_url: 'https://example.com' }]
		});

		const result = await plugin.getSteps()[0].execute(context);

		expect(result.extractedWebItems[0].customField).toBeDefined();
	});
});
```

---

## Security Considerations

### Plugin Sandboxing

Plugins run in the same Node.js process but with controlled access:

```typescript
interface PluginSandbox {
	// Plugins CANNOT access:
	// - Process environment directly (use context.getSettings())
	// - File system (except via approved APIs)
	// - Network directly (use context.http for approved requests)
	// - Other plugins' internal state
	// Plugins CAN access:
	// - PluginContext (controlled surface area)
	// - Their own settings (encrypted in database)
	// - Public custom capabilities
	// - Events (pub/sub model)
}
```

### Settings Encryption

```typescript
// User plugin settings are encrypted at rest
class PluginSettingsService {
	private readonly encryptionKey: string;

	async saveSettings(userId: string, pluginId: string, settings: unknown): Promise<void> {
		const encrypted = this.encrypt(JSON.stringify(settings));
		await this.userPluginRepo.update({ userId, pluginId }, { settings: encrypted });
	}

	async getSettings<T>(userId: string, pluginId: string): Promise<T> {
		const userPlugin = await this.userPluginRepo.findOne({ userId, pluginId });
		if (!userPlugin?.settings) return {} as T;
		return JSON.parse(this.decrypt(userPlugin.settings)) as T;
	}
}
```

### API Key Protection

```typescript
// Settings schema can mark fields as sensitive
const settingsSchema = {
	type: 'object',
	properties: {
		accessKey: {
			type: 'string',
			title: 'Access Key',
			format: 'password', // Hidden in UI
			sensitive: true // Never logged, masked in responses
		},
		secretKey: {
			type: 'string',
			title: 'Secret Key',
			format: 'password',
			sensitive: true
		}
	}
};

// Sensitive fields are:
// - Never included in API responses (masked as "***")
// - Never logged
// - Encrypted separately with stronger keys
```

### Plugin Validation

```typescript
// Before loading a plugin, validate:
class PluginValidator {
	async validate(pluginPath: string): Promise<ValidationResult> {
		const checks = [
			this.checkPackageJson(pluginPath),
			this.checkNoMaliciousDeps(pluginPath),
			this.checkEntryPoint(pluginPath),
			this.checkExportedClass(pluginPath),
			this.checkNoDirectEnvAccess(pluginPath)
		];

		const results = await Promise.all(checks);
		return this.aggregateResults(results);
	}

	private async checkNoMaliciousDeps(path: string): Promise<CheckResult> {
		const pkg = await this.readPackageJson(path);
		const blockedPackages = ['child_process', 'eval', 'vm2'];

		for (const dep of Object.keys(pkg.dependencies || {})) {
			if (blockedPackages.includes(dep)) {
				return { passed: false, message: `Blocked dependency: ${dep}` };
			}
		}
		return { passed: true };
	}
}
```

### Rate Limiting

```typescript
// Per-plugin rate limits
interface PluginRateLimits {
	pluginId: string;
	limits: {
		requestsPerMinute: number; // Default: 100
		requestsPerHour: number; // Default: 1000
		concurrentRequests: number; // Default: 10
	};
}

// Applied when plugin makes external API calls
class PluginHttpClient {
	async request(pluginId: string, url: string, options: RequestOptions): Promise<Response> {
		await this.rateLimiter.checkLimit(pluginId);
		return this.httpClient.request(url, options);
	}
}
```

### Audit Logging

```typescript
// Log all plugin operations for security audit
interface PluginAuditLog {
	timestamp: Date;
	pluginId: string;
	userId?: string;
	directoryId?: string;
	operation: string; // 'capture', 'deploy', 'search', etc.
	input?: object; // Sanitized input (no sensitive data)
	result: 'success' | 'failure';
	errorMessage?: string;
	durationMs: number;
}
```

---

## Migration Strategy

### Phase 1: Foundation

- Create `plugin` package
- Create plugin runtime in `agent`
- Create plugin entities

### Phase 2: Extract Built-in Plugins

- Move GitHub code to `plugins/github`
- Move Vercel code to `plugins/vercel`
- Move ScreenshotOne code to `plugins/screenshotone`

### Phase 3: Create Facades

- Create `GitFacade` that uses plugin registry
- Create `DeployFacade` that uses plugin registry
- Update consumers to use facades

### Phase 4: Refactor API

- Replace `/vercel/*` with `/deploy/:provider/*`
- Replace GitHub OAuth (for git repo access) with plugin-based Git OAuth
- Add plugin management endpoints

### Phase 5: Refactor Frontend

- Replace hardcoded provider components
- Add plugin settings UI
- Add directory apps management

---

## Testing Infrastructure

All plugin code must be testable with comprehensive test coverage. The plugin system provides testing utilities and patterns to make testing easy.

### Test Utilities Package

```typescript
// packages/plugin-test-utils/src/index.ts

/**
 * Create a mock PluginContext for testing
 */
export function createMockPluginContext(overrides?: Partial<PluginContext>): PluginContext {
	return {
		dataSource: createMockDataSource(),
		getRepository: jest.fn(),
		services: createMockServices(),
		eventEmitter: new EventEmitter2(),
		onEvent: jest.fn(),
		emitEvent: jest.fn(),
		getSettings: jest.fn().mockResolvedValue({}),
		getUserSettings: jest.fn().mockResolvedValue({}),
		getDirectorySettings: jest.fn().mockResolvedValue({}),
		env: createMockPluginEnvironment(),
		registerController: jest.fn(),
		registerCustomCapability: jest.fn(),
		getCustomCapability: jest.fn(),
		hasCustomCapability: jest.fn().mockReturnValue(false),
		listCustomCapabilities: jest.fn().mockReturnValue([]),
		logger: createMockLogger(),
		cache: createMockCache(),
		...overrides
	};
}

/**
 * Create a mock PluginEnvironment for testing
 */
export function createMockPluginEnvironment(envVars: Record<string, string> = {}): PluginEnvironment {
	return {
		get: (name) => envVars[name],
		getRequired: (name) => {
			if (!(name in envVars)) {
				throw new Error(`Missing required env var: ${name}`);
			}
			return envVars[name];
		},
		has: (name) => name in envVars,
		getAll: () => envVars
	};
}

/**
 * Base test suite for any plugin - validates IPlugin compliance
 */
export function createPluginContractTests(PluginClass: new () => IPlugin, testEnvVars: Record<string, string> = {}) {
	describe(`${PluginClass.name} Contract Tests`, () => {
		let plugin: IPlugin;
		let mockContext: PluginContext;

		beforeEach(() => {
			plugin = new PluginClass();
			mockContext = createMockPluginContext({
				env: createMockPluginEnvironment(testEnvVars)
			});
		});

		it('should have required metadata', () => {
			expect(plugin.id).toBeDefined();
			expect(plugin.name).toBeDefined();
			expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(plugin.category).toBeDefined();
		});

		it('should have settings schema', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
		});

		it('should implement lifecycle hooks', () => {
			expect(typeof plugin.onLoad).toBe('function');
			expect(typeof plugin.onEnable).toBe('function');
			expect(typeof plugin.onDisable).toBe('function');
			expect(typeof plugin.onUnload).toBe('function');
		});

		it('should load without errors', async () => {
			await expect(plugin.onLoad(mockContext)).resolves.not.toThrow();
		});

		it('should validate settings', async () => {
			const result = await plugin.validateSettings({});
			expect(result).toHaveProperty('valid');
		});
	});
}
```

### Example Plugin Test with Mock Environment

```typescript
// packages/plugins/github/src/__tests__/github.plugin.spec.ts
import { GitHubPlugin } from '../github.plugin';
import {
	createMockPluginContext,
	createMockPluginEnvironment,
	createPluginContractTests
} from '@ever-works/plugin-test-utils';

// Run standard contract tests
createPluginContractTests(GitHubPlugin, {
	GH_CLIENT_ID: 'test-client-id',
	GH_CLIENT_SECRET: 'test-client-secret',
	GH_CALLBACK_URL: 'http://localhost:3000/callback'
});

describe('GitHubPlugin', () => {
	let plugin: GitHubPlugin;
	let mockContext: PluginContext;
	let mockOctokit: jest.Mocked<Octokit>;

	beforeEach(() => {
		mockOctokit = createMockOctokit();
		plugin = new GitHubPlugin();
		mockContext = createMockPluginContext({
			env: createMockPluginEnvironment({
				GH_CLIENT_ID: 'test-client-id',
				GH_CLIENT_SECRET: 'test-secret',
				GH_CALLBACK_URL: 'http://localhost/callback'
			})
		});
		// Inject mock Octokit
		plugin['octokit'] = mockOctokit;
	});

	describe('createRepository', () => {
		it('should create a repository', async () => {
			mockOctokit.repos.createForAuthenticatedUser.mockResolvedValue({
				data: { id: 123, name: 'test-repo', html_url: 'https://github.com/user/test-repo' }
			});

			const result = await plugin.createRepository({
				name: 'test-repo',
				description: 'Test description'
			});

			expect(result.name).toBe('test-repo');
			expect(mockOctokit.repos.createForAuthenticatedUser).toHaveBeenCalledWith({
				name: 'test-repo',
				description: 'Test description'
			});
		});

		it('should handle errors gracefully', async () => {
			mockOctokit.repos.createForAuthenticatedUser.mockRejectedValue(new Error('Rate limit exceeded'));

			await expect(plugin.createRepository({ name: 'test' })).rejects.toThrow('Rate limit exceeded');
		});
	});

	describe('OAuth flow', () => {
		it('should generate correct OAuth URL', async () => {
			const url = await plugin.getAuthUrl({ state: 'test-state' });

			expect(url).toContain('client_id=test-client-id');
			expect(url).toContain('state=test-state');
			expect(url).toContain('scope=');
		});

		it('should handle OAuth callback', async () => {
			// Mock token exchange
			const mockTokenResponse = { access_token: 'gho_xxxx', token_type: 'bearer' };
			jest.spyOn(global, 'fetch').mockResolvedValue({
				json: () => Promise.resolve(mockTokenResponse)
			} as Response);

			const result = await plugin.handleCallback({ code: 'auth-code' });

			expect(result.accessToken).toBe('gho_xxxx');
		});
	});
});
```

### Testing Requirements

| Component               | Coverage Target | Test Type                             |
| ----------------------- | --------------- | ------------------------------------- |
| `plugin`                | 80%             | Unit tests for type guards, utilities |
| Plugin runtime services | 80%             | Unit tests with mocks                 |
| Built-in plugins        | 80%             | Unit tests, integration tests         |
| Pipeline builder        | 90%             | Unit tests for step ordering          |
| Service facades         | 80%             | Unit tests                            |

### CI Pipeline Integration

All plugin tests must pass in CI before merge:

```yaml
# .github/workflows/plugin-tests.yml
name: Plugin Tests
on: [push, pull_request]
jobs:
    test-plugins:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v2
            - uses: actions/setup-node@v4
              with:
                  node-version: '20'
                  cache: 'pnpm'
            - run: pnpm install
            - run: pnpm --filter "@ever-works/plugin-*" test
            - run: pnpm --filter "@ever-works/plugin-*" test:cov
            # Fail if coverage below 80%
            - run: |
                  for pkg in packages/plugins/*/; do
                    coverage=$(cat $pkg/coverage/coverage-summary.json | jq '.total.lines.pct')
                    if (( $(echo "$coverage < 80" | bc -l) )); then
                      echo "Coverage for $pkg is $coverage%, required 80%"
                      exit 1
                    fi
                  done
```

---

## Migration from Hardcoded Infrastructure

This section documents the mapping from current hardcoded entity fields to the plugin system entities. These migrations will occur as facades are implemented in Phase 6.

### User Entity Migrations

The following fields in `packages/agent/src/entities/user.entity.ts` will migrate to `UserPlugin`:

| Current Field            | Type     | Migration Target                    | Plugin        |
| ------------------------ | -------- | ----------------------------------- | ------------- |
| `vercelToken`            | `string` | `UserPlugin.settings.apiToken`      | vercel        |
| `screenshotoneAccessKey` | `string` | `UserPlugin.settings.accessKey`     | screenshotone |
| `screenshotoneSecretKey` | `string` | `UserPlugin.settings.secretKey`     | screenshotone |
| `registrationProvider`   | `string` | **Keep** (auth concern, not plugin) | N/A           |

**Methods to Refactor:**

| Current Method               | Location             | Migration Target                             |
| ---------------------------- | -------------------- | -------------------------------------------- |
| `User.getGitToken(provider)` | `user.entity.ts:114` | `GitFacade.getToken(userId, providerId)`     |
| `User.asCommitter(provider)` | `user.entity.ts:138` | `GitFacade.getCommitter(userId, providerId)` |

### OAuthToken Entity Migration

The **entire** `OAuthToken` entity (`packages/agent/src/entities/oauth-token.entity.ts`) migrates to `UserPlugin`:

| Current Field  | Migration Target                   |
| -------------- | ---------------------------------- |
| `provider`     | `UserPlugin.pluginId`              |
| `accessToken`  | `UserPlugin.settings.accessToken`  |
| `refreshToken` | `UserPlugin.settings.refreshToken` |
| `scope`        | `UserPlugin.settings.scope`        |
| `expiresAt`    | `UserPlugin.settings.expiresAt`    |
| `username`     | `UserPlugin.settings.username`     |
| `email`        | `UserPlugin.settings.email`        |
| `metadata`     | `UserPlugin.settings.metadata`     |

After migration, `User.oauthTokens[]` relationship is removed and replaced with `UserPlugin` lookups.

### Directory Entity Migrations

The following fields in `packages/agent/src/entities/directory.entity.ts` will migrate:

| Current Field      | Type     | Migration Target                                | Notes                        |
| ------------------ | -------- | ----------------------------------------------- | ---------------------------- |
| `repoProvider`     | `string` | `DirectoryPlugin` with capability defaults      | Stores selected git provider |
| `sourceRepository` | `JSON`   | `DirectoryPlugin.settings` (data-source plugin) | Import source metadata       |
| `lastPullRequest`  | `JSON`   | `DirectoryPlugin.settings` (git plugin)         | PR tracking per provider     |

**Methods to Refactor:**

| Current Method             | Location                  | Migration Target                              |
| -------------------------- | ------------------------- | --------------------------------------------- |
| `Directory.getRepoOwner()` | `directory.entity.ts:168` | `GitFacade.getRepoOwner(directoryId, userId)` |

### DirectorySchedule Entity Migrations

| Current Field             | Migration Target                        | Notes           |
| ------------------------- | --------------------------------------- | --------------- |
| `alwaysCreatePullRequest` | `DirectoryPlugin.settings` (git plugin) | Git PR behavior |

### Future Migrations (Billing)

The following fields are **future scope** and will be addressed when billing plugins are implemented:

| Entity             | Field               | Future Plugin           |
| ------------------ | ------------------- | ----------------------- |
| `UserSubscription` | `billingProvider`   | billing plugin          |
| `UserSubscription` | `paymentMethodMeta` | billing plugin settings |

### DirectoryPlugin Provider Defaults

The `DirectoryPlugin` entity will store default provider selections per capability:

```typescript
// DirectoryPlugin.settings structure for capability defaults
interface DirectoryCapabilityDefaults {
	defaults: {
		'git-provider'?: string; // "github" | "gitlab" | "bitbucket"
		deployment?: string; // "vercel" | "netlify" | "railway"
		screenshot?: string; // "screenshotone" | "playwright"
		search?: string; // "tavily" | "exa:search" | "serpapi"
		'ai-provider'?: string; // "openai" | "anthropic" | "gemini"
		'full-pipeline'?: string; // null = standard, "exa:websets" = full
	};
}
```

### Facade Resolution Flow

All facades follow this pattern for resolving which plugin to use:

```typescript
@Injectable()
export class [Capability]Facade {
    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    private async getPlugin(
        directoryId: string,
        providerOverride?: string  // From GenerationOptions.providers
    ): Promise<I[Capability]Plugin> {
        // 1. Determine which provider to use
        const providerId = providerOverride
            ?? await this.settingsService.getDirectoryProvider(directoryId, '[capability]')
            ?? await this.settingsService.getPlatformDefault('[capability]');

        // 2. Get plugin from registry
        return this.registry.getByCapability<I[Capability]Plugin>(
            '[capability]',
            providerId
        );
    }

    private async getSettings(
        userId: string,
        directoryId: string,
        pluginId: string
    ): Promise<PluginSettings> {
        // Resolves: plugin defaults → admin → user → directory
        return this.settingsService.resolveSettings(userId, directoryId, pluginId);
    }
}
```

### Settings Storage After Migration

```
┌──────────────────────────────────────────────────────────────────────┐
│ BEFORE (Hardcoded)                                                    │
├──────────────────────────────────────────────────────────────────────┤
│ User.vercelToken          → Direct column on User entity             │
│ User.screenshotoneKeys    → Direct columns on User entity            │
│ User.oauthTokens[]        → Separate OAuthToken entity               │
│ Directory.repoProvider    → Direct column on Directory entity        │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ AFTER (Plugin System)                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ UserPlugin (userId, pluginId, settings)                              │
│   ├─ userId: "user-123"                                              │
│   ├─ pluginId: "github"                                              │
│   └─ settings: { accessToken, refreshToken, username, ... }          │
│                                                                       │
│ DirectoryPlugin (directoryId, pluginId, settings)                    │
│   ├─ directoryId: "dir-456"                                          │
│   ├─ pluginId: "github"                                              │
│   └─ settings: { defaults: { 'git-provider': 'github' } }            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Key Principles

### Architecture Principles

1. **Plugins are standalone packages** - Pure TypeScript, NO NestJS dependencies, own package.json and build
2. **Plugins get context, not DI** - All services accessed via `PluginContext`, not dependency injection
3. **No env fallback for user settings** - Users configure through UI, encrypted in database
4. **Same output format** - All plugins output standard types (Item[], Screenshot, etc.)
5. **Facades hide complexity** - Services use facades, facades use plugin registry
6. **Backwards compatible** - Existing functionality works during incremental migration

### Capability Principles

7. **Core capabilities are fixed** - `IGitProviderPlugin`, `IScreenshotPlugin`, etc. are versioned interfaces
8. **Custom capabilities enable extensibility** - Plugin-to-plugin communication via dynamic registry
9. **Capabilities have icons** - Every plugin provides an icon for UI display

### Pipeline Principles

10. **Pipeline is plugin-driven** - Full pipeline replacement OR step injection/replacement
11. **Provider selection at generation time** - Users choose providers per generation, not just per directory
12. **Form fields are dynamic** - Plugins provide form fields via `IFormFieldPlugin`

### Security Principles

13. **Error isolation** - Plugin errors don't crash the system (error boundaries)
14. **Settings encryption** - API keys encrypted at rest, never logged
15. **Plugin validation** - Plugins validated before loading (no malicious deps)

### Development Principles

16. **Simple testing** - Plugins testable with plain Jest, no NestJS TestingModule
17. **Event-driven integration** - Loose coupling via events for cross-plugin communication
18. **Health tracking** - Auto-disable plugins after consecutive failures

### Testing Principles

19. **Dependency injection everywhere** - All services use DI, no hard dependencies
20. **Environment vars via context** - Plugins access env vars through `context.env`, NEVER `process.env` directly
21. **Mock factories provided** - `@ever-works/plugin-test-utils` provides mock factories for all core types
22. **Contract tests for plugins** - Base test suite validates IPlugin compliance
23. **Unit tests for all services** - Every service has corresponding `.spec.ts` file
24. **Integration tests for flows** - E2E tests for plugin loading → usage → results
25. **Test coverage requirements** - Minimum 80% coverage for plugin, plugin-runtime, built-in plugins

---

## Appendix: File Locations Reference

| Component                 | Location                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| Plugin Contracts          | `packages/plugin/src/`                                                 |
| Plugin Runtime            | `packages/agent/src/plugins/`                                          |
| Service Facades           | `packages/agent/src/facades/`                                          |
| Pipeline Factory          | `packages/agent/src/pipeline/`                                         |
| Built-in Plugins          | `packages/plugins/*/`                                                  |
| Current Pipeline          | `packages/agent/src/items-generator/pipeline/`                         |
| Current Steps             | `packages/agent/src/items-generator/pipeline/steps/`                   |
| Generator DTO             | `packages/agent/src/items-generator/dto/create-items-generator.dto.ts` |
| Generator Form (Frontend) | `apps/web/src/components/directories/detail/generator/`                |

---
