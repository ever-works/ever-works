# @ever-works/plugin Package Guide

> **Complete guide for using the `@ever-works/plugin` package to build plugins for the Ever Works platform.**

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Package Structure](#package-structure)
4. [Core Interfaces](#core-interfaces)
5. [Capability Interfaces](#capability-interfaces)
6. [Abstract Base Classes](#abstract-base-classes)
7. [Pipeline Types](#pipeline-types)
8. [Settings & Configuration](#settings--configuration)
9. [Testing Utilities](#testing-utilities)
10. [Helper Functions](#helper-functions)
11. [Quick Start Examples](#quick-start-examples)
12. [API Reference](#api-reference)

---

## Overview

The `@ever-works/plugin` package is the contracts library for the Ever Works plugin system. It provides:

- **Type-safe interfaces** for all plugin capabilities
- **Abstract base classes** to reduce boilerplate
- **Testing utilities** for unit testing plugins
- **Helper functions** for common operations
- **Pipeline types** for content generation customization

All plugins in the Ever Works ecosystem must implement interfaces from this package.

### Key Principles

1. **Type Safety** - All interfaces are strongly typed with TypeScript
2. **Contract-First** - Plugins implement contracts, not concrete classes
3. **Testability** - Mock factories make testing easy
4. **Extensibility** - Support for custom capabilities

---

## Installation

```bash
# Using pnpm (required for Ever Works)
pnpm add @ever-works/plugin

# For development/testing
pnpm add -D @ever-works/plugin
```

### Requirements

- Node.js ≥ 20
- TypeScript ≥ 5.0
- ES2021 target

### Package.json Setup

When creating a plugin package, ensure your `package.json` exports are ordered correctly. **The `types` condition must come FIRST** to avoid build warnings:

```json
{
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.mjs",
			"require": "./dist/index.js"
		}
	}
}
```

> **Warning:** If `types` is not first, bundlers like esbuild will warn: `The condition "types" here will never be used`. This ordering ensures TypeScript finds type definitions before resolving the actual module.

---

## Package Structure

The package is organized into modules that can be imported individually:

```
@ever-works/plugin
├── /contracts      # Core plugin interfaces
├── /pipeline       # Pipeline step types
├── /events         # Event system types
├── /settings       # Settings and configuration
├── /common         # Shared domain types
├── /helpers        # Utility functions
├── /abstract       # Base classes
└── /testing        # Test utilities
```

### Import Patterns

```typescript
// Import everything
import {
	IPlugin,
	BasePlugin,
	createMockPluginContext
	// ... etc
} from '@ever-works/plugin';

// Import from specific modules (recommended for tree-shaking)
import type { IPlugin, IGitProviderPlugin } from '@ever-works/plugin/contracts';
import { BasePlugin } from '@ever-works/plugin/abstract';
import { createMockPluginContext } from '@ever-works/plugin/testing';
```

---

## Core Interfaces

### IPlugin

The base interface that ALL plugins must implement:

```typescript
import type { IPlugin, PluginContext, JsonSchema, ValidationResult } from '@ever-works/plugin';

interface IPlugin {
	// Required metadata
	readonly id: string; // Unique identifier (e.g., 'github')
	readonly name: string; // Display name
	readonly version: string; // Semver version
	readonly category: PluginCategory; // Primary category
	readonly capabilities: readonly string[]; // List of capabilities

	// Settings
	readonly settingsSchema: JsonSchema; // JSON Schema for settings form
	readonly configurationMode?: ConfigurationMode; // 'admin-only' | 'user-required' | 'hybrid'

	// Lifecycle hooks
	onLoad(context: PluginContext): Promise<void>;
	onEnable(context: PluginContext): Promise<void>;
	onDisable(context: PluginContext): Promise<void>;
	onUnload(): Promise<void>;

	// Validation
	validateSettings(settings: PluginSettings): Promise<ValidationResult>;

	// Optional
	healthCheck?(): Promise<PluginHealthCheck>;
	getManifest?(): PluginManifest;
}
```

### PluginContext

The context object passed to plugins, providing access to platform services:

```typescript
interface PluginContext {
	// Plugin identity
	readonly pluginId: string;

	// Services
	readonly logger: PluginLogger; // Structured logging
	readonly cache: PluginCache; // Key-value caching
	readonly http: PluginHttpClient; // HTTP client
	readonly env: PluginEnvironment; // Environment info
	readonly services: PluginServices; // Platform services

	// Settings
	getSettings(scope?: SettingScope, scopeId?: string): Promise<PluginSettings>;
	getResolvedSettings(scope?: SettingScope, scopeId?: string): Promise<ResolvedSettings>;

	// Events
	onEvent<T extends PluginEventName>(event: T, handler: EventHandler<T>): EventSubscription;
	emitEvent<T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]): void;

	// Custom capabilities
	registerCustomCapability(def: CustomCapabilityDefinition, impl: unknown): void;
	getCustomCapability<T>(name: string): T | undefined;
	hasCustomCapability(name: string): boolean;
	listCustomCapabilities(): readonly CustomCapabilityDefinition[];
}
```

### PluginCategory

Available plugin categories:

```typescript
type PluginCategory =
	| 'git-provider' // GitHub, GitLab, Bitbucket
	| 'deployment' // Vercel, Netlify
	| 'screenshot' // ScreenshotOne, Playwright
	| 'search' // Tavily, Exa
	| 'content-extractor' // Firecrawl, local scraper
	| 'data-source' // Notion, Airtable
	| 'ai-provider' // OpenAI, Anthropic
	| 'pipeline' // Pipeline modifications
	| 'form' // Custom form fields
	| 'integration' // External integrations
	| 'utility' // General utilities
	| 'theme'; // UI themes
```

---

## Capability Interfaces

### IGitProviderPlugin

For Git hosting providers (GitHub, GitLab, Bitbucket):

```typescript
interface IGitProviderPlugin extends IPlugin {
	readonly providerName: string;

	// Authentication
	getAuth(token: string): GitAuth;
	getCloneUrl(owner: string, repo: string): string;
	getWebUrl(owner: string, repo: string): string;

	// Repository operations
	createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository>;
	getRepository(owner: string, repo: string, token: string): Promise<GitRepository | null>;
	deleteRepository(owner: string, repo: string, token: string): Promise<void>;

	// User & organization
	getUser(token: string): Promise<GitUser>;
	getOrganizations(token: string): Promise<GitOrganization[]>;

	// Branch operations
	listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]>;

	// Pull requests
	createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest>;
	mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult>;
}
```

### IDeploymentPlugin

For deployment providers (Vercel, Netlify):

```typescript
interface IDeploymentPlugin extends IPlugin {
	readonly providerName: string;

	deploy(options: DeploymentOptions): Promise<DeploymentResult>;
	getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus>;
	cancelDeployment(deploymentId: string): Promise<void>;
	listDeployments(projectId?: string): Promise<DeploymentInfo[]>;
	getDeploymentUrl(deploymentId: string): Promise<string | null>;
	listTeams(): Promise<DeploymentTeam[]>;
}
```

### IScreenshotPlugin

For screenshot services:

```typescript
interface IScreenshotPlugin extends IPlugin {
	capture(url: string, options: ScreenshotOptions): Promise<ScreenshotResult>;
	captureBulk?(urls: string[], options: ScreenshotOptions): Promise<ScreenshotResult[]>;
	getSupportedFormats(): readonly string[];
}
```

### ISearchPlugin

For search providers (Tavily, Exa):

```typescript
interface ISearchPlugin extends IPlugin {
	readonly providerName: string;

	search(query: string, options?: SearchOptions): Promise<SearchResponse>;
	searchBulk?(queries: string[], options?: SearchOptions): Promise<SearchResponse[]>;
}
```

### IAiProviderPlugin

For AI/LLM providers:

```typescript
interface IAiProviderPlugin extends IPlugin {
	readonly providerType: AiProviderType;
	readonly providerName: string;

	createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;
	createStreamingChatCompletion?(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk>;
	createEmbedding?(options: EmbeddingOptions): Promise<EmbeddingResponse>;
	listModels(): Promise<readonly AiModel[]>;
	getModel(modelId: string): Promise<AiModel | null>;
	isAvailable(): Promise<boolean>;
	getCapabilities(): AiModelCapabilities;
}
```

### IPipelineStepPlugin

For custom pipeline steps:

```typescript
interface IPipelineStepPlugin extends IPlugin {
	getStepDefinitions(): readonly PipelineStepDefinition[];
	executeStep(stepId: string, context: GenerationContext): Promise<StepExecutionResult>;
	canHandleStep(stepId: string): boolean;
}
```

### IFullPipelinePlugin

For complete pipeline replacements:

```typescript
interface IFullPipelinePlugin extends IPlugin {
	readonly pipelineId: string;
	readonly pipelineName: string;

	getPipelineDefinition(): PipelineDefinition;
	executePipeline(context: GenerationContext): Promise<PipelineResult>;
	canExecute(context: GenerationContext): Promise<boolean>;
	getHandledConfigFields(): readonly string[];
}
```

### Other Capability Interfaces

| Interface                 | Capability          | Purpose                             |
| ------------------------- | ------------------- | ----------------------------------- |
| `IContentExtractorPlugin` | `content-extractor` | Extract content from web pages      |
| `IDataSourcePlugin`       | `data-source`       | Import data from external systems   |
| `IOAuthPlugin`            | `oauth`             | OAuth authentication flows          |
| `IFormFieldPlugin`        | `form-field`        | Custom form field types             |
| `ISubProviderPlugin`      | `sub-provider`      | Sub-implementations of capabilities |
| `IConfigAwarePlugin`      | `config-aware`      | Plugins that manage config fields   |

---

## Abstract Base Classes

Base classes reduce boilerplate by providing sensible defaults.

### BasePlugin

```typescript
import { BasePlugin } from '@ever-works/plugin';

class MyPlugin extends BasePlugin {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly category = 'utility' as const;
	readonly capabilities = ['my-capability'];

	readonly settingsSchema = {
		type: 'object' as const,
		properties: {
			apiKey: { type: 'string', 'x-secret': true }
		},
		required: ['apiKey']
	};

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context); // Sets this.context
		this.log('Plugin loaded');
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		if (!settings.apiKey) {
			return { valid: false, errors: [{ field: 'apiKey', message: 'API key is required' }] };
		}
		return { valid: true };
	}
}
```

**Built-in helpers in BasePlugin:**

```typescript
// Logging
this.log('Info message');
this.logError('Error message');
this.logWarn('Warning');
this.logDebug('Debug info');

// Context access
this.context; // Full context
this.logger; // Logger instance
this.cache; // Cache instance
this.http; // HTTP client
this.env; // Environment

// Settings
const settings = await this.getSettings();

// Events
this.emitEvent('plugin:custom', { data: 'value' });
```

### BaseGitProvider

For Git provider plugins - implements all local git operations:

```typescript
import { BaseGitProvider, IGitProviderPlugin } from '@ever-works/plugin';

class GitHubPlugin extends BaseGitProvider implements IGitProviderPlugin {
	readonly id = 'github';
	readonly name = 'GitHub';
	readonly version = '1.0.0';
	readonly category = 'git-provider' as const;
	readonly capabilities = ['git-provider', 'oauth'];
	readonly providerName = 'github';

	// BaseGitProvider implements: clone, pull, push, commit, etc.
	// You only implement provider-specific API operations:

	getAuth(token: string): GitAuth {
		return { username: 'x-access-token', password: token };
	}

	getCloneUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}.git`;
	}

	getWebUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}`;
	}

	async createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository> {
		// GitHub API call
	}

	// ... other API methods
}
```

### BaseAiProvider

For AI provider plugins:

```typescript
import { BaseAiProvider } from '@ever-works/plugin';

class OpenAIPlugin extends BaseAiProvider {
	readonly providerType = 'openai' as const;
	readonly providerName = 'OpenAI';

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		// Implementation
	}

	async listModels(): Promise<readonly AiModel[]> {
		// Implementation
	}
}
```

### BasePipelineStep

For pipeline step plugins. This abstract class provides helper methods for defining step positions with type safety.

```typescript
import { BasePipelineStep, PipelineStepDefinition, StepExecutionResult } from '@ever-works/plugin';
import { BuiltInStepId } from '@ever-works/default-pipeline-plugin';

class MyStep extends BasePipelineStep {
	readonly stepId = 'my-plugin:my-step';
	readonly stepName = 'My Custom Step';

	getStepDefinition(): PipelineStepDefinition {
		return {
			id: this.stepId,
			name: this.stepName,
			// Use the type-safe helper method with BuiltInStepId
			position: BasePipelineStep.after<BuiltInStepId>('items-extraction'),
			provides: ['enriched-items'],
			requires: ['extracted-items']
		};
	}

	async execute(context: GenerationContext): Promise<StepExecutionResult> {
		const items = context.getStepResult('extracted-items');
		// Process items...
		return { success: true, data: { 'enriched-items': enrichedItems } };
	}
}
```

**BasePipelineStep Static Helpers:**

```typescript
// These methods are generic and accept any step ID type
BasePipelineStep.before<BuiltInStepId>('web-search'); // { type: 'before', stepId: 'web-search' }
BasePipelineStep.after<BuiltInStepId>('items-extraction'); // { type: 'after', stepId: 'items-extraction' }
BasePipelineStep.replace<BuiltInStepId>('image-capture'); // { type: 'replace', stepId: 'image-capture' }
BasePipelineStep.first(); // { type: 'first' }
BasePipelineStep.last(); // { type: 'last' }

// For custom pipelines with different step IDs:
type CustomStepId = 'step-a' | 'step-b' | 'step-c';
BasePipelineStep.after<CustomStepId>('step-b'); // Type-safe for custom pipelines
```

---

## Pipeline Types

### PipelineStepDefinition

```typescript
interface PipelineStepDefinition {
	readonly id: string; // Unique step ID
	readonly name: string; // Display name
	readonly description?: string; // Step description
	readonly position: StepPosition; // Where to insert
	readonly dependencies?: readonly StepDependency[]; // Required steps
	readonly optional?: boolean; // Can be skipped?
	readonly parallelizable?: boolean; // Can run in parallel?
	readonly settingsSchema?: JsonSchema; // Step config schema
	readonly provides?: readonly string[]; // Data keys produced
	readonly requires?: readonly string[]; // Data keys needed
	readonly estimatedDuration?: number; // Seconds (for progress)
}
```

### StepPosition

`StepPosition` is a generic type that accepts a step ID type parameter:

```typescript
type StepPosition<TStepId extends string = string> =
	| { type: 'before'; stepId: TStepId } // Before a step
	| { type: 'after'; stepId: TStepId } // After a step
	| { type: 'replace'; stepId: TStepId } // Replace a step
	| { type: 'first' } // First in pipeline
	| { type: 'last' }; // Last in pipeline
```

When working with the default pipeline, use `StepPosition<BuiltInStepId>` for type-safe step references.

### BuiltInStepId

> **Note:** `BuiltInStepId` is defined in `@ever-works/default-pipeline-plugin`, not in `@ever-works/plugin`. This keeps the plugin contracts package pipeline-agnostic.

All 15 built-in pipeline steps:

```typescript
// Import from default-pipeline-plugin
import { BuiltInStepId } from '@ever-works/default-pipeline-plugin';

type BuiltInStepId =
	| 'prompt-comparison'
	| 'prompt-processing'
	| 'domain-detection'
	| 'ai-first-items-generation'
	| 'search-queries-generation'
	| 'web-search'
	| 'content-retrieval'
	| 'content-filtering'
	| 'items-extraction'
	| 'deduplication-and-data-aggregation'
	| 'categories-tags-processing'
	| 'sources-validation'
	| 'badges-processing'
	| 'image-capture'
	| 'markdown-generation';
```

### ExecutablePipeline

Compiled pipeline ready for execution:

```typescript
interface ExecutablePipeline {
	readonly steps: PipelineStepDefinition[]; // All steps in order
	readonly groups: ParallelGroup[]; // Parallel execution groups
	readonly executorMap: Map<string, StepExecutor>; // Step -> executor mapping
	readonly replacedSteps: Map<string, string>; // Original -> replacement
	readonly disabledSteps: Set<string>; // Disabled step IDs
	readonly injectedSteps: Set<string>; // Plugin-injected steps
	readonly estimatedDuration?: number; // Total estimated time
	readonly source: 'standard' | string; // Pipeline source
}
```

---

## Settings & Configuration

### JsonSchema Extension Fields

The plugin system uses `x-*` extension fields on JSON Schema properties to control behavior:

| Field | Type | Purpose |
|-------|------|---------|
| `x-secret` | `boolean` | Secret field: value is never returned via API, rendered as password input in UI |
| `x-envVar` | `string` | Environment variable name used as fallback (value not stored in DB when env var is set) |
| `x-scope` | `'global' \| 'user' \| 'directory'` | Setting access level |
| `x-widget` | `string` | UI widget hint (e.g., `'model-select'`) |
| `x-hidden` | `boolean` | Hide field from all UI (still usable internally) |
| `x-adminOnly` | `boolean` | Only visible to admins, stripped from user-facing schema |

```typescript
const settingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		apiKey: {
			type: 'string',
			title: 'API Key',
			'x-secret': true, // Never returned via API; rendered as password input
			'x-scope': 'user'
		},
		defaultModel: {
			type: 'string',
			title: 'Default Model',
			default: 'gpt-4o',
			'x-widget': 'model-select',
			'x-scope': 'user'
		},
		baseUrl: {
			type: 'string',
			title: 'API Base URL',
			default: 'https://api.example.com',
			'x-hidden': true // Available but not shown in settings UI
		}
	},
	required: ['apiKey']
};
```

### ConfigurationMode

```typescript
type ConfigurationMode =
	| 'admin-only' // Only admins configure; users get admin settings
	| 'user-required' // Users must provide settings; no admin fallback
	| 'hybrid'; // Admin provides defaults; users can override
```

### ValidationResult

```typescript
interface ValidationResult {
	readonly valid: boolean;
	readonly errors?: readonly ValidationError[];
	readonly warnings?: readonly ValidationWarning[];
}

interface ValidationError {
	readonly field: string;
	readonly message: string;
	readonly code?: string;
}
```

---

## Testing Utilities

### createMockPluginContext

Create a fully-functional mock context for testing:

```typescript
import { createMockPluginContext } from '@ever-works/plugin/testing';

describe('MyPlugin', () => {
	let plugin: MyPlugin;
	let context: ReturnType<typeof createMockPluginContext>;

	beforeEach(() => {
		plugin = new MyPlugin();
		context = createMockPluginContext({
			pluginId: 'my-plugin',
			settings: {
				apiKey: 'test-api-key',
				endpoint: 'https://api.test.com'
			},
			envVars: {
				MY_CLIENT_ID: 'client-123',
				MY_CLIENT_SECRET: 'secret-456'
			}
		});
	});

	it('should load successfully', async () => {
		await expect(plugin.onLoad(context)).resolves.not.toThrow();
	});

	it('should validate settings', async () => {
		const result = await plugin.validateSettings({ apiKey: 'valid-key' });
		expect(result.valid).toBe(true);
	});

	it('should reject invalid settings', async () => {
		const result = await plugin.validateSettings({});
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.objectContaining({ field: 'apiKey' }));
	});
});
```

### MockPluginContextOptions

```typescript
interface MockPluginContextOptions {
	pluginId?: string;
	settings?: PluginSettings;
	env?: MockPluginEnvironmentOptions;
	envVars?: Record<string, string>;
	directories?: Map<string, DirectoryInfo>;
	users?: Map<string, UserInfo>;
	currentUser?: UserInfo;
	httpResponses?: Map<string, HttpResponse<unknown>>;
}
```

### Test Helpers

```typescript
// Create mock logger
const logger = createMockLogger();
logger.log('test');
expect(logger.log.mock.calls).toHaveLength(1);

// Create mock cache
const cache = createMockCache();
await cache.set('key', 'value', 60); // 60 second TTL
const value = await cache.get('key');

// Create mock HTTP client
const http = createMockHttpClient(
	new Map([
		[
			'GET:https://api.example.com/data',
			{
				status: 200,
				statusText: 'OK',
				headers: {},
				data: { result: 'success' }
			}
		]
	])
);

// Create mock environment
const env = createMockPluginEnvironment({
	platform: 'linux',
	nodeVersion: 'v20.0.0',
	isDevelopment: true
});
```

### Contract Tests

Run standard contract tests to verify IPlugin compliance:

```typescript
import { runPluginContractTests } from '@ever-works/plugin/testing';

describe('MyPlugin Contract Tests', () => {
	runPluginContractTests(() => new MyPlugin(), {
		validSettings: { apiKey: 'test-key' },
		invalidSettings: { apiKey: '' }
	});
});
```

---

## Helper Functions

### Settings Resolution

```typescript
import { resolveSettings, mergeSettings } from '@ever-works/plugin/helpers';

// Merge settings with priority: directory > user > admin > defaults
const resolved = mergeSettings(pluginDefaults, adminSettings, userSettings, directorySettings);

// Resolve with full metadata
const resolvedWithMeta = resolveSettings(settingsSchema, {
	admin: adminSettings,
	user: userSettings,
	directory: directorySettings
});
```

### Validation Helpers

```typescript
import { createValidationResult, addValidationError, isValidationSuccess } from '@ever-works/plugin/helpers';

function validateMySettings(settings: PluginSettings): ValidationResult {
	let result = createValidationResult();

	if (!settings.apiKey) {
		result = addValidationError(result, 'apiKey', 'API key is required');
	}

	if (settings.timeout && settings.timeout < 1000) {
		result = addValidationError(result, 'timeout', 'Timeout must be at least 1000ms');
	}

	return result;
}
```

### Icon Helpers

Plugin icons **must** be defined in the `getManifest()` method of your plugin class, not in `package.json`. The `getManifest()` icon is the single source of truth rendered in the UI.

```typescript
import { svgIcon } from '@ever-works/plugin';

// In your plugin class:
getManifest(): PluginManifest {
	return {
		// ...other manifest fields
		icon: {
			type: 'svg',
			value: '<svg>...</svg>',
			backgroundColor: '#000000'
		}
	};
}
```

Available icon factory helpers:

```typescript
import { lucideIcon, svgIcon, urlIcon, base64Icon } from '@ever-works/plugin';

lucideIcon('github', '#333');                   // Lucide icon name + background color
svgIcon('<svg>...</svg>');                       // Raw SVG string
urlIcon('https://example.com/icon.png');         // External image URL
base64Icon('data:image/png;base64,...');          // Base64-encoded image
```

### Type Guards

```typescript
import { isGitProviderPlugin, isAiProviderPlugin, isDeploymentPlugin, isPipelineStepPlugin } from '@ever-works/plugin';

function handlePlugin(plugin: IPlugin) {
	if (isGitProviderPlugin(plugin)) {
		// plugin is IGitProviderPlugin
		const url = plugin.getCloneUrl('owner', 'repo');
	}

	if (isAiProviderPlugin(plugin)) {
		// plugin is IAiProviderPlugin
		const models = await plugin.listModels();
	}
}
```

---

## Quick Start Examples

### Example 1: Simple Utility Plugin

```typescript
import { BasePlugin, PluginContext, ValidationResult } from '@ever-works/plugin';

export class HelloPlugin extends BasePlugin {
	readonly id = 'hello';
	readonly name = 'Hello Plugin';
	readonly version = '1.0.0';
	readonly category = 'utility' as const;
	readonly capabilities = [];

	readonly settingsSchema = {
		type: 'object' as const,
		properties: {
			greeting: {
				type: 'string',
				title: 'Greeting Message',
				default: 'Hello, World!'
			}
		}
	};

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.log('Hello plugin loaded!');
	}

	async validateSettings(): Promise<ValidationResult> {
		return { valid: true };
	}

	async greet(): Promise<string> {
		const settings = await this.getSettings();
		return (settings.greeting as string) || 'Hello, World!';
	}
}
```

### Example 2: Screenshot Plugin

```typescript
import { BasePlugin, IScreenshotPlugin, ScreenshotOptions, ScreenshotResult } from '@ever-works/plugin';

export class MyScreenshotPlugin extends BasePlugin implements IScreenshotPlugin {
	readonly id = 'my-screenshot';
	readonly name = 'My Screenshot Service';
	readonly version = '1.0.0';
	readonly category = 'screenshot' as const;
	readonly capabilities = ['screenshot'];

	readonly settingsSchema = {
		type: 'object' as const,
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				'x-secret': true
			}
		},
		required: ['apiKey']
	};

	async capture(url: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
		const settings = await this.getSettings();
		const response = await this.http!.post<{ url: string }>(
			'https://api.screenshotservice.com/capture',
			{
				url,
				width: options.width || 1280,
				height: options.height || 720,
				format: options.format || 'png'
			},
			{
				headers: { Authorization: `Bearer ${settings.apiKey}` }
			}
		);

		return {
			url: response.data.url,
			width: options.width || 1280,
			height: options.height || 720,
			format: options.format || 'png'
		};
	}

	getSupportedFormats(): readonly string[] {
		return ['png', 'jpeg', 'webp'];
	}
}
```

### Example 3: Pipeline Step Plugin

```typescript
import {
	BasePlugin,
	IPipelineStepPlugin,
	PipelineStepDefinition,
	GenerationContext,
	StepExecutionResult
} from '@ever-works/plugin';

export class ContentEnricherPlugin extends BasePlugin implements IPipelineStepPlugin {
	readonly id = 'content-enricher';
	readonly name = 'Content Enricher';
	readonly version = '1.0.0';
	readonly category = 'pipeline' as const;
	readonly capabilities = ['pipeline-step'];

	getStepDefinitions(): readonly PipelineStepDefinition[] {
		return [
			{
				id: 'content-enricher:enrich',
				name: 'Enrich Content',
				description: 'Add metadata to extracted items',
				position: { type: 'after', stepId: 'item-extraction' },
				requires: ['extracted-items'],
				provides: ['enriched-items'],
				optional: true,
				estimatedDuration: 30
			}
		];
	}

	canHandleStep(stepId: string): boolean {
		return stepId === 'content-enricher:enrich';
	}

	async executeStep(stepId: string, context: GenerationContext): Promise<StepExecutionResult> {
		if (stepId !== 'content-enricher:enrich') {
			return { success: false, error: 'Unknown step' };
		}

		const items = context.getStepResult('extracted-items') || [];

		// Enrich items with additional metadata
		const enrichedItems = items.map((item) => ({
			...item,
			enrichedAt: new Date().toISOString(),
			source: 'content-enricher'
		}));

		return {
			success: true,
			data: { 'enriched-items': enrichedItems }
		};
	}
}
```

---

## API Reference

### Exports Summary

| Export                        | Type      | Description                   |
| ----------------------------- | --------- | ----------------------------- |
| `IPlugin`                     | Interface | Base plugin interface         |
| `IGitProviderPlugin`          | Interface | Git provider capability       |
| `IDeploymentPlugin`           | Interface | Deployment capability         |
| `IScreenshotPlugin`           | Interface | Screenshot capability         |
| `ISearchPlugin`               | Interface | Search capability             |
| `IAiProviderPlugin`           | Interface | AI provider capability        |
| `IPipelineStepPlugin`         | Interface | Pipeline step capability      |
| `IFullPipelinePlugin`         | Interface | Full pipeline capability      |
| `IContentExtractorPlugin`     | Interface | Content extraction capability |
| `IDataSourcePlugin`           | Interface | Data source capability        |
| `IOAuthPlugin`                | Interface | OAuth capability              |
| `IFormFieldPlugin`            | Interface | Custom form fields            |
| `ISubProviderPlugin`          | Interface | Sub-provider capability       |
| `IConfigAwarePlugin`          | Interface | Config-aware capability       |
| `BasePlugin`                  | Class     | Abstract base plugin          |
| `BaseGitProvider`             | Class     | Abstract git provider         |
| `BaseAiProvider`              | Class     | Abstract AI provider          |
| `BasePipelineStep`            | Class     | Abstract pipeline step        |
| `createMockPluginContext`     | Function  | Create test context           |
| `createMockLogger`            | Function  | Create test logger            |
| `createMockCache`             | Function  | Create test cache             |
| `createMockHttpClient`        | Function  | Create test HTTP client       |
| `createMockPluginEnvironment` | Function  | Create test environment       |
| `runPluginContractTests`      | Function  | Run contract tests            |
| `lucideIcon`                  | Function  | Create Lucide icon            |
| `svgIcon`                     | Function  | Create SVG icon               |
| `urlIcon`                     | Function  | Create URL icon               |
| `base64Icon`                  | Function  | Create base64 icon            |
| `createExecutablePipeline`    | Function  | Create empty pipeline         |
| `isInjectedStep`              | Function  | Check if step injected        |
| `isReplacedStep`              | Function  | Check if step replaced        |
| `isDisabledStep`              | Function  | Check if step disabled        |
| `getStepExecutor`             | Function  | Get step executor             |

### Type Exports

| Type                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `PluginContext`          | Context passed to plugins                                      |
| `PluginCategory`         | Plugin category enum                                           |
| `PluginManifest`         | Plugin metadata                                                |
| `PluginSettings`         | Settings object                                                |
| `ValidationResult`       | Validation result                                              |
| `JsonSchema`             | JSON Schema type                                               |
| `ConfigurationMode`      | Settings mode                                                  |
| `PluginIcon`             | Icon definition                                                |
| `PluginIconType`         | Icon type enum                                                 |
| `PipelineStepDefinition` | Step definition                                                |
| `StepPosition<T>`        | Step position (generic)                                        |
| `BuiltInStepId`          | Built-in step IDs (from `@ever-works/default-pipeline-plugin`) |
| `ExecutablePipeline`     | Compiled pipeline                                              |
| `StepExecutor`           | Step executor                                                  |
| `ParallelGroup`          | Parallel execution group                                       |
| `GenerationContext`      | Pipeline context                                               |
| `StepExecutionResult`    | Step result                                                    |
| `PluginEventName`        | Event names                                                    |
| `PluginEventPayloads`    | Event payload types                                            |

---

## Further Reading

- [Plugin Architecture Guide](./PLUGIN_ARCHITECTURE_GUIDE.md) - High-level architecture overview
- [Plugin System RFC](./PLUGIN_SYSTEM_RFC.md) - Design decisions and rationale
- [Plugin System JIRA Tickets](./PLUGIN_SYSTEM_JIRA_TICKETS.md) - Implementation details
- [Plugin System Checklist](./PLUGIN_SYSTEM_CHECKLIST.md) - Implementation progress
