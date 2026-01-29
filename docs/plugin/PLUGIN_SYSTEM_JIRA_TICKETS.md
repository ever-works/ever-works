# Ever Works Plugin System - Implementation Tickets

---

## Epic Overview

Transform Ever Works from a tightly-coupled, hardcoded system into a fully modular, plugin-based architecture where every capability (git, deployment, screenshots, AI, etc.) is provided by installable plugins.

---

# Story 1: Plugin Contracts Package

**Story Title:** Create Plugin Contracts Package

**Story Description:**
Create a new `packages/plugin` package containing all TypeScript interfaces and types that define the plugin system contracts. This package will be lightweight (no runtime dependencies) and used by both the core agent and all plugins.

**Acceptance Criteria:**

- Package is created at `packages/plugin`
- All capability interfaces are defined
- Package builds successfully
- Package can be imported by other packages

---

## Task 1.1: Package Setup

**Title:** Set up plugin package structure

**Description:**
Create the initial package structure for `packages/plugin` including package.json, tsconfig.json, and folder structure.

**Implementation Details:**

1. Create directory `packages/plugin`
2. Create `package.json` with:
    - Name: `@ever-works/plugin`
    - Version: `1.0.0`
    - Main: `dist/index.js`
    - Types: `dist/index.d.ts`
3. Create `tsconfig.json` extending base config
4. Create folder structure:
    ```
    src/
    ├── index.ts
    ├── capabilities/
    │   └── index.ts
    └── types/
        └── index.ts
    ```
5. Add to pnpm workspace

**Files to Create:**

- `packages/plugin/package.json`
- `packages/plugin/tsconfig.json`
- `packages/plugin/src/index.ts`

---

## Task 1.2: IPlugin Interface

**Title:** Define base IPlugin interface

**Description:**
Create the base `IPlugin` interface that all plugins must implement, including metadata properties and lifecycle hooks.

**Implementation Details:**

```typescript
// src/plugin.interface.ts
export interface IPlugin {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly category: PluginCategory;
	readonly capabilities: string[];
	readonly settingsSchema: JsonSchema;

	/**
	 * Configuration mode determines who can configure this plugin's settings.
	 * - 'admin-only': Only admins can configure; users use admin settings
	 * - 'user-required': Users must provide their own settings (no admin defaults)
	 * - 'hybrid': Admin provides defaults, users can override (DEFAULT)
	 *
	 * Use cases:
	 * - 'admin-only': Platform-provided API keys users shouldn't manage
	 * - 'user-required': Plugins requiring user's own API keys (e.g., personal AI keys)
	 * - 'hybrid': Platform provides fallback, users can bring their own keys
	 */
	readonly configurationMode?: PluginConfigurationMode;

	onLoad(context: PluginContext): Promise<void>;
	onEnable(context: PluginContext): Promise<void>;
	onDisable(context: PluginContext): Promise<void>;
	onUnload(): Promise<void>;

	validateSettings(settings: unknown): Promise<ValidationResult>;
}

/**
 * Determines who can configure plugin settings and how they are resolved.
 */
export type PluginConfigurationMode = 'admin-only' | 'user-required' | 'hybrid';

export type PluginCategory =
	| 'git'
	| 'deployment'
	| 'screenshot'
	| 'search'
	| 'content'
	| 'data-source'
	| 'ai'
	| 'pipeline';

export type PluginState = 'discovered' | 'loaded' | 'enabled' | 'disabled' | 'unloaded' | 'error';
```

**Files to Create:**

- `packages/plugin/src/plugin.interface.ts`

---

## Task 1.3: PluginContext Interface

**Title:** Define PluginContext interface

**Description:**
Create the `PluginContext` interface that defines what plugins can access when loaded (database, services, events, settings, environment variables, custom capabilities).

**⚠️ TYPE SAFETY:** Use generics for type-safe settings retrieval and typed event names for event handling.

**Implementation Details:**

```typescript
// src/types/event-types.ts
// ============================================
// TYPE-SAFE EVENT NAMES
// ============================================

/** All valid plugin event names */
export const PLUGIN_EVENTS = [
	'plugin:loaded',
	'plugin:enabled',
	'plugin:disabled',
	'plugin:unloaded',
	'plugin:settings-changed',
	'directory:created',
	'directory:updated',
	'directory:deleted',
	'generation:started',
	'generation:step-completed',
	'generation:completed',
	'generation:failed',
	'deployment:started',
	'deployment:completed',
	'deployment:failed'
] as const;

export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

/** Map event names to their payload types */
export interface PluginEventPayloads {
	'plugin:loaded': { pluginId: string };
	'plugin:enabled': { pluginId: string; directoryId: string };
	'plugin:disabled': { pluginId: string; directoryId: string };
	'plugin:unloaded': { pluginId: string };
	'plugin:settings-changed': { pluginId: string; userId: string };
	'directory:created': { directoryId: string; userId: string };
	'directory:updated': { directoryId: string };
	'directory:deleted': { directoryId: string };
	'generation:started': { directoryId: string; generationId: string };
	'generation:step-completed': { generationId: string; stepId: StepDataKey };
	'generation:completed': { directoryId: string; generationId: string; itemCount: number };
	'generation:failed': { generationId: string; error: string };
	'deployment:started': { directoryId: string; deploymentId: string };
	'deployment:completed': { deploymentId: string; url: string };
	'deployment:failed': { deploymentId: string; error: string };
}
```

```typescript
// src/plugin-context.interface.ts
export interface PluginContext {
	// Database Access
	dataSource: DataSource;
	getRepository<T>(entity: EntityTarget<T>): Repository<T>;

	// Core Services
	services: PluginServices;

	// TYPE-SAFE Events
	eventEmitter: EventEmitter2;
	onEvent<E extends PluginEventName>(
		event: E,
		handler: (payload: PluginEventPayloads[E]) => void | Promise<void>
	): void;
	emitEvent<E extends PluginEventName>(event: E, payload: PluginEventPayloads[E]): void;

	// TYPE-SAFE User Settings (from database, per-user/per-directory)
	getSettings<T>(): Promise<T>;
	getUserSettings<T>(userId: string): Promise<T>;
	getDirectorySettings<T>(directoryId: string): Promise<T>;

	// Platform Environment Variables (injected, never use process.env directly)
	env: PluginEnvironment;

	// HTTP
	registerController(controller: Type<any>): void;

	// TYPE-SAFE Custom Capabilities
	registerCustomCapability<T>(id: string, impl: T, metadata?: CapabilityMetadata): void;
	getCustomCapability<T>(id: string): T | undefined;
	hasCustomCapability(id: string): boolean;
	listCustomCapabilities(): CapabilityInfo[];

	// Utilities
	logger: Logger;
	cache: CacheManager;
}

/**
 * Environment variables are INJECTED into plugins via context.env
 * Plugins should NEVER read process.env directly - this enables:
 * 1. Unit testing with mock env values
 * 2. Validation that required env vars are set at startup
 * 3. Secret masking in logs
 */
export interface PluginEnvironment {
	get(name: string): string | undefined;
	getRequired(name: string): string;
	has(name: string): boolean;
	getAll(): Record<string, string | undefined>;
}

/**
 * Environment variable configuration for plugin manifests.
 * Declares which env vars the plugin needs.
 */
export interface PluginEnvVarConfig {
	name: string; // Env var name (e.g., "GH_CLIENT_ID")
	required: boolean; // Is this required for plugin to work?
	description: string; // Human-readable description
	secret?: boolean; // If true, value is masked in logs/UI
}
```

**Files to Create:**

- `packages/plugin/src/plugin-context.interface.ts`

---

## Task 1.4: IGitProviderPlugin Interface

**Title:** Define IGitProviderPlugin capability interface

**Description:**
Create the interface for git provider plugins (GitHub, GitLab, Bitbucket) that handle repository operations.

**⚠️ TYPE SAFETY:** All method parameters and return types are strictly typed. No `any` types allowed.

**Implementation Details:**

```typescript
// src/capabilities/git-provider.interface.ts
export interface IGitProviderPlugin extends IPlugin {
	createRepository(options: CreateRepoOptions): Promise<Repository>;
	getRepository(owner: string, repo: string): Promise<Repository>;
	deleteRepository(owner: string, repo: string): Promise<void>;

	pushChanges(repo: Repository, changes: Changes): Promise<PushResult>;
	pullChanges(repo: Repository, branch: string): Promise<PullResult>;

	createBranch(repo: Repository, name: string, from?: string): Promise<Branch>;
	deleteBranch(repo: Repository, name: string): Promise<void>;
	getBranches(repo: Repository): Promise<Branch[]>;

	createPullRequest(options: PROptions): Promise<PullRequest>;
	mergePullRequest(pr: PullRequest): Promise<MergeResult>;
	getPullRequest(repo: Repository, number: number): Promise<PullRequest>;

	triggerWorkflow(repo: Repository, workflow: string, inputs?: Record<string, any>): Promise<WorkflowRun>;
	getWorkflowStatus(repo: Repository, runId: string): Promise<WorkflowStatus>;

	getUser(): Promise<GitUser>;
	getOrganizations(): Promise<Organization[]>;
}

export interface CreateRepoOptions {
	name: string;
	description?: string;
	private?: boolean;
	organization?: string;
}

export interface Repository {
	id: string;
	name: string;
	fullName: string;
	owner: string;
	url: string;
	defaultBranch: string;
	private: boolean;
}

// ... other types
```

**Files to Create:**

- `packages/plugin/src/capabilities/git-provider.interface.ts`

---

## Task 1.5: IDeploymentPlugin Interface

**Title:** Define IDeploymentPlugin capability interface

**Description:**
Create the interface for deployment plugins (Vercel, Netlify, Railway) that handle site deployment.

**⚠️ TYPE SAFETY:** Uses union types for `DeploymentStatus` and `environment`. All return types are strictly typed.

**Implementation Details:**

```typescript
// src/capabilities/deployment.interface.ts
export interface IDeploymentPlugin extends IPlugin {
	deploy(directory: Directory, options: DeployOptions): Promise<Deployment>;
	cancelDeployment(deploymentId: string): Promise<void>;

	getDeploymentStatus(deploymentId: string): Promise<DeploymentStatus>;
	getDeployments(directory: Directory): Promise<Deployment[]>;

	getDomains(directory: Directory): Promise<Domain[]>;
	addDomain(directory: Directory, domain: string): Promise<Domain>;
	removeDomain(directory: Directory, domain: string): Promise<void>;

	getTeams(): Promise<Team[]>;
	getProjects(): Promise<Project[]>;

	validateToken(token: string): Promise<ValidationResult>;
}

export interface DeployOptions {
	environment?: 'production' | 'preview';
	branch?: string;
	teamId?: string;
	projectId?: string;
}

export interface Deployment {
	id: string;
	url: string;
	status: DeploymentStatus;
	createdAt: Date;
	readyAt?: Date;
	error?: string;
}

export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'canceled';
```

**Files to Create:**

- `packages/plugin/src/capabilities/deployment.interface.ts`

---

## Task 1.6: IScreenshotPlugin Interface

**Title:** Define IScreenshotPlugin capability interface

**Description:**
Create the interface for screenshot plugins (ScreenshotOne, Playwright, Browserless).

**⚠️ TYPE SAFETY:** Uses union type for `format` ('png' | 'jpg' | 'webp'). All options are strictly typed.

**Implementation Details:**

```typescript
// src/capabilities/screenshot.interface.ts
export interface IScreenshotPlugin extends IPlugin {
	capture(url: string, options?: ScreenshotOptions): Promise<Screenshot>;
	bulkCapture(requests: BulkScreenshotRequest[]): Promise<Screenshot[]>;

	isAvailable(): boolean;
	getQuota?(): Promise<ScreenshotQuota>;
}

export interface ScreenshotOptions {
	viewportWidth?: number;
	viewportHeight?: number;
	format?: 'png' | 'jpg' | 'webp';
	fullPage?: boolean;
	delay?: number;
	blockAds?: boolean;
	blockTrackers?: boolean;
	blockCookieBanners?: boolean;
	cache?: boolean;
	cacheTtl?: number;
}

export interface Screenshot {
	url: string;
	cacheUrl?: string;
	buffer?: Buffer;
	width?: number;
	height?: number;
	format?: string;
}

export interface BulkScreenshotRequest {
	url: string;
	options?: ScreenshotOptions;
	metadata?: Record<string, any>;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/screenshot.interface.ts`

---

## Task 1.7: ISearchPlugin Interface

**Title:** Define ISearchPlugin capability interface

**Description:**
Create the interface for search plugins (Tavily, Exa, SerpAPI).

**⚠️ TYPE SAFETY:** Uses union type for `searchDepth` ('basic' | 'advanced'). All result types are strictly typed.

**Implementation Details:**

```typescript
// src/capabilities/search.interface.ts
export interface ISearchPlugin extends IPlugin {
	search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

	getQuota?(): Promise<SearchQuota>;
}

export interface SearchOptions {
	maxResults?: number;
	includeContent?: boolean;
	includeDomains?: string[];
	excludeDomains?: string[];
	searchDepth?: 'basic' | 'advanced';
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	content?: string;
	score?: number;
	publishedDate?: Date;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/search.interface.ts`

---

## Task 1.8: IContentExtractorPlugin Interface

**Title:** Define IContentExtractorPlugin capability interface

**Description:**
Create the interface for content extraction plugins that scrape and parse web pages.

**⚠️ TYPE SAFETY:** All extraction options and result types are strictly typed. No `any` for metadata.

**Implementation Details:**

```typescript
// src/capabilities/content-extractor.interface.ts
export interface IContentExtractorPlugin extends IPlugin {
	extract(url: string, options?: ExtractOptions): Promise<ExtractedContent>;
	bulkExtract(urls: string[], options?: ExtractOptions): Promise<ExtractedContent[]>;

	supportsUrl(url: string): boolean;
}

export interface ExtractOptions {
	includeHtml?: boolean;
	includeMarkdown?: boolean;
	includeImages?: boolean;
	includeLinks?: boolean;
	includeMetadata?: boolean;
	selector?: string;
}

export interface ExtractedContent {
	url: string;
	title?: string;
	content: string;
	html?: string;
	markdown?: string;
	images?: ExtractedImage[];
	links?: ExtractedLink[];
	metadata?: Record<string, any>;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/content-extractor.interface.ts`

---

## Task 1.9: IDataSourcePlugin Interface

**Title:** Define IDataSourcePlugin capability interface

**Description:**
Create the interface for data source plugins (Notion, Apify, RSS, Awesome Readme).

**⚠️ TYPE SAFETY:** Uses `JsonSchema` for source schema validation. All config and result types are strictly typed.

**Implementation Details:**

```typescript
// src/capabilities/data-source.interface.ts
export interface IDataSourcePlugin extends IPlugin {
	fetchItems(config: DataSourceConfig): Promise<RawItem[]>;

	supportsSource(source: string): boolean;
	getSourceSchema(): JsonSchema;
	validateSourceConfig(config: unknown): Promise<ValidationResult>;
}

export interface DataSourceConfig {
	source: string;
	url?: string;
	apiKey?: string;
	filters?: Record<string, any>;
	pagination?: PaginationConfig;
}

export interface RawItem {
	name: string;
	url?: string;
	description?: string;
	image?: string;
	category?: string;
	metadata?: Record<string, any>;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/data-source.interface.ts`

---

## Task 1.10: IAiProviderPlugin Interface

**Title:** Define IAiProviderPlugin capability interface

**Description:**
Create the interface for AI provider plugins (OpenAI, Anthropic, Google, Ollama). The interface must support:

1. **Basic chat and streaming** - Standard LLM operations
2. **Structured output (askJson)** - Critical for pipeline operations that require validated JSON responses
3. **Provider capabilities** - Declare what features each provider supports
4. **Health checks** - Monitor provider availability with caching

**⚠️ TYPE SAFETY:** Uses Zod schemas for `askJson<T>()` with full type inference. All union types are used for roles, tiers, complexity, and capabilities.

**Why askJson is Critical:**
The pipeline has 6 AI-driven steps that ALL use structured JSON output:

- AI Item Generation, Search Query Generation, Item Extraction
- Data Aggregation, Category Processing, Prompt Understanding

Without askJson support, plugins cannot be used in the pipeline.

**Implementation Details:**

```typescript
// src/capabilities/ai-provider.interface.ts
import { ZodSchema } from 'zod';

export interface IAiProviderPlugin extends IPlugin {
	// Basic chat operations
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
	chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatChunk>;

	// Embeddings
	embed(text: string | string[]): Promise<number[][]>;

	// Model information
	getModels(): Promise<AiModel[]>;
	getDefaultModel(): string;

	/**
	 * CRITICAL: Structured output with Zod schema validation.
	 * All pipeline AI operations use this method for type-safe responses.
	 *
	 * Implementation notes:
	 * - Use provider's native structured output if available (e.g., OpenAI function calling)
	 * - Fall back to prompt-based JSON extraction with retry on parse failure
	 * - Validate response against schema before returning
	 */
	askJson<T>(prompt: string, schema: ZodSchema<T>, options?: AskJsonOptions): Promise<AskJsonResponse<T>>;

	/**
	 * Declare what this provider supports.
	 * Used by AiFacade for routing decisions.
	 */
	getCapabilities(): AiProviderCapabilities;

	/**
	 * Health check with response time measurement.
	 * AiFacade caches results for 5 minutes.
	 */
	healthCheck(): Promise<HealthCheckResult>;
}

// ============ Chat Types ============

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	stop?: string[];
}

export interface ChatResponse {
	content: string;
	model: string;
	usage?: TokenUsage;
	finishReason?: string;
}

export interface ChatChunk {
	content: string;
	done: boolean;
}

// ============ Structured Output Types ============

export interface AskJsonOptions {
	/** Override the default model for this request */
	model?: string;

	/** Temperature for generation (0-2, lower = more deterministic) */
	temperature?: number;

	/** Hint for model routing (economy/standard/premium selection) */
	complexity?: TaskComplexity;

	/** Maximum retries on JSON parse failure (default: 2) */
	maxRetries?: number;
}

export interface AskJsonResponse<T> {
	/** Validated result matching the provided schema */
	result: T;

	/** Token usage for this request */
	usage?: TokenUsage;

	/** Estimated cost in USD (if available) */
	cost?: number;

	/** Actual model used (may differ from requested due to routing) */
	model: string;

	/** Number of retries needed to get valid JSON */
	retries?: number;
}

/**
 * Task complexity for model routing.
 * Maps to model tiers in AiFacade.
 */
export type TaskComplexity = 'simple' | 'medium' | 'complex';

// ============ Provider Capabilities ============

export interface AiProviderCapabilities {
	/** Provider supports structured output (JSON mode or function calling) */
	supportsStructuredOutput: boolean;

	/** Provider supports streaming responses */
	supportsStreaming: boolean;

	/** Provider supports embedding generation */
	supportsEmbeddings: boolean;

	/** Provider supports vision/image input */
	supportsVision: boolean;

	/** Maximum context window size in tokens */
	maxContextLength: number;

	/** List of available models with metadata */
	availableModels: AiModel[];

	/** Supported model tiers for routing */
	supportedTiers: ModelTier[];
}

export interface AiModel {
	id: string;
	name: string;
	contextLength: number;
	capabilities: ('chat' | 'embed' | 'vision' | 'structured-output')[];
	/** Model tier for routing (maps to TaskComplexity) */
	tier?: ModelTier;
	/** Cost per 1K input tokens in USD */
	inputCostPer1k?: number;
	/** Cost per 1K output tokens in USD */
	outputCostPer1k?: number;
}

export type ModelTier = 'economy' | 'standard' | 'premium';

// ============ Health Check Types ============

export interface HealthCheckResult {
	/** Whether the provider is available */
	success: boolean;

	/** Response time in milliseconds */
	responseTimeMs: number;

	/** Error message if health check failed */
	error?: string;

	/** Timestamp of this check */
	checkedAt: Date;
}

// ============ Token Usage Types ============

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/ai-provider.interface.ts`

---

## Task 1.11: IPipelineStepPlugin Interface

**Title:** Define IPipelineStepPlugin capability interface with step injection/replacement/disable support

**Description:**
Create the interface for plugins that add, modify, replace, or disable pipeline steps. Plugins can:

1. **Inject** new steps before/after existing ones
2. **Replace** existing steps entirely
3. **Disable** existing steps
4. **Append/Prepend** steps to the pipeline

**⚠️ TYPE SAFETY IS CRITICAL**

All step IDs, data keys, and step results MUST be strongly typed. This prevents runtime errors from typos and ensures data flow between steps is validated at compile time.

**Implementation Details:**

```typescript
// src/types/step-types.ts
// ============================================
// TYPE-SAFE STEP IDENTIFIERS
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

/** Map data keys to their TypeScript types for full type inference */
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
```

```typescript
// src/capabilities/pipeline-step.interface.ts

/**
 * TYPE-SAFE Pipeline step definition with explicit dependencies.
 * Used by both built-in steps and plugin steps.
 */
export interface PipelineStepDefinition {
	/**
	 * Unique step ID.
	 * - Built-in: Must be a valid BuiltInStepId
	 * - Plugin: Must use "plugin-name:step-name" format
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
	 * TYPE-SAFE: Must be valid StepDataKey values with corresponding types.
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
 * TYPE-SAFE Position directive for step injection/replacement/disable.
 * stepId must be a valid BuiltInStepId - typos caught at compile time.
 */
export type StepPosition =
	| { type: 'before'; stepId: BuiltInStepId } // Insert before existing step
	| { type: 'after'; stepId: BuiltInStepId } // Insert after existing step
	| { type: 'replace'; stepId: BuiltInStepId } // Replace existing step entirely
	| { type: 'disable'; stepId: BuiltInStepId } // Disable/remove existing step
	| { type: 'append' } // Add to end of pipeline
	| { type: 'prepend' }; // Add to start of pipeline

/**
 * Plugin that provides pipeline steps.
 * Can inject new steps, replace existing ones, or disable steps.
 */
export interface IPipelineStepPlugin extends IPlugin {
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

/**
 * TYPE-SAFE Generation Context for step data flow.
 * Uses generics to ensure type safety when accessing step results.
 */
export interface GenerationContext {
	directory: Directory;
	user: User;
	dto: CreateItemsGeneratorDto;
	items: Item[];
	plugins: PluginRegistry;
	settings: ResolvedSettings;
	logger: Logger;
	metrics: PipelineMetrics;

	/**
	 * TYPE-SAFE: Get step result with full type inference.
	 * Returns the correctly typed value based on the key.
	 */
	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined;

	/**
	 * TYPE-SAFE: Set step result with type validation.
	 * Compiler ensures value matches the expected type for the key.
	 */
	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void;

	/** Check if a step result exists */
	hasStepResult(key: StepDataKey): boolean;
}

export interface StepResult {
	success: boolean;
	items?: Item[];
	error?: string;
	metrics?: Record<string, number>;
}
```

**Example: Type-Safe Step Injection Plugin**

```typescript
class ContentEnrichmentPlugin implements IPlugin, IPipelineStepPlugin {
	readonly id = 'content-enrichment';

	getSteps(): PipelineStepDefinition[] {
		return [
			{
				id: 'content-enrichment:social-data',
				name: 'Social Data Enrichment',
				dependencies: ['item-extraction'], // ✅ Compile-time validated
				provides: ['enriched-items'] // ✅ Must be valid StepDataKey
			}
		];
	}

	getStepPositions(): Map<string, StepPosition> {
		return new Map([
			['content-enrichment:social-data', { type: 'after', stepId: 'item-extraction' }] // ✅ Type-safe
		]);
	}

	async executeStep(stepId: string, context: GenerationContext): Promise<GenerationContext> {
		// ✅ Type-safe access - items is typed as ExtractedItem[]
		const items = context.getStepResult('extracted-items');

		// ❌ Compile error: 'extrcted-items' is not a valid StepDataKey
		// const bad = context.getStepResult('extrcted-items');

		// Process and set result
		const enriched = await this.enrich(items);
		context.setStepResult('enriched-items', enriched); // ✅ Type validated

		return context;
	}
}
```

**Why Type Safety Matters:**

| Without Types                                              | With Types                                        |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `dependencies: ['item-extration']` - Typo found at runtime | ❌ Compile error: not assignable to BuiltInStepId |
| `context.getStepResult('bad-key')` - Returns undefined     | ❌ Compile error: invalid StepDataKey             |
| Wrong data type passed between steps                       | ❌ Compile error: type mismatch                   |

**Files to Create:**

- `packages/plugin/src/types/step-types.ts`
- `packages/plugin/src/capabilities/pipeline-step.interface.ts`

---

## Task 1.12: IFullPipelinePlugin Interface

**Title:** Define IFullPipelinePlugin capability interface

**Description:**
Create the interface for plugins that replace the entire pipeline (like Exa.ai). **CRITICAL:** Full Pipeline plugins have their **OWN steps** - they are NOT a single black-box function. They define a complete step-based pipeline that uses the SAME `PipelineExecutor` as the Standard Pipeline.

**Key Characteristics:**

- **Self-contained:** No external plugins can inject/replace/disable steps in a Full Pipeline
- **Own steps:** Defines its own `PipelineStepDefinition[]`
- **Same executor:** Uses `PipelineExecutor` like Standard Pipeline

**⚠️ TYPE SAFETY:** Full pipelines use the SAME type-safe `PipelineStepDefinition`, `GenerationContext`, and step types as the standard pipeline. Plugin steps use the `plugin:step` ID format.

**Implementation Details:**

```typescript
// src/capabilities/full-pipeline.interface.ts
import { PipelineStepDefinition } from '../types/pipeline-step.types';
import { GenerationContext } from '../types/pipeline.types';
import { JsonSchema } from '../types/common.types';

/**
 * Full Pipeline plugins define their own steps.
 * NOT a single black-box function - a complete step-based pipeline.
 * Uses the SAME PipelineExecutor as Standard Pipeline.
 */
export interface IFullPipelinePlugin extends IPlugin {
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

// Example: Exa Websets Full Pipeline
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

**Files to Create:**

- `packages/plugin/src/capabilities/full-pipeline.interface.ts`

---

## Task 1.13: IFormFieldPlugin Interface

**Title:** Define IFormFieldPlugin capability interface

**Description:**
Create the interface for plugins that add custom form fields to the generator form.

**Implementation Details:**

```typescript
// src/capabilities/form-field.interface.ts
export interface IFormFieldPlugin extends IPlugin {
	getFormFields(): FormFieldDefinition[];
	validateFormInput(values: Record<string, unknown>): ValidationResult;
	processFormInput?(values: Record<string, unknown>): Promise<ProcessedFormData>;
}

export interface FormFieldDefinition {
	id: string;
	type: FormFieldType;
	label: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
	defaultValue?: any;
	options?: FormFieldOption[];
	validation?: FormFieldValidation;
	dependsOn?: string[];
	showWhen?: FormFieldCondition;
}

export type FormFieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'select'
	| 'multiselect'
	| 'checkbox'
	| 'radio'
	| 'url'
	| 'file';

export interface FormFieldOption {
	value: string;
	label: string;
	description?: string;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/form-field.interface.ts`

---

## Task 1.14: IGitOAuthPlugin Interface

**Title:** Define IGitOAuthPlugin capability interface for git provider OAuth

**Description:**
Create the interface for git provider plugins that use OAuth to connect user accounts (GitHub, GitLab, Bitbucket).

**Important:** This is specifically for connecting user's git provider accounts so the platform can manage repositories on their behalf. This is NOT for app authentication (logging into Ever Works), which remains hardcoded in the platform.

**Why OAuth instead of access tokens?**
Most Ever Works users are not technical and shouldn't need to manually create and paste access tokens. OAuth provides a familiar "Connect with GitHub" flow.

**Implementation Details:**

```typescript
// src/capabilities/git-oauth.interface.ts
export interface IGitOAuthPlugin extends IPlugin {
	getAuthUrl(state: string, scopes?: string[]): string;
	handleCallback(code: string, state: string): Promise<GitOAuthTokens>;
	refreshToken(refreshToken: string): Promise<GitOAuthTokens>;
	revokeToken(token: string): Promise<void>;

	getScopes(): GitOAuthScope[];
	getDefaultScopes(): string[];

	getUserInfo(tokens: GitOAuthTokens): Promise<GitUserInfo>;
}

export interface GitOAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: Date;
	tokenType: string;
	scope?: string;
}

export interface GitOAuthScope {
	id: string;
	name: string;
	description: string;
	required?: boolean;
}

export interface GitUserInfo {
	id: string;
	username: string;
	email?: string;
	avatar?: string;
	name?: string;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/git-oauth.interface.ts`

---

## Task 1.15: ICustomCapabilityRegistry Interface

**Title:** Define ICustomCapabilityRegistry interface for plugin-to-plugin communication

**Description:**
Create the interface for the custom capability registry that allows plugins to register and consume dynamic capabilities.

**Implementation Details:**

```typescript
// src/capabilities/custom-capability.interface.ts
export interface ICustomCapabilityRegistry {
	register<T>(capabilityId: string, implementation: T, metadata?: CapabilityMetadata): void;
	unregister(capabilityId: string): void;

	get<T>(capabilityId: string): T | undefined;
	has(capabilityId: string): boolean;
	list(): CapabilityInfo[];
}

export interface CapabilityMetadata {
	description?: string;
	version?: string;
	schema?: JsonSchema;
	deprecated?: boolean;
	deprecationMessage?: string;
}

export interface CapabilityInfo {
	id: string;
	providedBy: string;
	metadata?: CapabilityMetadata;
	registeredAt: Date;
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/custom-capability.interface.ts`

---

## Task 1.16: CapabilityMetadata Types

**Title:** Define CapabilityMetadata and related types

**Description:**
Create shared types for capability metadata used across the plugin system.

**Implementation Details:**

```typescript
// src/types/capability.types.ts
export interface CapabilityMetadata {
	description?: string;
	version?: string;
	schema?: JsonSchema;
	deprecated?: boolean;
	deprecationMessage?: string;
}

export interface CapabilityInfo {
	id: string;
	providedBy: string;
	metadata?: CapabilityMetadata;
	registeredAt: Date;
}

export interface CapabilityRegistration<T = unknown> {
	id: string;
	implementation: T;
	metadata?: CapabilityMetadata;
	pluginId: string;
}
```

**Files to Create:**

- `packages/plugin/src/types/capability.types.ts`

---

## Task 1.17: Common Types

**Title:** Define common types for settings, validation, and pipeline

**Description:**
Create shared types used across all plugin interfaces. Importantly, the JsonSchema type must support **security markers** that plugins use to declare which settings fields are sensitive. This enables automatic encryption, UI masking, and API response filtering.

**Implementation Details:**

```typescript
// src/types/settings.types.ts
export interface ValidationResult {
	valid: boolean;
	message?: string;
	errors?: ValidationError[];
}

export interface ValidationError {
	field: string;
	message: string;
	code?: string;
}

/**
 * JSON Schema property with security markers.
 * Plugins use these markers to declare sensitive fields.
 */
export interface JsonSchemaProperty {
	type: 'string' | 'number' | 'boolean' | 'object' | 'array';
	description?: string;
	title?: string;
	default?: any;
	enum?: any[];
	format?: string;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;

	// Nested schema (for objects/arrays)
	properties?: Record<string, JsonSchemaProperty>;
	items?: JsonSchemaProperty;
	required?: string[];

	/**
	 * SECURITY MARKERS - Plugin-defined, platform-enforced
	 * These allow plugins to declare which settings fields need special handling.
	 */

	/**
	 * If true, this field's value is encrypted at rest in the database.
	 * Use for: API keys, tokens, passwords, secrets.
	 * The PluginSettingsService automatically encrypts/decrypts these fields.
	 */
	secret?: boolean;

	/**
	 * If true, this field's value is displayed as "********" in the UI.
	 * Use for: Any sensitive value users shouldn't see after entry.
	 * Frontend renders password-style inputs for these fields.
	 */
	masked?: boolean;

	/**
	 * If true, this field's value is excluded from API GET responses.
	 * Use for: Secrets that should never be returned to the client after saving.
	 * API returns undefined or "********" instead of the actual value.
	 */
	writeOnly?: boolean;
}

/**
 * JSON Schema for plugin settings.
 * Root schema is always an object with properties.
 */
export interface JsonSchema {
	type: 'object';
	properties: Record<string, JsonSchemaProperty>;
	required?: string[];
	title?: string;
	description?: string;
}

// src/types/pipeline.types.ts
export interface Item {
	name: string;
	slug: string;
	url: string;
	description: string;
	image?: string;
	category?: string;
	tags?: string[];
	metadata?: Record<string, any>;
}

export interface PipelineMetrics {
	startTime: Date;
	stepDurations: Record<string, number>;
	itemCounts: Record<string, number>;
}

// src/types/common.types.ts
export interface Directory {
	id: string;
	name: string;
	slug: string;
	userId: string;
	domainType?: string;
}

export interface User {
	id: string;
	username: string;
	email: string;
}
```

**Example: Plugin Settings Schema with Security Markers**

```typescript
// Example: GitHub plugin settings schema
const settingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		accessToken: {
			type: 'string',
			title: 'Access Token',
			description: 'GitHub personal access token',
			secret: true, // Encrypt in database
			masked: true, // Show as ******* in UI
			writeOnly: true // Never return in API responses
		},
		defaultBranch: {
			type: 'string',
			title: 'Default Branch',
			description: 'Default branch for new repositories',
			default: 'main'
			// No security markers - this is not sensitive
		},
		webhookSecret: {
			type: 'string',
			title: 'Webhook Secret',
			description: 'Secret for validating webhook payloads',
			secret: true, // Encrypt in database
			writeOnly: true // Never return in API responses
			// masked: false - not masked because user may need to copy it
		}
	},
	required: ['accessToken']
};
```

**Platform Handling of Security Markers**

The `PluginSettingsService` automatically handles these markers:

```typescript
// packages/agent/src/plugins/plugin-settings.service.ts
@Injectable()
export class PluginSettingsService {
	async saveUserSettings(pluginId: string, userId: string, settings: Record<string, unknown>) {
		const plugin = this.registry.get(pluginId);
		const schema = plugin.instance.settingsSchema;

		// Encrypt fields marked as secret
		const processed = this.processForStorage(settings, schema);
		await this.userPluginRepo.upsert({ pluginId, userId, settings: processed }, ['pluginId', 'userId']);
	}

	async getUserSettings<T>(pluginId: string, userId: string, options?: { includeWriteOnly?: boolean }): Promise<T> {
		const plugin = this.registry.get(pluginId);
		const schema = plugin.instance.settingsSchema;

		const record = await this.userPluginRepo.findOne({ where: { pluginId, userId } });
		if (!record) return this.getDefaults(schema) as T;

		// Decrypt secret fields, filter writeOnly fields
		return this.processForRead(record.settings, schema, options) as T;
	}

	private processForStorage(settings: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
		const result = { ...settings };

		for (const [key, prop] of Object.entries(schema.properties)) {
			if (prop.secret && result[key]) {
				result[key] = this.encryption.encrypt(String(result[key]));
			}
		}

		return result;
	}

	private processForRead(
		settings: Record<string, unknown>,
		schema: JsonSchema,
		options?: { includeWriteOnly?: boolean }
	): Record<string, unknown> {
		const result = { ...settings };

		for (const [key, prop] of Object.entries(schema.properties)) {
			// Decrypt secret fields
			if (prop.secret && result[key]) {
				result[key] = this.encryption.decrypt(String(result[key]));
			}

			// Filter writeOnly fields (unless explicitly requested for internal use)
			if (prop.writeOnly && !options?.includeWriteOnly) {
				result[key] = result[key] ? '********' : undefined;
			}
		}

		return result;
	}
}
```

**Files to Create:**

- `packages/plugin/src/types/settings.types.ts`
- `packages/plugin/src/types/pipeline.types.ts`
- `packages/plugin/src/types/common.types.ts`
- `packages/plugin/src/types/step-types.ts` - **TYPE-SAFE step IDs, data keys, and result types**

**⚠️ TYPE SAFETY:** The `step-types.ts` file is critical for compile-time validation of pipeline steps. See [Task 1.11](#task-111-ipipelinestepplugin-interface) for details on `BuiltInStepId`, `StepDataKey`, and `StepDataTypes`.

---

## Task 1.18: Export Index

**Title:** Create clean export index for all interfaces

**Description:**
Create the main index.ts that exports all interfaces and types in a clean, organized manner.

**Implementation Details:**

```typescript
// src/index.ts
// Core
export * from './plugin.interface';
export * from './plugin-context.interface';

// Capabilities
export * from './capabilities/git-provider.interface';
export * from './capabilities/deployment.interface';
export * from './capabilities/screenshot.interface';
export * from './capabilities/search.interface';
export * from './capabilities/content-extractor.interface';
export * from './capabilities/data-source.interface';
export * from './capabilities/ai-provider.interface';
export * from './capabilities/pipeline-step.interface';
export * from './capabilities/full-pipeline.interface';
export * from './capabilities/form-field.interface';
export * from './capabilities/oauth-provider.interface';
export * from './capabilities/custom-capability.interface';

// Types
export * from './types/settings.types';
export * from './types/pipeline.types';
export * from './types/step-types'; // TYPE-SAFE step IDs, data keys, result types
export * from './types/common.types';
export * from './types/capability.types';

// src/capabilities/index.ts
export * from './git-provider.interface';
export * from './deployment.interface';
// ... etc
```

**Files to Create/Update:**

- `packages/plugin/src/index.ts`
- `packages/plugin/src/capabilities/index.ts`
- `packages/plugin/src/types/index.ts`

---

## Task 1.19: ISubProviderPlugin Interface

**Title:** Define ISubProviderPlugin interface for multi-capability plugins

**Description:**
Create the `ISubProviderPlugin` interface that allows plugins to register multiple sub-providers with different capabilities and display names.

**Implementation Details:**

```typescript
// src/capabilities/sub-provider.interface.ts
import { PluginIcon, FormFieldDefinition, PluginCapability } from '../types';
import { IPlugin } from '../plugin.interface';

/**
 * A sub-provider represents a specific capability mode within a plugin.
 * For example, Exa plugin has "exa:websets" (full pipeline) and "exa:search" (search step).
 */
export interface PluginSubProvider {
	/** Unique ID in format "pluginId:subproviderId" (e.g., "exa:websets") */
	id: string;

	/** Display name shown in dropdowns (e.g., "Exa Websets") */
	name: string;

	/** Short description for UI */
	description?: string;

	/** Icon override (uses parent plugin icon if not provided) */
	icon?: PluginIcon;

	/** The capability this sub-provider implements */
	capability: PluginCapability;

	/** ConfigDto fields this sub-provider handles (['*'] = all fields) */
	handledConfigFields?: string[];
}

/**
 * Plugin that provides multiple sub-providers with different capabilities.
 * Allows one plugin (e.g., Exa) to appear in multiple dropdowns with different names.
 */
export interface ISubProviderPlugin extends IPlugin {
	/** List of sub-providers this plugin offers */
	readonly subProviders: PluginSubProvider[];

	/**
	 * Get form fields specific to a sub-provider.
	 * @param subProviderId - The sub-provider ID (e.g., "exa:websets")
	 */
	getFormFieldsForSubProvider(subProviderId: string): FormFieldDefinition[];
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/sub-provider.interface.ts`

---

## Task 1.20: IConfigAwarePlugin Interface

**Title:** Define IConfigAwarePlugin interface for ConfigDto field handling

**Description:**
Create the `IConfigAwarePlugin` interface that allows plugins to declare which ConfigDto fields they handle, enabling the UI to gray out those fields.

**Implementation Details:**

```typescript
// src/capabilities/config-aware.interface.ts
import { IPlugin } from '../plugin.interface';

/**
 * Plugin that is aware of ConfigDto and can declare which fields it handles.
 * When a plugin handles a field, the UI will gray it out and show a tooltip.
 */
export interface IConfigAwarePlugin extends IPlugin {
	/**
	 * Get the ConfigDto fields this plugin handles.
	 * @param subProviderId - Optional sub-provider ID for multi-capability plugins
	 * @returns Array of field names, or ['*'] for all fields
	 */
	getHandledConfigFields(subProviderId?: string): string[];

	/**
	 * Optional: Map ConfigDto values to plugin-specific options.
	 * Called before execution to transform standard config.
	 * @param config - The standard ConfigDto from generation options
	 * @param subProviderId - Optional sub-provider ID
	 * @returns Plugin-specific options object
	 */
	mapConfig?(config: Record<string, unknown>, subProviderId?: string): Record<string, unknown>;
}

/**
 * Check if a plugin implements IConfigAwarePlugin
 */
export function isConfigAwarePlugin(plugin: IPlugin): plugin is IConfigAwarePlugin {
	return (
		'getHandledConfigFields' in plugin &&
		typeof (plugin as IConfigAwarePlugin).getHandledConfigFields === 'function'
	);
}
```

**Files to Create:**

- `packages/plugin/src/capabilities/config-aware.interface.ts`

---

## Task 1.21: PluginSubProvider Types

**Title:** Define PluginSubProvider and SubProviderOption types

**Description:**
Create type definitions for sub-providers including the API response format (`SubProviderOption`) used by the generator form.

**Implementation Details:**

```typescript
// src/types/sub-provider.types.ts
import { PluginIcon, PluginCapability } from './common.types';

/**
 * Sub-provider option returned by the generator form API.
 * Includes installation status and handled config fields for UI.
 */
export interface SubProviderOption {
	/** Unique sub-provider ID (e.g., "exa:websets", "tavily") */
	id: string;

	/** Parent plugin ID (e.g., "exa", "tavily") */
	pluginId: string;

	/** Display name (e.g., "Exa Websets", "Tavily") */
	name: string;

	/** Icon for display in dropdowns */
	icon: PluginIcon;

	/** Short description */
	description?: string;

	/** The capability this sub-provider implements */
	capability: PluginCapability;

	/** Whether this is the default for its category */
	isDefault?: boolean;

	/** Whether the parent plugin is installed */
	isInstalled: boolean;

	/** ConfigDto fields this sub-provider handles (for UI graying) */
	handledConfigFields: string[];
}

/**
 * Sub-provider selection in generation options.
 * Values are sub-provider IDs, not plugin IDs.
 */
export interface SubProviderSelection {
	search?: string | null; // e.g., "exa:search", "tavily"
	screenshot?: string | null; // e.g., "screenshotone"
	ai?: string | null; // e.g., "openai", "anthropic"
	pipeline?: string | null; // e.g., "exa:websets" (full pipeline)
}
```

**Files to Create:**

- `packages/plugin/src/types/sub-provider.types.ts`

---

## Task 1.22: PluginIcon Types

**Title:** Define PluginIcon type with multiple format support

**Description:**
Create the `PluginIcon` type that supports SVG strings, URLs, base64 data, and Lucide icon names.

**Implementation Details:**

```typescript
// src/types/icon.types.ts

/**
 * Plugin icon definition supporting multiple formats.
 * Plugins can provide icons in any of these formats.
 */
export interface PluginIcon {
	/** Icon type determines how to render */
	type: 'svg' | 'url' | 'base64' | 'lucide';

	/** Icon data based on type:
	 * - svg: Raw SVG string
	 * - url: URL to image file
	 * - base64: Base64-encoded image data
	 * - lucide: Lucide icon name (e.g., "github", "cloud")
	 */
	value: string;

	/** Optional background color for icon container */
	backgroundColor?: string;

	/** Optional foreground/stroke color for SVG/Lucide icons */
	color?: string;
}

/**
 * Create a Lucide icon reference
 */
export function lucideIcon(name: string, color?: string): PluginIcon {
	return { type: 'lucide', value: name, color };
}

/**
 * Create an SVG icon
 */
export function svgIcon(svg: string, color?: string): PluginIcon {
	return { type: 'svg', value: svg, color };
}

/**
 * Create a URL icon
 */
export function urlIcon(url: string): PluginIcon {
	return { type: 'url', value: url };
}

/**
 * Create a base64 icon
 */
export function base64Icon(data: string): PluginIcon {
	return { type: 'base64', value: data };
}
```

**Files to Create:**

- `packages/plugin/src/types/icon.types.ts`

---

## Task 1.23: PipelineStepDefinition Interface

**Title:** Define PipelineStepDefinition interface for step metadata

**Description:**
Create the `PipelineStepDefinition` interface that defines pipeline step metadata including dependencies, provides, category, and execution options.

**Implementation Details:**

```typescript
// src/types/pipeline-step.types.ts

/**
 * Pipeline step definition with explicit dependencies.
 * Used by both built-in steps and plugin steps.
 */
export interface PipelineStepDefinition {
	/** Unique step ID (e.g., "item-extraction", "spam-filter:check") */
	id: string;

	/** Display name for UI/logs */
	name: string;

	/** Step description */
	description?: string;

	/**
	 * Dependencies: step IDs that must complete before this step runs.
	 */
	dependencies: string[];

	/**
	 * What this step produces (for dependency validation).
	 */
	provides?: string[];

	/**
	 * Category this step belongs to (for provider override).
	 */
	category?: 'search' | 'screenshot' | 'ai' | 'content';

	/** Can this step run in parallel with others that share no dependencies? */
	parallelizable?: boolean;

	/** Is this step optional? If true, pipeline continues even if step fails. */
	optional?: boolean;

	/** Timeout in milliseconds for this step. */
	timeout?: number;
}
```

**Files to Create:**

- `packages/plugin/src/types/pipeline-step.types.ts`

---

## Task 1.24: StepPosition Types

**Title:** Define StepPosition union type for step placement directives

**Description:**
Create the `StepPosition` type that specifies where plugin steps should be placed relative to existing steps (before, after, replace, disable, append, prepend).

**Implementation Details:**

```typescript
// src/types/pipeline-step.types.ts (continued)

/**
 * Position directive for step injection/replacement/disable
 */
export type StepPosition =
	| { type: 'before'; stepId: string } // Insert before existing step
	| { type: 'after'; stepId: string } // Insert after existing step
	| { type: 'replace'; stepId: string } // Replace existing step entirely
	| { type: 'disable'; stepId: string } // Disable/remove existing step
	| { type: 'append' } // Add to end of pipeline
	| { type: 'prepend' }; // Add to start of pipeline

/**
 * Helper type guards for StepPosition
 */
export function isBeforePosition(pos: StepPosition): pos is { type: 'before'; stepId: string } {
	return pos.type === 'before';
}

export function isAfterPosition(pos: StepPosition): pos is { type: 'after'; stepId: string } {
	return pos.type === 'after';
}

export function isReplacePosition(pos: StepPosition): pos is { type: 'replace'; stepId: string } {
	return pos.type === 'replace';
}

export function isDisablePosition(pos: StepPosition): pos is { type: 'disable'; stepId: string } {
	return pos.type === 'disable';
}
```

**Files to Update:**

- `packages/plugin/src/types/pipeline-step.types.ts`

---

## Task 1.25: ParallelGroup Types

**Title:** Define ParallelGroup interface for concurrent step execution

**Description:**
Create the `ParallelGroup` interface that represents a group of steps that can execute concurrently because they share the same dependencies.

**Implementation Details:**

```typescript
// src/types/pipeline-step.types.ts (continued)

/**
 * A group of steps in the pipeline execution plan.
 * Steps in a parallel group can run concurrently.
 */
export interface ParallelGroup {
	/** Steps in this group */
	steps: PipelineStepDefinition[];

	/** Whether these steps can run in parallel */
	parallel: boolean;

	/** Dependencies that must complete before this group runs */
	dependsOn: string[];
}

/**
 * Result of identifying parallel groups from step list
 */
export interface ParallelGroupResult {
	groups: ParallelGroup[];
	executionOrder: string[]; // Flat list of step IDs in execution order
}
```

**Files to Update:**

- `packages/plugin/src/types/pipeline-step.types.ts`

---

## Task 1.26: ExecutablePipeline Types

**Title:** Define ExecutablePipeline interface for compiled pipelines

**Description:**
Create the `ExecutablePipeline` interface that represents a fully compiled pipeline ready for execution, with ordered steps and parallel groups.

**Implementation Details:**

```typescript
// src/types/pipeline-step.types.ts (continued)

/**
 * A fully compiled pipeline ready for execution.
 * Contains ordered steps, parallel groups, and executor mapping.
 */
export interface ExecutablePipeline {
	/** All steps in topological order */
	steps: PipelineStepDefinition[];

	/** Groups of steps (some parallel, some sequential) */
	groups: ParallelGroup[];

	/** Map from step ID to its executor (built-in service or plugin) */
	executorMap: Map<string, StepExecutor>;

	/** Original step IDs that were replaced */
	replacedSteps: Map<string, string>; // original -> replacement

	/** Step IDs that were disabled */
	disabledSteps: Set<string>;

	/** Step IDs that were injected by plugins */
	injectedSteps: Set<string>;
}

/**
 * A step executor - either built-in or plugin-provided
 */
export type StepExecutor =
	| { type: 'builtin'; serviceId: string }
	| { type: 'plugin'; pluginId: string; stepId: string };
```

**Files to Update:**

- `packages/plugin/src/types/pipeline-step.types.ts`

---

# Story 2: Plugin System Runtime

**Story Title:** Create Plugin System Runtime

**Story Description:**
Create the plugin runtime system in `packages/agent` that handles plugin discovery, loading, lifecycle management, settings resolution, and the plugin registry. This is the core engine that makes the plugin system work.

**Acceptance Criteria:**

- Plugins are discovered from configured paths
- Plugin lifecycle is properly managed
- Settings are resolved correctly (Directory → User → Defaults)
- Plugin registry provides access to enabled plugins
- Custom capability registry works for plugin-to-plugin communication

---

## Task 2.1: Plugin Registry Service

**Title:** Create PluginRegistry service

**Description:**
Create the central registry service that tracks all loaded plugins and provides methods to query plugins by category, capability, or enabled status.

**Implementation Details:**

```typescript
// src/plugins/plugin-registry.service.ts
@Injectable()
export class PluginRegistryService {
	private plugins: Map<string, LoadedPlugin> = new Map();

	register(plugin: IPlugin, manifest: PluginManifest, path: string): void;
	unregister(pluginId: string): void;

	get(pluginId: string): LoadedPlugin | undefined;
	getAll(): LoadedPlugin[];

	getByCategory(category: PluginCategory): LoadedPlugin[];
	getByCapability(capability: string): LoadedPlugin[];

	getEnabled<T extends IPlugin>(directory: Directory, category: PluginCategory): T | undefined;

	getAllEnabled(directory: Directory): LoadedPlugin[];

	isEnabled(pluginId: string, directory: Directory): boolean;
}

interface LoadedPlugin {
	instance: IPlugin;
	manifest: PluginManifest;
	path: string;
	state: PluginState;
	loadedAt: Date;
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-registry.service.ts`

---

## Task 2.2: Plugin Loader Service

**Title:** Create PluginLoader service for discovery and loading

**Description:**
Create the service that discovers plugins from configured filesystem paths, reads their package.json, and loads their entry points.

**Implementation Details:**

```typescript
// src/plugins/plugin-loader.service.ts
@Injectable()
export class PluginLoaderService {
	constructor(
		private readonly manifestValidator: PluginManifestValidator,
		private readonly versionChecker: PluginVersionChecker,
		private readonly classValidator: PluginClassValidator,
		private readonly registry: PluginRegistryService,
		private readonly contextFactory: PluginContextFactory
	) {}

	async discoverPlugins(paths: string[]): Promise<DiscoveryResult>;
	async loadPlugin(pluginPath: string): Promise<LoadResult>;
	async unloadPlugin(pluginId: string): Promise<void>;
	async reloadPlugin(pluginId: string): Promise<LoadResult>;

	private async scanPath(path: string): Promise<string[]>;
	private async readManifest(pluginPath: string): Promise<PluginManifest | null>;
	private async loadEntryPoint(pluginPath: string, main: string): Promise<IPlugin>;
}

interface DiscoveryResult {
	loaded: string[];
	skipped: SkippedPlugin[];
	errors: PluginError[];
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-loader.service.ts`

---

## Task 2.3: Plugin Manifest Validator

**Title:** Create PluginManifestValidator service

**Description:**
Create a service that validates the `everworks.plugin` field in package.json, ensuring all required fields are present and valid.

**Implementation Details:**

```typescript
// src/plugins/plugin-manifest-validator.service.ts
@Injectable()
export class PluginManifestValidator {
	validate(manifest: unknown): ManifestValidationResult {
		const errors: string[] = [];

		// Required fields
		if (!manifest.id) errors.push('Missing required field: id');
		if (!manifest.name) errors.push('Missing required field: name');
		if (!manifest.version) errors.push('Missing required field: version');
		if (!manifest.category) errors.push('Missing required field: category');

		// Validate category
		if (manifest.category && !VALID_CATEGORIES.includes(manifest.category)) {
			errors.push(`Invalid category: ${manifest.category}`);
		}

		// Validate version format (semver)
		if (manifest.version && !semver.valid(manifest.version)) {
			errors.push(`Invalid version format: ${manifest.version}`);
		}

		return {
			valid: errors.length === 0,
			errors,
			manifest: errors.length === 0 ? (manifest as PluginManifest) : undefined
		};
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-manifest-validator.service.ts`

---

## Task 2.4: Plugin Version Checker

**Title:** Create PluginVersionChecker service

**Description:**
Create a service that checks plugin compatibility with the current plugin version using minContractsVersion and maxContractsVersion.

**Implementation Details:**

```typescript
// src/plugins/plugin-version-checker.service.ts
@Injectable()
export class PluginVersionChecker {
	private contractsVersion: string;

	constructor() {
		// Read from @ever-works/plugin package.json
		this.contractsVersion = this.getContractsVersion();
	}

	checkCompatibility(manifest: PluginManifest): VersionCheckResult {
		const { minContractsVersion, maxContractsVersion } = manifest;

		if (minContractsVersion && semver.lt(this.contractsVersion, minContractsVersion)) {
			return {
				compatible: false,
				reason: `Requires plugin >= ${minContractsVersion}, current: ${this.contractsVersion}`
			};
		}

		if (maxContractsVersion && semver.gt(this.contractsVersion, maxContractsVersion)) {
			return {
				compatible: false,
				reason: `Requires plugin <= ${maxContractsVersion}, current: ${this.contractsVersion}`
			};
		}

		return { compatible: true };
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-version-checker.service.ts`

---

## Task 2.5: Plugin Class Validator

**Title:** Create PluginClassValidator service

**Description:**
Create a service that validates the loaded plugin class implements IPlugin interface correctly with all required methods.

**Implementation Details:**

```typescript
// src/plugins/plugin-class-validator.service.ts
@Injectable()
export class PluginClassValidator {
	validate(pluginClass: unknown): ClassValidationResult {
		const errors: string[] = [];

		// Check if it's a class/constructor
		if (typeof pluginClass !== 'function') {
			return { valid: false, errors: ['Default export is not a class'] };
		}

		// Instantiate to check interface
		const instance = new (pluginClass as any)();

		// Check required properties
		const requiredProps = ['id', 'name', 'version', 'category', 'settingsSchema'];
		for (const prop of requiredProps) {
			if (!(prop in instance)) {
				errors.push(`Missing required property: ${prop}`);
			}
		}

		// Check required methods
		const requiredMethods = ['onLoad', 'onEnable', 'onDisable', 'onUnload', 'validateSettings'];
		for (const method of requiredMethods) {
			if (typeof instance[method] !== 'function') {
				errors.push(`Missing required method: ${method}`);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			instance: errors.length === 0 ? instance : undefined
		};
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-class-validator.service.ts`

---

## Task 2.6: Plugin Lifecycle Manager

**Title:** Create PluginLifecycleManager service

**Description:**
Create a service that manages plugin state transitions (load, enable, disable, unload) and calls the appropriate lifecycle hooks.

**Implementation Details:**

```typescript
// src/plugins/plugin-lifecycle.service.ts
@Injectable()
export class PluginLifecycleManager {
	constructor(
		private readonly registry: PluginRegistryService,
		private readonly contextFactory: PluginContextFactory
	) {}

	async load(plugin: IPlugin): Promise<void> {
		const context = this.contextFactory.create(plugin);
		await plugin.onLoad(context);
		this.registry.updateState(plugin.id, 'loaded');
	}

	async enable(pluginId: string, directory: Directory): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const context = this.contextFactory.create(plugin.instance, directory);
		await plugin.instance.onEnable(context);
		this.registry.updateState(pluginId, 'enabled');
	}

	async disable(pluginId: string, directory: Directory): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const context = this.contextFactory.create(plugin.instance, directory);
		await plugin.instance.onDisable(context);
		this.registry.updateState(pluginId, 'disabled');
	}

	async unload(pluginId: string): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		await plugin.instance.onUnload();
		this.registry.updateState(pluginId, 'unloaded');
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-lifecycle.service.ts`

---

## Task 2.7: Plugin Settings Service

**Title:** Create PluginSettingsService for settings resolution with 4-level hierarchy and security marker handling

**Description:**
Create a service that resolves plugin settings using a **4-level hierarchy**:

```
1. Plugin Defaults (hardcoded in plugin)
         ↓
2. Admin Settings (platform-wide, stored in AdminPlugin entity)
         ↓
3. User Settings (per-user, stored in UserPlugin entity)
         ↓
4. Directory Settings (per-directory, stored in DirectoryPlugin entity)
```

The service must also:

- Respect the plugin's `configurationMode` (admin-only, user-required, hybrid)
- Handle **security markers** defined in the plugin's `settingsSchema`:
    - **`secret: true`** - Encrypt field value at rest in database
    - **`masked: true`** - Return masked value ("**\*\*\*\***") for UI display
    - **`writeOnly: true`** - Exclude field from API GET responses

**Configuration Mode Behavior:**

| Mode               | Admin Settings    | User Settings     | Directory Settings |
| ------------------ | ----------------- | ----------------- | ------------------ |
| `admin-only`       | Required          | Ignored           | Ignored            |
| `user-required`    | Ignored           | Required          | Optional override  |
| `hybrid` (default) | Optional fallback | Optional override | Optional override  |

**Implementation Details:**

```typescript
// src/plugins/plugin-settings.service.ts
@Injectable()
export class PluginSettingsService {
	constructor(
		@InjectRepository(AdminPlugin)
		private readonly adminPluginRepo: Repository<AdminPlugin>,
		@InjectRepository(UserPlugin)
		private readonly userPluginRepo: Repository<UserPlugin>,
		@InjectRepository(DirectoryPlugin)
		private readonly directoryPluginRepo: Repository<DirectoryPlugin>,
		private readonly registry: PluginRegistryService,
		private readonly encryption: EncryptionService
	) {}

	/**
	 * Resolve settings with full decryption (for internal plugin use).
	 * This returns actual secret values - use only when executing plugin operations.
	 *
	 * Resolution order (each level overrides previous):
	 * 1. Plugin defaults
	 * 2. Admin settings (if mode is 'admin-only' or 'hybrid')
	 * 3. User settings (if mode is 'user-required' or 'hybrid')
	 * 4. Directory settings (if provided and mode allows)
	 */
	async resolveSettings<T>(
		pluginId: string,
		userId?: string, // Optional for admin-only plugins
		directoryId?: string
	): Promise<T> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const schema = plugin.instance.settingsSchema;
		const mode = plugin.instance.configurationMode ?? 'hybrid';

		// 1. Start with plugin defaults
		let settings = this.getDefaultSettings(plugin.instance);

		// 2. Merge admin settings (for admin-only and hybrid modes)
		if (mode === 'admin-only' || mode === 'hybrid') {
			const adminPlugin = await this.adminPluginRepo.findOne({
				where: { pluginId }
			});
			if (adminPlugin?.settings) {
				const decrypted = this.decryptSecretFields(adminPlugin.settings, schema);
				settings = { ...settings, ...decrypted };
			}
		}

		// 3. For admin-only plugins, stop here (ignore user/directory settings)
		if (mode === 'admin-only') {
			return settings as T;
		}

		// 4. Merge user settings (for user-required and hybrid modes)
		if (userId && (mode === 'user-required' || mode === 'hybrid')) {
			const userPlugin = await this.userPluginRepo.findOne({
				where: { pluginId, userId }
			});
			if (userPlugin?.settings) {
				const decrypted = this.decryptSecretFields(userPlugin.settings, schema);
				settings = { ...settings, ...decrypted };
			}
		}

		// 5. Merge directory settings (overrides)
		if (directoryId) {
			const dirPlugin = await this.directoryPluginRepo.findOne({
				where: { pluginId, directoryId }
			});
			if (dirPlugin?.settings) {
				const decrypted = this.decryptSecretFields(dirPlugin.settings, schema);
				settings = { ...settings, ...decrypted };
			}
		}

		return settings as T;
	}

	/**
	 * Get settings for API response (respects writeOnly, masks values).
	 * Use this when returning settings to the frontend.
	 */
	async getSettingsForApi<T>(pluginId: string, userId?: string, directoryId?: string): Promise<T> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const schema = plugin.instance.settingsSchema;
		const settings = await this.resolveSettings(pluginId, userId, directoryId);

		return this.processForApiResponse(settings, schema) as T;
	}

	/**
	 * Save admin settings (platform-wide defaults).
	 * Only callable by admins.
	 */
	async saveAdminSettings(pluginId: string, settings: Record<string, unknown>): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const schema = plugin.instance.settingsSchema;
		const encrypted = this.encryptSecretFields(settings, schema);

		await this.adminPluginRepo.upsert({ pluginId, settings: encrypted }, ['pluginId']);
	}

	/**
	 * Save user settings (encrypts secret fields before storage).
	 * Validates that plugin allows user configuration.
	 */
	async saveUserSettings(pluginId: string, userId: string, settings: Record<string, unknown>): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const mode = plugin.instance.configurationMode ?? 'hybrid';
		if (mode === 'admin-only') {
			throw new Error(`Plugin ${pluginId} is admin-only and cannot be configured by users`);
		}

		const schema = plugin.instance.settingsSchema;
		const encrypted = this.encryptSecretFields(settings, schema);

		await this.userPluginRepo.upsert({ pluginId, userId, settings: encrypted }, ['pluginId', 'userId']);
	}

	/**
	 * Save directory settings (encrypts secret fields before storage).
	 */
	async saveDirectorySettings(
		pluginId: string,
		directoryId: string,
		settings: Record<string, unknown>
	): Promise<void> {
		const plugin = this.registry.get(pluginId);
		if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

		const mode = plugin.instance.configurationMode ?? 'hybrid';
		if (mode === 'admin-only') {
			throw new Error(`Plugin ${pluginId} is admin-only and cannot be configured per-directory`);
		}

		const schema = plugin.instance.settingsSchema;
		const encrypted = this.encryptSecretFields(settings, schema);

		await this.directoryPluginRepo.upsert({ pluginId, directoryId, settings: encrypted }, [
			'pluginId',
			'directoryId'
		]);
	}

	/**
	 * Check if user can configure this plugin.
	 */
	canUserConfigure(pluginId: string): boolean {
		const plugin = this.registry.get(pluginId);
		if (!plugin) return false;

		const mode = plugin.instance.configurationMode ?? 'hybrid';
		return mode !== 'admin-only';
	}

	/**
	 * Check if admin settings are required for this plugin to work.
	 */
	requiresAdminSettings(pluginId: string): boolean {
		const plugin = this.registry.get(pluginId);
		if (!plugin) return false;

		const mode = plugin.instance.configurationMode ?? 'hybrid';
		return mode === 'admin-only';
	}

	/**
	 * Encrypt fields marked with `secret: true` in schema.
	 */
	private encryptSecretFields(settings: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
		const result = { ...settings };

		for (const [key, prop] of Object.entries(schema.properties)) {
			if (prop.secret && result[key] != null) {
				result[key] = this.encryption.encrypt(String(result[key]));
			}
		}

		return result;
	}

	/**
	 * Decrypt fields marked with `secret: true` in schema.
	 */
	private decryptSecretFields(settings: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
		const result = { ...settings };

		for (const [key, prop] of Object.entries(schema.properties)) {
			if (prop.secret && result[key] != null) {
				result[key] = this.encryption.decrypt(String(result[key]));
			}
		}

		return result;
	}

	/**
	 * Process settings for API response:
	 * - Exclude `writeOnly` fields (or return "********")
	 * - Mask `masked` fields
	 */
	private processForApiResponse(settings: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
		const result = { ...settings };

		for (const [key, prop] of Object.entries(schema.properties)) {
			if (prop.writeOnly) {
				// writeOnly fields are never returned to client
				result[key] = result[key] != null ? '********' : undefined;
			} else if (prop.masked && result[key] != null) {
				// masked fields show asterisks but aren't writeOnly
				result[key] = '********';
			}
		}

		return result;
	}

	private getDefaultSettings(plugin: IPlugin): Record<string, unknown> {
		const defaults: Record<string, unknown> = {};
		for (const [key, prop] of Object.entries(plugin.settingsSchema.properties)) {
			if (prop.default !== undefined) {
				defaults[key] = prop.default;
			}
		}
		return defaults;
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-settings.service.ts`

---

## Task 2.8: Plugin Context Factory

**Title:** Create PluginContextFactory service

**Description:**
Create a factory that creates PluginContext instances with access to database, services, events, settings, and custom capabilities.

**Implementation Details:**

```typescript
// src/plugins/plugin-context.factory.ts
@Injectable()
export class PluginContextFactory {
	constructor(
		private readonly dataSource: DataSource,
		private readonly eventEmitter: EventEmitter2,
		private readonly settingsService: PluginSettingsService,
		private readonly capabilityRegistry: CustomCapabilityRegistryService,
		private readonly cacheManager: CacheManager,
		// Inject core services
		private readonly directoryService: DirectoryQueryService,
		private readonly userService: UserService
	) {}

	create(plugin: IPlugin, directory?: Directory, user?: User): PluginContext {
		return {
			dataSource: this.dataSource,
			getRepository: <T>(entity: EntityTarget<T>) => this.dataSource.getRepository(entity),

			services: {
				directory: this.directoryService,
				user: this.userService
			},

			eventEmitter: this.eventEmitter,
			onEvent: (event, handler) => this.eventEmitter.on(event, handler),
			emitEvent: (event, payload) => this.eventEmitter.emit(event, payload),

			getSettings: () => this.settingsService.resolveSettings(plugin.id, user?.id, directory?.id),
			getUserSettings: (userId) => this.settingsService.resolveSettings(plugin.id, userId),
			getDirectorySettings: (dirId) => this.settingsService.resolveSettings(plugin.id, user?.id, dirId),

			registerController: (controller) => this.registerController(plugin.id, controller),

			registerCustomCapability: (id, impl, meta) =>
				this.capabilityRegistry.register(id, impl, { ...meta, pluginId: plugin.id }),
			getCustomCapability: (id) => this.capabilityRegistry.get(id),
			hasCustomCapability: (id) => this.capabilityRegistry.has(id),
			listCustomCapabilities: () => this.capabilityRegistry.list(),

			logger: new Logger(`Plugin:${plugin.id}`),
			cache: this.cacheManager
		};
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/plugin-context.factory.ts`

---

## Task 2.9: Custom Capability Registry

**Title:** Create CustomCapabilityRegistryService

**Description:**
Create the registry service that manages custom capabilities for plugin-to-plugin communication.

**Implementation Details:**

```typescript
// src/plugins/custom-capability-registry.service.ts
@Injectable()
export class CustomCapabilityRegistryService implements ICustomCapabilityRegistry {
	private capabilities: Map<string, CapabilityRegistration> = new Map();

	register<T>(capabilityId: string, implementation: T, metadata?: CapabilityMetadata & { pluginId: string }): void {
		if (this.capabilities.has(capabilityId)) {
			throw new Error(`Capability already registered: ${capabilityId}`);
		}

		this.capabilities.set(capabilityId, {
			id: capabilityId,
			implementation,
			metadata,
			pluginId: metadata?.pluginId || 'unknown',
			registeredAt: new Date()
		});
	}

	unregister(capabilityId: string): void {
		this.capabilities.delete(capabilityId);
	}

	get<T>(capabilityId: string): T | undefined {
		const registration = this.capabilities.get(capabilityId);
		return registration?.implementation as T | undefined;
	}

	has(capabilityId: string): boolean {
		return this.capabilities.has(capabilityId);
	}

	list(): CapabilityInfo[] {
		return Array.from(this.capabilities.values()).map((reg) => ({
			id: reg.id,
			providedBy: reg.pluginId,
			metadata: reg.metadata,
			registeredAt: reg.registeredAt
		}));
	}

	// Called when a plugin is unloaded
	unregisterByPlugin(pluginId: string): void {
		for (const [id, reg] of this.capabilities) {
			if (reg.pluginId === pluginId) {
				this.capabilities.delete(id);
			}
		}
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/custom-capability-registry.service.ts`

---

## Task 2.10: Plugin Entities

**Title:** Create TypeORM entities for plugin storage

**Description:**
Create the database entities for storing plugin state, admin plugin settings, user plugin installations, and directory plugin settings. The 4-level settings hierarchy requires:

1. **Plugin** - Plugin metadata and state
2. **AdminPlugin** - Platform-wide admin-configured settings
3. **UserPlugin** - Per-user plugin installations and settings
4. **DirectoryPlugin** - Per-directory plugin settings

**Implementation Details:**

```typescript
// src/plugins/entities/plugin.entity.ts
@Entity('plugins')
export class Plugin {
	@PrimaryColumn()
	id: string;

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
	path: string;

	@Column({ default: 'loaded' })
	state: string;

	@CreateDateColumn()
	loadedAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

// src/plugins/entities/admin-plugin.entity.ts
/**
 * Admin-level plugin settings (platform-wide defaults).
 *
 * This entity stores settings configured by platform administrators
 * that serve as defaults for all users. Used when:
 * - Plugin is 'admin-only' (only source of settings)
 * - Plugin is 'hybrid' (provides fallback for users without their own settings)
 *
 * Use cases:
 * - Platform-provided shared API keys
 * - Default configuration for all users
 * - Admin-only plugins that users shouldn't configure
 */
@Entity('admin_plugins')
export class AdminPlugin {
	@PrimaryColumn()
	pluginId: string;

	/**
	 * Admin-configured settings (encrypted secret fields).
	 * These are platform-wide defaults that users may override
	 * (unless plugin is 'admin-only').
	 */
	@Column('simple-json', { nullable: true })
	settings: Record<string, unknown>;

	/**
	 * Whether this plugin is enabled platform-wide.
	 * If false, the plugin is disabled for all users regardless
	 * of their individual settings.
	 */
	@Column({ default: true })
	enabled: boolean;

	/**
	 * Admin notes about this plugin configuration.
	 * For internal documentation purposes.
	 */
	@Column({ type: 'text', nullable: true })
	notes: string;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;

	/**
	 * ID of the admin who last modified these settings.
	 * Nullable for migration purposes.
	 */
	@Column({ nullable: true })
	updatedBy: string;
}

// src/plugins/entities/user-plugin.entity.ts
@Entity('user_plugins')
export class UserPlugin {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	userId: string;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'userId' })
	user: User;

	@Column()
	pluginId: string;

	@Column('simple-json', { nullable: true })
	settings: Record<string, unknown>;

	@Column({ default: true })
	enabled: boolean;

	@CreateDateColumn()
	installedAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}

// src/plugins/entities/directory-plugin.entity.ts
@Entity('directory_plugins')
export class DirectoryPlugin {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	directoryId: string;

	@ManyToOne(() => Directory, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'directoryId' })
	directory: Directory;

	@Column()
	pluginId: string;

	@Column('simple-json', { nullable: true })
	settings: Record<string, unknown>;

	@Column({ default: true })
	enabled: boolean;

	@CreateDateColumn()
	enabledAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
```

**Files to Create:**

- `packages/agent/src/plugins/entities/plugin.entity.ts`
- `packages/agent/src/plugins/entities/admin-plugin.entity.ts`
- `packages/agent/src/plugins/entities/user-plugin.entity.ts`
- `packages/agent/src/plugins/entities/directory-plugin.entity.ts`

---

## Task 2.11: PluginsModule

**Title:** Create PluginsModule with forRoot configuration

**Description:**
Create the NestJS module that configures plugin discovery paths and exports all plugin services.

**Implementation Details:**

```typescript
// src/plugins/plugins.module.ts
@Module({})
export class PluginsModule {
	static forRoot(options: PluginsModuleOptions): DynamicModule {
		return {
			module: PluginsModule,
			imports: [TypeOrmModule.forFeature([Plugin, UserPlugin, DirectoryPlugin])],
			providers: [
				{
					provide: PLUGINS_OPTIONS,
					useValue: options
				},
				PluginRegistryService,
				PluginLoaderService,
				PluginManifestValidator,
				PluginVersionChecker,
				PluginClassValidator,
				PluginLifecycleManager,
				PluginSettingsService,
				PluginContextFactory,
				CustomCapabilityRegistryService
			],
			exports: [PluginRegistryService, PluginSettingsService, CustomCapabilityRegistryService]
		};
	}
}

export interface PluginsModuleOptions {
	paths: string[]; // Glob patterns for plugin discovery
	autoLoad?: boolean; // Auto-load on module init (default: true)
}

export const PLUGINS_OPTIONS = 'PLUGINS_OPTIONS';
```

**Files to Create:**

- `packages/agent/src/plugins/plugins.module.ts`

---

## Task 2.12: Add plugin dependency

**Title:** Add @ever-works/plugin as dependency

**Description:**
Update packages/agent/package.json to depend on @ever-works/plugin.

**Implementation Details:**

```json
// packages/agent/package.json
{
	"dependencies": {
		"@ever-works/plugin": "workspace:*"
	}
}
```

**Files to Update:**

- `packages/agent/package.json`

---

# Story 3: Pipeline Refactoring

**Story Title:** Refactor Pipeline to be Fully Plugin-Driven with Step Injection Support

**Story Description:**
Refactor the items-generator pipeline to be fully plugin-driven, supporting:

1. **Full pipeline replacement** (like Exa.ai Websets)
2. **Step injection** (adding new steps before/after existing ones)
3. **Step replacement** (swapping existing steps with plugin implementations)
4. **Step disabling** (removing steps from the pipeline)

The pipeline must support explicit step dependencies, parallel execution, and topological sorting.

**Acceptance Criteria:**

- Pipeline can be replaced entirely by IFullPipelinePlugin
- Pipeline steps can be added before/after existing steps (injection)
- Pipeline steps can replace existing steps
- Pipeline steps can be disabled/removed
- Steps declare explicit dependencies for topological sorting
- Steps with same dependencies and parallelizable=true run in parallel
- Built-in steps defined as default plugin with PipelineStepDefinition
- PipelineBuilderService compiles pipeline from plugins

---

## Task 3.1: GenerationContext Refactor

**Title:** Refactor GenerationContext for dependency-based data flow

**Description:**
Update GenerationContext to include `stepResults: Map<string, unknown>` for step-to-step data flow based on dependencies.

**Implementation Details:**

```typescript
// src/pipeline/generation-context.ts
export interface GenerationContext {
	directory: Directory;
	user: User;
	dto: CreateItemsGeneratorDto;
	items: Item[];
	plugins: PluginRegistryService;
	settings: ResolvedSettings;
	logger: Logger;
	metrics: PipelineMetrics;

	// Step results for dependency-based data flow
	stepResults: Map<string, unknown>;

	// Methods
	setStepResult(stepId: string, result: unknown): void;
	getStepResult<T>(stepId: string): T | undefined;
}
```

**Files to Create:**

- `packages/agent/src/pipeline/generation-context.ts`

---

## Task 3.2: Built-in Steps Definition

**Title:** Define BUILT_IN_STEPS array with explicit dependencies

**Description:**
Create the BUILT_IN_STEPS constant array containing all 14 built-in pipeline steps with explicit dependencies, provides, category, and parallelizable flags.

**⚠️ TYPE SAFETY IS CRITICAL**

The pipeline system MUST be strongly typed to catch errors at compile time, not runtime. This includes:

1. **Step IDs** - Must be a union type, not arbitrary strings
2. **Data Keys** - What steps `provide` and `depend on` must be typed
3. **Step Results** - Data passed between steps must have known types

**Implementation Details:**

```typescript
// src/pipeline/step-types.ts
// ============================================
// STEP IDS - Compile-time validated
// ============================================

/** All valid built-in step IDs */
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

// ============================================
// DATA KEYS - What steps produce/consume
// ============================================

/** All valid data keys that steps can provide or depend on */
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

// ============================================
// STEP RESULT TYPES - Strongly typed data
// ============================================

/** Map of data keys to their TypeScript types */
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
// TYPE-SAFE CONTEXT ACCESS
// ============================================

/** Type-safe method to get step results */
interface GenerationContext {
	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined;
	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void;
}

// Example usage - compiler catches typos!
const items = context.getStepResult('extracted-items'); // ✅ Type: ExtractedItem[] | undefined
const bad = context.getStepResult('extrcted-items'); // ❌ Compile error: typo caught!
```

```typescript
// src/pipeline/built-in-steps.ts
import { BuiltInStepId, StepDataKey } from './step-types';

/** Type-safe step definition */
export interface TypedPipelineStepDefinition {
	id: BuiltInStepId | `${string}:${string}`; // Built-in or plugin:step format
	name: string;
	description?: string;
	dependencies: (BuiltInStepId | StepDataKey)[];
	provides: StepDataKey[];
	category?: 'search' | 'screenshot' | 'ai' | 'content';
	parallelizable?: boolean;
	optional?: boolean;
}

export const BUILT_IN_STEPS: TypedPipelineStepDefinition[] = [
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
		dependencies: ['prompt-comparison'], // ✅ Validated at compile time
		provides: ['processed-prompt', 'subject', 'featured-hints']
	},
	{
		id: 'domain-detection',
		name: 'Domain Detection',
		dependencies: ['prompt-processing'],
		provides: ['domain-analysis']
	},
	{
		id: 'search-query-generation',
		name: 'Search Query Generation',
		dependencies: ['domain-detection'],
		provides: ['search-queries'],
		category: 'search',
		parallelizable: true
	},
	{
		id: 'ai-item-generation',
		name: 'AI Item Generation',
		dependencies: ['domain-detection'],
		provides: ['ai-items'],
		category: 'ai',
		parallelizable: true
	}
	// ... remaining 9 steps
] as const satisfies TypedPipelineStepDefinition[];
// Using `satisfies` ensures type checking while preserving literal types
```

**Why Type Safety Matters:**

| Without Types                                                | With Types                                            |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `dependencies: ['promt-processing']` - Typo found at runtime | Compile error: `'promt-processing'` is not assignable |
| `context.get('extrcted-items')` - Returns undefined silently | Compile error: invalid key                            |
| Wrong data type passed between steps - Runtime crash         | Compile error: type mismatch                          |

**Files to Create:**

- `packages/agent/src/pipeline/step-types.ts`
- `packages/agent/src/pipeline/built-in-steps.ts`

---

## Task 3.3: Default Pipeline Plugin (System Plugin)

**Title:** Create default pipeline plugin wrapping built-in steps

**Description:**
Create a default IPipelineStepPlugin that wraps built-in steps. This is a **system plugin** - it is always loaded, automatically installed for all users, and **NOT visible in the user plugins UI**.

**Why System Plugin?**

1. **Core Infrastructure** - The standard 14-step pipeline is foundational to Ever Works
2. **Always Needed** - Even when using full-pipeline plugins, the default steps are referenced for replacements and injections
3. **No User Configuration** - Users don't configure the pipeline itself; they configure individual providers (Search, Screenshot, AI, etc.)
4. **Prevents Accidental Removal** - Users shouldn't be able to break their pipeline by uninstalling core functionality

**Plugin Manifest:**

```json
{
	"everworks.plugin": {
		"id": "default-pipeline",
		"name": "Standard Pipeline",
		"version": "1.0.0",
		"category": "pipeline",
		"autoInstall": true,
		"systemPlugin": true,
		"description": "Built-in pipeline with 14 standard steps for directory generation"
	}
}
```

**User Interaction:**

- Users interact with the pipeline **indirectly** by selecting providers (Search, Screenshot, AI) in the generator form
- The selected providers are then applied to the appropriate pipeline steps
- Users see "Standard Pipeline" vs "Full Pipeline (e.g., Exa Websets)" choice, not the individual steps

**Files to Create:**

- `packages/agent/src/pipeline/default-pipeline.plugin.ts`

---

## Task 3.4: PipelineBuilderService

**Title:** Create PipelineBuilderService for pipeline compilation

**Description:**
Create the service that builds an ExecutablePipeline from enabled plugins by collecting steps, applying positions, and performing topological sort.

**Implementation Details:**

```typescript
// src/pipeline/pipeline-builder.service.ts
@Injectable()
export class PipelineBuilderService {
	build(directoryId: string, providers: SubProviderSelectionDto): ExecutablePipeline {
		// 1. Start with built-in steps
		let steps = [...BUILT_IN_STEPS];
		const disabledSteps = new Set<string>();
		const replacements = new Map<string, PipelineStepDefinition>();
		const injections: { step: PipelineStepDefinition; position: StepPosition }[] = [];

		// 2. Get all enabled pipeline plugins
		// 3. Process each plugin's steps
		// 4. Apply replacements
		// 5. Remove disabled steps
		// 6. Apply injections
		// 7. Apply provider overrides
		// 8. Topological sort
		// 9. Identify parallel groups

		return new ExecutablePipeline(orderedSteps, parallelGroups);
	}
}
```

**Files to Create:**

- `packages/agent/src/pipeline/pipeline-builder.service.ts`

---

## Task 3.5: Step Replacement Logic

**Title:** Implement step replacement in PipelineBuilderService

**Description:**
Handle `{ type: 'replace', stepId }` positions - swap built-in step with plugin step.

---

## Task 3.6: Step Injection Logic

**Title:** Implement step injection in PipelineBuilderService

**Description:**
Handle `{ type: 'before', stepId }` and `{ type: 'after', stepId }` positions - insert new steps at correct positions.

---

## Task 3.7: Step Disable Logic

**Title:** Implement step disabling in PipelineBuilderService

**Description:**
Handle `{ type: 'disable', stepId }` positions - remove step from pipeline.

---

## Task 3.8: Append/Prepend Logic

**Title:** Implement append/prepend positioning

**Description:**
Handle `{ type: 'append' }` and `{ type: 'prepend' }` positions - add steps at end or beginning.

---

## Task 3.9: Topological Sort

**Title:** Implement topological sort for step ordering

**Description:**
Sort steps respecting `dependencies[]` - detect cycles, handle missing dependencies.

**Implementation Details:**

```typescript
private topologicalSort(steps: PipelineStepDefinition[]): PipelineStepDefinition[] {
	const stepMap = new Map(steps.map(s => [s.id, s]));
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
```

---

## Task 3.10: Parallel Group Detection

**Title:** Identify steps that can run in parallel

**Description:**
Group steps with same dependencies and `parallelizable: true` for concurrent execution.

---

## Task 3.11: Provider Override Logic

**Title:** Apply provider overrides to category steps

**Description:**
Apply `providers.search`, `providers.screenshot`, etc. to replace steps with their category.

---

## Task 3.12: ExecutablePipeline Class

**Title:** Create ExecutablePipeline class

**Description:**
Create the compiled pipeline class containing ordered steps, parallel groups, and executor mapping.

**Files to Create:**

- `packages/agent/src/pipeline/executable-pipeline.ts`

---

## Task 3.13: StepPipelineExecutor

**Title:** Create step-based pipeline executor

**Description:**
Execute step-based pipeline: run parallel groups, handle optional steps, apply timeouts.

**Files to Create:**

- `packages/agent/src/pipeline/step-executor.service.ts`

---

## Task 3.14: FullPipelineExecutor

**Title:** Create full pipeline executor

**Description:**
Detect IFullPipelinePlugin and delegate entire generation to it.

**Files to Create:**

- `packages/agent/src/pipeline/full-pipeline-executor.service.ts`

---

## Task 3.15: Pipeline Mode Detection

**Title:** Check providers.pipeline for full vs step-based execution

**Description:**
Check `providers.pipeline` in CreateItemsGeneratorDto to determine execution mode.

---

## Task 3.16: Step Skip Logic

**Title:** Skip steps when previous step already provided data

**Description:**
Skip `web-page-retrieval` if previous step (e.g., Exa Search) already provided `web-pages`.

---

## Task 3.17: Step Metrics Tracking

**Title:** Track per-step execution metrics

**Description:**
Track per-step execution time, success/failure, item counts for debugging.

---

## Task 3.18: Step Checkpoint Saving

**Title:** Save context after each step

**Description:**
Save generation context after each step for recovery and debugging.

---

## Task 3.19: Pipeline Hooks

**Title:** Add pipeline event hooks

**Description:**
Add `beforePipeline`, `afterStep`, `onStepError`, `afterPipeline` events for observability.

**Files to Create:**

- `packages/agent/src/pipeline/pipeline-hooks.service.ts`

---

## Task 3.20: Plugin Step Executor Mapping

**Title:** Map step IDs to executors

**Description:**
Map step IDs to their executor - built-in service or `plugin.executeStep()`.

---

## Task 3.21: Dependency Validation

**Title:** Validate step dependencies before execution

**Description:**
Validate all step dependencies exist before starting pipeline execution.

---

## Task 3.22: Circular Dependency Detection

**Title:** Detect circular dependencies in step graph

**Description:**
Detect and error on circular dependencies during topological sort.

---

## Task 3.23: Convert Existing Steps

**Title:** Refactor existing 14 services to new step interface

**Description:**
Update existing step services to work with new dependency-based context

**Implementation Details:**

```typescript
// src/pipeline/pipeline-hooks.service.ts
@Injectable()
export class PipelineHooksService {
	private hooks: Map<string, PipelineHook[]> = new Map();

	register(event: PipelineHookEvent, hook: PipelineHook): void {
		const existing = this.hooks.get(event) || [];
		existing.push(hook);
		this.hooks.set(event, existing);
	}

	async emit(event: PipelineHookEvent, context: HookContext): Promise<void> {
		const hooks = this.hooks.get(event) || [];
		for (const hook of hooks) {
			await hook(context);
		}
	}
}

type PipelineHookEvent = 'beforePipeline' | 'afterStep' | 'beforeStep' | 'onError' | 'afterPipeline';

type PipelineHook = (context: HookContext) => Promise<void>;
```

**Files to Create:**

- `packages/agent/src/pipeline/pipeline-hooks.service.ts`

---

# Story 4: Built-in Plugins Package

**Story Title:** Create Built-in Plugins Package

**Story Description:**
Create `packages/plugins/` with all built-in plugins as full packages with their own package.json, implementing the appropriate capability interfaces.

**Acceptance Criteria:**

- packages/plugins directory structure is created
- Each plugin is a complete package with package.json
- Each plugin implements appropriate interfaces
- Plugins are discoverable by the plugin loader

---

## Task 4.1: Package Structure

**Title:** Set up packages/plugins workspace structure

**Description:**
Create the packages/plugins directory with shared configuration and workspace setup.

**Implementation Details:**

1. Create `packages/plugins/` directory
2. Add to pnpm-workspace.yaml:
    ```yaml
    packages:
        - 'packages/plugins/*'
    ```
3. Create shared tsconfig.base.json for plugins

**Files to Create:**

- `packages/plugins/tsconfig.base.json`

---

## Task 4.2: GitHub Plugin

**Title:** Create GitHub plugin package

**Description:**
Extract GitHub functionality from agent into a standalone plugin implementing IGitProviderPlugin and IGitOAuthPlugin.

**Implementation Details:**

1. Create `packages/plugins/github/`
2. Create package.json with everworks.plugin manifest
3. Move github.service.ts logic to plugin
4. Implement IGitProviderPlugin interface
5. Implement IGitOAuthPlugin interface

**Files to Create:**

- `packages/plugins/github/package.json`
- `packages/plugins/github/tsconfig.json`
- `packages/plugins/github/src/index.ts`
- `packages/plugins/github/src/github.plugin.ts`
- `packages/plugins/github/src/github.service.ts`
- `packages/plugins/github/src/types.ts`

---

## Task 4.3: GitLab Plugin

**Title:** Create GitLab plugin package

**Description:**
Create a new GitLab plugin implementing IGitProviderPlugin and IGitOAuthPlugin.

**Files to Create:**

- `packages/plugins/gitlab/package.json`
- `packages/plugins/gitlab/src/index.ts`
- `packages/plugins/gitlab/src/gitlab.plugin.ts`
- `packages/plugins/gitlab/src/gitlab.service.ts`

---

## Task 4.4: Vercel Plugin

**Title:** Create Vercel plugin package

**Description:**
Extract Vercel functionality from agent into a standalone plugin implementing IDeploymentPlugin.

**Files to Create:**

- `packages/plugins/vercel/package.json`
- `packages/plugins/vercel/src/index.ts`
- `packages/plugins/vercel/src/vercel.plugin.ts`
- `packages/plugins/vercel/src/vercel.service.ts`

---

## Task 4.5: Netlify Plugin

**Title:** Create Netlify plugin package

**Description:**
Create a new Netlify plugin implementing IDeploymentPlugin.

**Files to Create:**

- `packages/plugins/netlify/package.json`
- `packages/plugins/netlify/src/index.ts`
- `packages/plugins/netlify/src/netlify.plugin.ts`

---

## Task 4.6: ScreenshotOne Plugin

**Title:** Create ScreenshotOne plugin package

**Description:**
Extract ScreenshotOne functionality from agent into a standalone plugin implementing IScreenshotPlugin.

**Files to Create:**

- `packages/plugins/screenshotone/package.json`
- `packages/plugins/screenshotone/src/index.ts`
- `packages/plugins/screenshotone/src/screenshotone.plugin.ts`
- `packages/plugins/screenshotone/src/screenshotone.service.ts`

---

## Task 4.7: Tavily Plugin

**Title:** Create Tavily plugin package

**Description:**
Extract Tavily functionality into a standalone plugin implementing ISearchPlugin and IContentExtractorPlugin.

**Files to Create:**

- `packages/plugins/tavily/package.json`
- `packages/plugins/tavily/src/index.ts`
- `packages/plugins/tavily/src/tavily.plugin.ts`

---

## Task 4.8: Exa Plugin

**Title:** Create Exa.ai plugin package

**Description:**
Create an Exa.ai plugin implementing IFullPipelinePlugin and ISearchPlugin.

**Files to Create:**

- `packages/plugins/exa/package.json`
- `packages/plugins/exa/src/index.ts`
- `packages/plugins/exa/src/exa.plugin.ts`

---

## Task 4.9: OpenAI Plugin

**Title:** Create OpenAI plugin package

**Description:**
Extract OpenAI functionality into a standalone plugin implementing IAiProviderPlugin.

**Files to Create:**

- `packages/plugins/openai/package.json`
- `packages/plugins/openai/src/index.ts`
- `packages/plugins/openai/src/openai.plugin.ts`

---

## Task 4.10: Anthropic Plugin

**Title:** Create Anthropic plugin package

**Description:**
Extract Anthropic functionality into a standalone plugin implementing IAiProviderPlugin.

**Files to Create:**

- `packages/plugins/anthropic/package.json`
- `packages/plugins/anthropic/src/index.ts`
- `packages/plugins/anthropic/src/anthropic.plugin.ts`

---

## Task 4.11: Notion Plugin

**Title:** Create Notion plugin package

**Description:**
Create a Notion plugin implementing IDataSourcePlugin for importing data from Notion databases.

**Files to Create:**

- `packages/plugins/notion/package.json`
- `packages/plugins/notion/src/index.ts`
- `packages/plugins/notion/src/notion.plugin.ts`

---

## Task 4.12: Apify Plugin

**Title:** Create Apify plugin package

**Description:**
Create an Apify plugin implementing IDataSourcePlugin for using Apify actors as data sources.

**Files to Create:**

- `packages/plugins/apify/package.json`
- `packages/plugins/apify/src/index.ts`
- `packages/plugins/apify/src/apify.plugin.ts`

---

# Story 5: Git Module Decoupling

**Story Title:** Decouple Git Module from GitHub

**Story Description:**
Abstract git operations behind IGitProviderPlugin interface and create a facade that uses the plugin registry.

---

## Task 5.1: Extract GitHub to Plugin

**Title:** Move github.service.ts to GitHub plugin

**Description:**
Move the existing github.service.ts code to packages/plugins/github and adapt it to implement IGitProviderPlugin.

---

## Task 5.2: Create GitService Facade

**Title:** Create Git facade that uses plugin registry

**Description:**
Create a thin GitFacade service that retrieves the enabled git provider plugin and delegates calls.

**Files to Create:**

- `packages/agent/src/facades/git.facade.ts`

---

## Task 5.3: Abstract Workflow Triggers

**Title:** Remove hardcoded GitHub Actions references

**Description:**
Abstract workflow trigger functionality so it works with any git provider that supports CI/CD.

---

## Task 5.4: Create GitLab Plugin

**Title:** Implement GitLab plugin

**Description:**
Create a fully functional GitLab plugin implementing IGitProviderPlugin.

---

## Task 5.5: Update BranchSyncService

**Title:** Update BranchSyncService to use Git facade

**Description:**
Refactor BranchSyncService to use GitFacade instead of direct GitHub service.

---

# Story 6: Deploy Module Decoupling

**Story Title:** Decouple Deploy Module from Vercel

**Story Description:**
Abstract deployment operations behind IDeploymentPlugin interface and create a facade.

---

## Task 6.1: Extract Vercel to Plugin

**Title:** Move vercel.service.ts to Vercel plugin

**Description:**
Move the existing Vercel deployment code to packages/plugins/vercel.

---

## Task 6.2: Create DeployService Facade

**Title:** Create Deploy facade that uses plugin registry

**Description:**
Create a DeployFacade service that retrieves the enabled deployment plugin.

**Files to Create:**

- `packages/agent/src/facades/deploy.facade.ts`

---

## Task 6.3: Abstract Deployment Triggers

**Title:** Remove hardcoded GitHub Actions dispatch

**Description:**
Abstract the deployment trigger mechanism so it's not tied to GitHub Actions.

---

## Task 6.4: Update BatchDeployService

**Title:** Update BatchDeployService to use Deploy facade

**Description:**
Refactor BatchDeployService to use DeployFacade instead of direct Vercel service.

---

# Story 7: Screenshot Module Decoupling

**Story Title:** Decouple Screenshot Module from ScreenshotOne

**Story Description:**
Abstract screenshot operations behind IScreenshotPlugin interface and create a facade.

---

## Task 7.1: Extract ScreenshotOne to Plugin

**Title:** Move screenshot-one.service.ts to plugin

**Description:**
Move the existing ScreenshotOne code to packages/plugins/screenshotone.

---

## Task 7.2: Create ScreenshotService Facade

**Title:** Create Screenshot facade that uses plugin registry

**Description:**
Create a ScreenshotFacade service.

**Files to Create:**

- `packages/agent/src/facades/screenshot.facade.ts`

---

## Task 7.3: Update SmartImageRouter

**Title:** Update SmartImageRouter to use Screenshot facade

**Description:**
Refactor SmartImageRouterService to use ScreenshotFacade instead of direct ScreenshotOneService.

---

# Story 8: AI Module Decoupling

**Story Title:** Decouple AI Module and Fix Provider Instantiation

**Story Description:**
Fix the AI provider switch statement (currently all map to ChatOpenAI incorrectly) and make AI providers plugin-based.

---

## Task 8.1: Fix Provider Switch

**Title:** Use correct LLM classes per provider

**Description:**
Fix the AI service to use the correct LLM class for each provider (ChatOpenAI for OpenAI, ChatAnthropic for Anthropic, etc.).

---

## Task 8.2: Extract Providers to Plugins

**Title:** Move AI providers to plugin packages

**Description:**
Create plugin packages for each AI provider (OpenAI, Anthropic, Google, Ollama, etc.).

---

## Task 8.3: Create AiService Facade

**Title:** Create AI facade that uses plugin registry

**Description:**
Create an AiFacade service.

**Files to Create:**

- `packages/agent/src/facades/ai.facade.ts`

---

## Task 8.4: Provider Factory Pattern

**Title:** Implement proper provider factory pattern

**Description:**
Create a factory that properly instantiates AI providers based on their type.

---

# Story 9: Data Source Plugins

**Story Title:** Create Data Source Abstraction and Plugins

**Story Description:**
Create the data source abstraction and extract existing importers to plugins.

---

## Task 9.1: Extract AwesomeReadme to Plugin

**Title:** Move Awesome Readme parser to plugin

**Description:**
Extract the Awesome Readme import functionality to a plugin implementing IDataSourcePlugin.

---

## Task 9.2: Create DataSource Facade

**Title:** Create DataSource facade that uses plugin registry

**Description:**
Create a DataSourceFacade service.

**Files to Create:**

- `packages/agent/src/facades/data-source.facade.ts`

---

## Task 9.3: Update Import Services

**Title:** Update import services to use DataSource facade

**Description:**
Refactor import-related services to use the DataSource facade.

---

# Story 10: Service Facades

**Story Title:** Create Service Facades

**Story Description:**
Create thin facade services in packages/agent that wrap plugin registry calls for each capability.

---

## Task 10.1: GitFacade

**Title:** Create GitFacade service

**Description:**
Facade for git operations (createRepository, push, createPullRequest, etc.).

---

## Task 10.2: DeployFacade

**Title:** Create DeployFacade service

**Description:**
Facade for deployment operations (deploy, getStatus, getDomains, etc.).

---

## Task 10.3: ScreenshotFacade

**Title:** Create ScreenshotFacade service

**Description:**
Facade for screenshot operations (capture, captureBulk, etc.).

---

## Task 10.4: SearchFacade

**Title:** Create SearchFacade service

**Description:**
Facade for search operations (search, etc.).

---

## Task 10.5: AiFacade

**Title:** Create AiFacade service with model routing

**Description:**
Create a facade for AI operations that wraps the plugin registry AND provides intelligent model routing. The AiFacade is more complex than other facades because it must handle:

1. **Model Routing** - Map task complexity to model tiers
2. **Provider Failover** - Automatic fallback when providers fail
3. **Health Monitoring** - Track provider availability with caching
4. **Cost Aggregation** - Sum costs across multiple provider calls
5. **askJson Support** - Pass-through for structured output with routing

**Why AiFacade Needs Routing:**
The current AiService has sophisticated routing logic that maps `TaskComplexity` to model tiers. This logic must be preserved in the plugin architecture to ensure the pipeline uses appropriate models for each step.

**Implementation Details:**

```typescript
// src/facades/ai.facade.ts
import { ZodSchema } from 'zod';

@Injectable()
export class AiFacade {
	private healthCache: Map<string, { result: HealthCheckResult; expiresAt: number }> = new Map();
	private readonly HEALTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	/**
	 * CRITICAL: Structured output with routing.
	 * All pipeline AI operations use this method.
	 */
	async askJson<T>(
		prompt: string,
		schema: ZodSchema<T>,
		options: AskJsonRoutingOptions
	): Promise<AskJsonResponse<T>> {
		// 1. Route based on complexity to select provider and model
		const route = await this.route(options);

		// 2. Get the selected AI provider plugin
		const plugin = await this.getAiPlugin(route.provider, options.userId, options.directoryId);

		// 3. Delegate to plugin's askJson with selected model
		return plugin.askJson(prompt, schema, {
			model: route.model,
			temperature: options.temperature,
			maxRetries: options.maxRetries
		});
	}

	/**
	 * Basic chat (no routing needed - uses default model).
	 */
	async chat(messages: ChatMessage[], options: ChatRoutingOptions): Promise<ChatResponse> {
		const plugin = await this.getAiPlugin(options.provider, options.userId, options.directoryId);
		return plugin.chat(messages, options);
	}

	/**
	 * Streaming chat.
	 */
	async *chatStream(messages: ChatMessage[], options: ChatRoutingOptions): AsyncIterable<ChatChunk> {
		const plugin = await this.getAiPlugin(options.provider, options.userId, options.directoryId);
		yield* plugin.chatStream(messages, options);
	}

	/**
	 * Route request based on complexity to select provider and model.
	 */
	private async route(options: AskJsonRoutingOptions): Promise<RouteDecision> {
		const complexity = options.complexity ?? 'medium';

		// Map complexity to model tier
		const tier = this.complexityToTier(complexity);

		// Get available providers with health status
		const healthyProviders = await this.getHealthyProviders(options.userId, options.directoryId);

		if (healthyProviders.length === 0) {
			throw new Error('No healthy AI providers available');
		}

		// Find provider with model matching the tier
		for (const provider of healthyProviders) {
			const capabilities = provider.plugin.getCapabilities();
			const model = capabilities.availableModels.find((m) => m.tier === tier);

			if (model) {
				return {
					provider: provider.pluginId,
					model: model.id,
					tier
				};
			}
		}

		// Fallback: use default model from first healthy provider
		const fallback = healthyProviders[0];
		return {
			provider: fallback.pluginId,
			model: fallback.plugin.getDefaultModel(),
			tier: 'standard'
		};
	}

	/**
	 * Map task complexity to model tier.
	 */
	private complexityToTier(complexity: TaskComplexity): ModelTier {
		switch (complexity) {
			case 'simple':
				return 'economy'; // Fast, cheap models (GPT-3.5, Haiku)
			case 'medium':
				return 'standard'; // Balanced models (GPT-4o-mini, Sonnet)
			case 'complex':
				return 'premium'; // Powerful models (GPT-4, Opus)
		}
	}

	/**
	 * Get healthy AI providers with cached health checks.
	 */
	private async getHealthyProviders(userId?: string, directoryId?: string): Promise<ProviderHealth[]> {
		const aiPlugins = this.registry.getByCapability<IAiProviderPlugin>('ai-provider');
		const results: ProviderHealth[] = [];

		for (const { pluginId, plugin } of aiPlugins) {
			const health = await this.getHealthStatus(pluginId, plugin);
			if (health.success) {
				results.push({ pluginId, plugin, health });
			}
		}

		// Sort by response time (fastest first)
		return results.sort((a, b) => a.health.responseTimeMs - b.health.responseTimeMs);
	}

	/**
	 * Get cached health status or perform new check.
	 */
	private async getHealthStatus(pluginId: string, plugin: IAiProviderPlugin): Promise<HealthCheckResult> {
		const cached = this.healthCache.get(pluginId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.result;
		}

		const result = await plugin.healthCheck();
		this.healthCache.set(pluginId, {
			result,
			expiresAt: Date.now() + this.HEALTH_CACHE_TTL
		});

		return result;
	}

	/**
	 * Get AI plugin instance with resolved settings.
	 */
	private async getAiPlugin(
		providerId: string | undefined,
		userId?: string,
		directoryId?: string
	): Promise<IAiProviderPlugin> {
		// If no provider specified, use first available
		if (!providerId) {
			const plugins = this.registry.getByCapability<IAiProviderPlugin>('ai-provider');
			if (plugins.length === 0) {
				throw new Error('No AI provider plugins installed');
			}
			return plugins[0].plugin;
		}

		const plugin = this.registry.get<IAiProviderPlugin>(providerId);
		if (!plugin) {
			throw new Error(`AI provider not found: ${providerId}`);
		}

		return plugin;
	}
}

// Types for routing
interface AskJsonRoutingOptions extends AskJsonOptions {
	provider?: string;
	userId?: string;
	directoryId?: string;
}

interface ChatRoutingOptions extends ChatOptions {
	provider?: string;
	userId?: string;
	directoryId?: string;
}

interface RouteDecision {
	provider: string;
	model: string;
	tier: ModelTier;
}

interface ProviderHealth {
	pluginId: string;
	plugin: IAiProviderPlugin;
	health: HealthCheckResult;
}
```

**Files to Create:**

- `packages/agent/src/facades/ai.facade.ts`

---

## Task 10.6: GitOAuthFacade

**Title:** Create GitOAuthFacade service

**Description:**
Facade for git provider OAuth operations (getAuthUrl, handleCallback, etc.). Handles connecting user accounts to GitHub, GitLab, Bitbucket for repository management.

**Note:** This is NOT for app authentication (logging into Ever Works). App authentication remains hardcoded.

---

## Task 10.7: Update All Agent Consumers

**Title:** Update all services to use facades

**Description:**
Refactor all services in packages/agent to use facades instead of direct service dependencies.

---

# Story 10a: Migrate Hardcoded Infrastructure to Plugin System

**Story Title:** Migrate Hardcoded Infrastructure to Plugin System

**Story Description:**
Migrate hardcoded entity fields (User tokens, Directory provider selection, OAuthToken) to the plugin system entities (UserPlugin, DirectoryPlugin). This story depends on Story 2 (Plugin Runtime) and Story 10 (Service Facades).

See [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](./PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure) for detailed field mappings.

**Acceptance Criteria:**

- All User entity token fields migrated to UserPlugin.settings
- OAuthToken entity replaced by UserPlugin for git providers
- Directory provider selection stored in DirectoryPlugin capability defaults
- Entity methods refactored to use facades
- Database migration script created and tested
- Backwards compatibility maintained during transition

---

## Task 10a.1: Migrate User.vercelToken

**Title:** Migrate User.vercelToken to UserPlugin

**Description:**
Migrate the `User.vercelToken` field to `UserPlugin.settings.apiToken` for the vercel plugin.

**Implementation Details:**

1. Update DeployFacade to read token from UserPlugin instead of User entity
2. Keep User.vercelToken as deprecated during migration
3. Create migration script to move existing tokens

---

## Task 10a.2-3: Migrate User.screenshotoneAccessKey/SecretKey

**Title:** Migrate ScreenshotOne credentials to UserPlugin

**Description:**
Migrate `User.screenshotoneAccessKey` and `User.screenshotoneSecretKey` to `UserPlugin.settings` for the screenshotone plugin.

**Implementation Details:**

1. Update ScreenshotFacade to read credentials from UserPlugin
2. Ensure credentials are encrypted in UserPlugin.settings (marked as `secret: true`)
3. Create migration script to move existing credentials

---

## Task 10a.4: Migrate OAuthToken to UserPlugin

**Title:** Migrate OAuthToken entity to UserPlugin for git providers

**Description:**
Migrate the entire OAuthToken entity to UserPlugin.settings for git provider plugins (github, gitlab, bitbucket).

**Field Mappings:**

| OAuthToken Field | UserPlugin.settings Field |
| ---------------- | ------------------------- |
| `provider`       | `UserPlugin.pluginId`     |
| `accessToken`    | `settings.accessToken`    |
| `refreshToken`   | `settings.refreshToken`   |
| `scope`          | `settings.scope`          |
| `expiresAt`      | `settings.expiresAt`      |
| `username`       | `settings.username`       |
| `email`          | `settings.email`          |
| `metadata`       | `settings.metadata`       |

**Implementation Details:**

1. Update GitFacade.getToken() to read from UserPlugin
2. Update GitOAuthFacade to write tokens to UserPlugin
3. Create migration script to move existing OAuthToken records
4. Mark OAuthToken entity as deprecated

---

## Task 10a.5: Remove User.oauthTokens Relationship

**Title:** Remove User.oauthTokens relationship after migration

**Description:**
After migration is complete and verified, remove the `User.oauthTokens[]` relationship.

**Prerequisites:**

- Task 10a.4 completed
- All services using GitFacade instead of direct OAuthToken access
- Migration verified in production

---

## Task 10a.6: Migrate Directory.repoProvider

**Title:** Migrate Directory.repoProvider to DirectoryPlugin capability defaults

**Description:**
Migrate `Directory.repoProvider` to `DirectoryPlugin.settings.defaults['git-provider']`.

**Implementation Details:**

```typescript
// DirectoryPlugin.settings structure
{
    defaults: {
        'git-provider': 'github' | 'gitlab' | 'bitbucket'
    }
}
```

1. Update GitFacade to read provider selection from DirectoryPlugin
2. Keep Directory.repoProvider as fallback during migration
3. Create migration script to move existing provider selections

---

## Task 10a.7: Migrate Directory.sourceRepository

**Title:** Migrate Directory.sourceRepository to DirectoryPlugin

**Description:**
Migrate `Directory.sourceRepository` to `DirectoryPlugin.settings` for data-source plugins.

---

## Task 10a.8: Migrate Directory.lastPullRequest

**Title:** Migrate Directory.lastPullRequest to DirectoryPlugin

**Description:**
Migrate `Directory.lastPullRequest` to `DirectoryPlugin.settings` for git provider plugins. This tracks PR state per provider.

---

## Task 10a.9: Migrate DirectorySchedule.alwaysCreatePullRequest

**Title:** Migrate alwaysCreatePullRequest to DirectoryPlugin

**Description:**
Migrate `DirectorySchedule.alwaysCreatePullRequest` to `DirectoryPlugin.settings` for git provider plugins.

---

## Task 10a.10: Refactor User.getGitToken

**Title:** Refactor User.getGitToken to use GitFacade

**Description:**
Replace all usages of `User.getGitToken(provider)` with `GitFacade.getToken(userId, providerId)`.

**Files to Update:**

- All services that call `user.getGitToken()`
- DataGeneratorService
- WebsiteGeneratorService
- MarkdownGeneratorService
- BranchSyncService

---

## Task 10a.11: Refactor User.asCommitter

**Title:** Refactor User.asCommitter to use GitFacade

**Description:**
Replace all usages of `User.asCommitter(provider)` with `GitFacade.getCommitter(userId, providerId)`.

---

## Task 10a.12: Refactor Directory.getRepoOwner

**Title:** Refactor Directory.getRepoOwner to use GitFacade

**Description:**
Replace all usages of `Directory.getRepoOwner()` with `GitFacade.getRepoOwner(directoryId, userId)`.

---

## Task 10a.13: Database Migration Script

**Title:** Create database migration script for plugin system

**Description:**
Create a migration script that:

1. Creates UserPlugin records from existing User fields and OAuthToken records
2. Creates DirectoryPlugin records from existing Directory fields
3. Maintains backwards compatibility by keeping old fields during transition
4. Provides rollback capability

**Migration Steps:**

```sql
-- 1. Migrate OAuthToken to UserPlugin (git providers)
INSERT INTO user_plugins (id, userId, pluginId, settings, enabled, installedAt)
SELECT
    uuid_generate_v4(),
    o.userId,
    o.provider,
    json_build_object(
        'accessToken', o.accessToken,
        'refreshToken', o.refreshToken,
        'scope', o.scope,
        'expiresAt', o.expiresAt,
        'username', o.username,
        'email', o.email,
        'metadata', o.metadata
    ),
    true,
    NOW()
FROM oauth_tokens o
WHERE o.provider IN ('github', 'gitlab', 'bitbucket');

-- 2. Migrate User.vercelToken to UserPlugin
INSERT INTO user_plugins (id, userId, pluginId, settings, enabled, installedAt)
SELECT
    uuid_generate_v4(),
    u.id,
    'vercel',
    json_build_object('apiToken', u.vercelToken),
    true,
    NOW()
FROM users u
WHERE u.vercelToken IS NOT NULL;

-- 3. Migrate User.screenshotone keys to UserPlugin
INSERT INTO user_plugins (id, userId, pluginId, settings, enabled, installedAt)
SELECT
    uuid_generate_v4(),
    u.id,
    'screenshotone',
    json_build_object(
        'accessKey', u.screenshotoneAccessKey,
        'secretKey', u.screenshotoneSecretKey
    ),
    true,
    NOW()
FROM users u
WHERE u.screenshotoneAccessKey IS NOT NULL;

-- 4. Migrate Directory.repoProvider to DirectoryPlugin
INSERT INTO directory_plugins (id, directoryId, pluginId, settings, enabled, enabledAt)
SELECT
    uuid_generate_v4(),
    d.id,
    d.repoProvider,
    json_build_object('defaults', json_build_object('git-provider', d.repoProvider)),
    true,
    NOW()
FROM directories d
WHERE d.repoProvider IS NOT NULL;
```

---

# Story 11: API App Refactoring

**Story Title:** Refactor API App for Plugin System

**Story Description:**
Refactor apps/api to use the plugin system instead of hardcoded providers.

---

## Task 11.1: Generic Deploy Controller

**Title:** Replace /vercel/_ with /deploy/:provider/_

**Description:**
Create a generic deploy controller that routes to the appropriate deployment plugin.

---

## Task 11.2: Remove VercelDeploymentVerifier

**Title:** Use IDeploymentPlugin.getStatus() instead

**Description:**
Remove the Vercel-specific deployment verifier and use the plugin interface.

---

## Task 11.3: Generic Git OAuth Strategies

**Title:** Replace GitHub strategy with plugin-based Git OAuth

**Description:**
Create a generic OAuth strategy for git providers that uses IGitOAuthPlugin. This handles connecting user accounts to GitHub, GitLab, Bitbucket etc. for repository management.

**Note:** This is NOT for app authentication (logging into Ever Works). App authentication remains hardcoded.

---

## Task 11.4-11.5: Remove Hardcoded GitHub Services

**Title:** Remove github-token.service.ts and github-scopes.config.ts

**Description:**
Remove GitHub-specific services and use GitOAuthFacade instead. The GitHub plugin will handle all GitHub-specific OAuth logic.

---

## Task 11.6: Generic Screenshot Controller

**Title:** Update screenshot controller to use facade

**Description:**
Refactor screenshot controller to use ScreenshotFacade.

---

## Task 11.7-11.10: Plugin Management Endpoints

**Title:** Create plugin management API endpoints

**Description:**
Create endpoints for plugin discovery, installation, settings, and directory plugin management.

---

## Task 11.11: Generator Form API

**Title:** Create dynamic generator form API

**Description:**
Create endpoint that returns form fields from enabled IFormFieldPlugin plugins.

---

## Task 11.12: Update DTOs

**Title:** Remove provider-specific DTO fields

**Description:**
Update DTOs to be generic instead of provider-specific.

---

# Story 12: Frontend - API Layer Refactoring

**Story Title:** Refactor Frontend API Layer

**Story Description:**
Refactor apps/web/src/lib/api/ for plugin-based providers.

---

## Task 12.1-12.6: Update API Functions

**Title:** Update all API functions to be provider-agnostic

**Description:**
Update deploy.ts, auth.ts, screenshot.ts, create plugins.ts, update enums.ts.

---

# Story 13: Frontend - Settings Components

**Story Title:** Refactor Settings UI for Plugins

**Story Description:**
Refactor settings UI to be plugin-driven with dynamic forms.

---

## Task 13.1-13.5: Create Plugin Settings UI

**Title:** Create dynamic plugin settings components

**Description:**
Create PluginsSettings, dynamic OAuthConnections, Plugin Settings Page, Plugin Install Dialog.

---

# Story 14: Frontend - Directory Components

**Story Title:** Refactor Directory UI for Plugins

**Story Description:**
Refactor directory UI to support multiple providers.

---

## Task 14.1-14.6: Update Directory Components

**Title:** Make directory components provider-agnostic

**Description:**
Generic DeployForm, RepositorySelector, Directory Apps Tab, Plugin Enable/Disable.

---

# Story 15: Frontend - Git Provider Connection Components

**Story Title:** Refactor Git Provider Connection UI for Plugins

**Story Description:**
Refactor the UI components that allow users to connect their git provider accounts (GitHub, GitLab, Bitbucket). This is for repository management, NOT app authentication (login).

**Important:** App authentication (login with email, Google, etc.) remains hardcoded. This story only covers the "Connect GitHub Account" type flows for repository access.

---

## Task 15.1-15.5: Update Git Connection Components

**Title:** Make git provider connection components dynamic

**Description:**

- Generic GitConnectionAlert (support GitHub, GitLab, Bitbucket)
- Generic GitStatusSidebar (show connected git provider status)
- Dynamic provider icons from plugins
- Remove GitHub-specific components, use generic versions

---

# Story 16: Frontend - Actions Refactoring

**Story Title:** Refactor Server Actions for Plugins

**Story Description:**
Refactor server actions to use plugin APIs.

---

## Task 16.1-16.4: Update Server Actions

**Title:** Make server actions provider-agnostic

**Description:**
Generic deploy actions, oauth actions, settings actions, plugin management actions.

---

# Story 17: Generator Form Provider Selection

**Story Title:** Add Sub-Provider Selection to Generator Form

**Story Description:**
When users have multiple plugins of the same type (e.g., multiple search providers, screenshot plugins), they need to select which one to use for each generation. Plugins can have multiple **sub-providers** with different capabilities (e.g., Exa plugin provides "Exa Websets" for full pipeline and "Exa Search" for search step). This story adds sub-provider selection dropdowns, dynamic plugin form fields, and ConfigDto field handling to the generator form.

**Acceptance Criteria:**

- Users can select sub-providers per category (Search, Screenshot, AI, Full Pipeline)
- Sub-providers appear with distinct names (e.g., "Exa Websets" in Full Pipeline, "Exa Search" in Search)
- Users can switch between Standard Pipeline and Full Pipeline mode
- Plugin-specific form fields are rendered dynamically per sub-provider
- ConfigDto fields handled by the selected sub-provider are grayed out with tooltips
- Sub-provider selection is passed to the pipeline and resolved to plugin + capability
- Provider icons are displayed in dropdowns

---

## Task 17.1: Generator Form API Endpoint

**Title:** Create `/directories/:id/generator-form` API endpoint

**Description:**
Create an API endpoint that returns the generator form schema including available **sub-providers** (not plugins), directory defaults, and dynamic plugin form fields. Sub-providers are individual capabilities registered by plugins (e.g., "exa:websets", "exa:search" from the Exa plugin).

**Implementation Details:**

```typescript
// apps/api/src/directories/generator-form.controller.ts
@Get(':id/generator-form')
async getGeneratorForm(@Param('id') directoryId: string, @CurrentUser() user: User) {
    const directory = await this.directoryService.findOne(directoryId);

    // Get enabled plugins and expand to sub-providers
    const enabledPlugins = await this.pluginService.getEnabledForDirectory(directoryId);
    const subProviders = this.expandToSubProviders(enabledPlugins);

    // Get directory defaults (sub-provider IDs)
    const defaults = await this.directoryPluginService.getDefaults(directoryId);

    // Get form fields keyed by sub-provider ID
    const pluginFields: Record<string, FormFieldDefinition[]> = {};
    for (const plugin of enabledPlugins) {
        if (this.pluginService.hasCapability(plugin.id, 'sub-provider')) {
            for (const subProvider of (plugin as ISubProviderPlugin).subProviders) {
                pluginFields[subProvider.id] = plugin.getFormFieldsForSubProvider(subProvider.id);
            }
        } else if (this.pluginService.hasCapability(plugin.id, 'form-fields')) {
            pluginFields[plugin.id] = (plugin as IFormFieldPlugin).getFormFields();
        }
    }

    return {
        providers: {
            search: subProviders.filter(sp => sp.capability === 'search'),       // Includes "exa:search"
            screenshot: subProviders.filter(sp => sp.capability === 'screenshot'),
            ai: subProviders.filter(sp => sp.capability === 'ai'),
            fullPipeline: subProviders.filter(sp => sp.capability === 'full-pipeline'), // Includes "exa:websets"
        },
        defaults,
        pluginFields,
    };
}

// Expand plugins to sub-providers (SubProviderOption[])
private expandToSubProviders(plugins: IPlugin[]): SubProviderOption[] {
    const result: SubProviderOption[] = [];
    for (const plugin of plugins) {
        if (this.pluginService.hasCapability(plugin.id, 'sub-provider')) {
            for (const sp of (plugin as ISubProviderPlugin).subProviders) {
                result.push({
                    id: sp.id,                          // "exa:websets"
                    pluginId: plugin.id,                // "exa"
                    name: sp.name,                      // "Exa Websets"
                    icon: sp.icon || plugin.icon,
                    description: sp.description,
                    capability: sp.capability,
                    handledConfigFields: sp.handledConfigFields || [],
                    isInstalled: true,
                });
            }
        } else {
            // Plugin without sub-providers becomes its own sub-provider
            result.push({
                id: plugin.id,
                pluginId: plugin.id,
                name: plugin.name,
                icon: plugin.icon,
                capability: plugin.category,
                handledConfigFields: [],
                isInstalled: true,
            });
        }
    }
    return result;
}
```

**Files to Create/Modify:**

- `apps/api/src/directories/generator-form.controller.ts` (new)
- `apps/api/src/directories/dto/generator-form-schema.dto.ts` (new)
- `apps/api/src/directories/dto/sub-provider-option.dto.ts` (new)

---

## Task 17.2: GenerationOptions DTO Update

**Title:** Add `providers` (sub-provider IDs) and `pluginOptions` fields to generation DTO

**Description:**
Update `CreateItemsGeneratorDto` to include sub-provider selection and plugin-specific options. Providers are stored as **sub-provider IDs** (e.g., "exa:search", "exa:websets", "tavily").

**Implementation Details:**

```typescript
// packages/agent/src/items-generator/dto/create-items-generator.dto.ts
export class CreateItemsGeneratorDto {
	// ... existing fields ...

	@IsOptional()
	@ValidateNested()
	providers?: SubProviderSelectionDto;

	@IsOptional()
	@IsObject()
	pluginOptions?: Record<string, unknown>; // Keyed by sub-provider ID
}

// Sub-provider IDs (e.g., "exa:search", "tavily", "screenshotone")
export class SubProviderSelectionDto {
	@IsOptional()
	@IsString()
	search?: string | null; // "exa:search", "tavily"

	@IsOptional()
	@IsString()
	screenshot?: string | null; // "screenshotone"

	@IsOptional()
	@IsString()
	ai?: string | null; // "openai", "anthropic"

	@IsOptional()
	@IsString()
	pipeline?: string | null; // "exa:websets" - If set, uses full pipeline
}
```

**Files to Modify:**

- `packages/agent/src/items-generator/dto/create-items-generator.dto.ts`

---

## Task 17.3: Pipeline Provider Selection

**Title:** Update Pipeline Factory to resolve sub-providers and use selected plugins

**Description:**
Modify the pipeline factory to resolve sub-provider IDs to their parent plugins and capabilities, then use the correct plugin method for execution.

**Implementation Details:**

```typescript
// packages/agent/src/pipeline/pipeline-factory.service.ts
class PipelineFactory {
	create(directory: Directory, user: User, options: GenerationOptions): Pipeline {
		const providers = options.providers || {};

		// Check for full pipeline sub-provider
		if (providers.pipeline) {
			// Resolve sub-provider ID to plugin + capability
			const resolved = this.resolveSubProvider(providers.pipeline);
			if (resolved && resolved.capability === 'full-pipeline') {
				const plugin = this.registry.getPlugin<IFullPipelinePlugin>(resolved.pluginId);
				const subProviderOptions = options.pluginOptions?.[providers.pipeline] || {};
				return new FullPipelineExecutor(plugin, providers.pipeline, subProviderOptions);
			}
		}

		// Build step-based pipeline with selected sub-providers
		const steps = this.collectSteps(directory, providers);
		return new StepPipelineExecutor(steps, this.registry, providers, options.pluginOptions);
	}

	// Resolve sub-provider ID (e.g., "exa:search") to plugin and capability
	private resolveSubProvider(subProviderId: string): { pluginId: string; capability: string } | null {
		// Check if it's a compound ID (plugin:subprovider)
		if (subProviderId.includes(':')) {
			const [pluginId, subId] = subProviderId.split(':');
			const plugin = this.registry.getPlugin(pluginId);
			if (plugin && this.hasSubProvider(plugin, subProviderId)) {
				const subProvider = (plugin as ISubProviderPlugin).subProviders.find((sp) => sp.id === subProviderId);
				return { pluginId, capability: subProvider!.capability };
			}
		}

		// Simple plugin ID (e.g., "tavily")
		const plugin = this.registry.getPlugin(subProviderId);
		if (plugin) {
			return { pluginId: subProviderId, capability: plugin.category };
		}

		return null;
	}
}
```

**Files to Modify:**

- `packages/agent/src/pipeline/pipeline-factory.service.ts`
- `packages/agent/src/pipeline/sub-provider-resolver.service.ts` (new)

---

## Task 17.4: SubProviderSelector Component

**Title:** Create SubProviderSelector dropdown component

**Description:**
Create a reusable dropdown component for selecting **sub-providers** with plugin icons. Sub-providers have distinct names (e.g., "Exa Websets", "Exa Search") even when from the same plugin.

**Implementation Details:**

```tsx
// apps/web/src/components/directories/detail/generator/SubProviderSelector.tsx
interface SubProviderSelectorProps {
	category: 'search' | 'screenshot' | 'ai' | 'fullPipeline';
	subProviders: SubProviderOption[];
	value: string | null;
	onChange: (subProviderId: string | null) => void;
	defaultValue: string;
	label: string;
}

export function SubProviderSelector({
	category,
	subProviders,
	value,
	onChange,
	defaultValue,
	label
}: SubProviderSelectorProps) {
	const selected = subProviders.find((sp) => sp.id === (value || defaultValue));

	return (
		<div className="space-y-2">
			<Label>{label}</Label>
			<Select value={value || defaultValue} onValueChange={onChange}>
				<SelectTrigger>
					<SelectValue>
						{selected && (
							<>
								<PluginIcon icon={selected.icon} className="mr-2 h-4 w-4" />
								{selected.name} {/* Shows "Exa Websets" not "Exa" */}
								{selected.isDefault && (
									<Badge variant="secondary" className="ml-2">
										Default
									</Badge>
								)}
							</>
						)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{subProviders.map((sp) => (
						<SelectItem key={sp.id} value={sp.id}>
							<div className="flex items-center">
								<PluginIcon icon={sp.icon} className="mr-2 h-4 w-4" />
								<div>
									<span>{sp.name}</span>
									{sp.description && (
										<span className="text-xs text-muted-foreground ml-2">{sp.description}</span>
									)}
								</div>
								{sp.isDefault && (
									<Badge variant="outline" className="ml-2">
										Default
									</Badge>
								)}
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
```

**Files to Create:**

- `apps/web/src/components/directories/detail/generator/SubProviderSelector.tsx`
- `apps/web/src/components/plugins/PluginIcon.tsx`

---

## Task 17.5: Dynamic Plugin Fields

**Title:** Render form fields from `getFormFieldsForSubProvider()`

**Description:**
Create a component that renders dynamic form fields based on the selected sub-provider's form fields. Fields are keyed by sub-provider ID in the API response.

**Implementation Details:**

```tsx
// apps/web/src/components/plugins/DynamicSubProviderFields.tsx
interface DynamicSubProviderFieldsProps {
	subProviderId: string; // "exa:websets", "exa:search"
	subProviderName: string; // "Exa Websets", "Exa Search"
	fields: FormFieldDefinition[];
	values: Record<string, unknown>;
	onChange: (subProviderId: string, values: Record<string, unknown>) => void;
}

export function DynamicSubProviderFields({
	subProviderId,
	subProviderName,
	fields,
	values,
	onChange
}: DynamicSubProviderFieldsProps) {
	const handleFieldChange = (fieldId: string, value: unknown) => {
		onChange(subProviderId, { ...values, [fieldId]: value });
	};

	if (fields.length === 0) return null;

	return (
		<div className="space-y-4 border-l-2 border-primary/20 pl-4 mt-4">
			<h4 className="font-medium text-sm text-muted-foreground">{subProviderName} Options</h4>
			{fields.map((field) => (
				<FormField
					key={field.id}
					field={field}
					value={values[field.id]}
					onChange={(v) => handleFieldChange(field.id, v)}
				/>
			))}
		</div>
	);
}

function FormField({ field, value, onChange }) {
	switch (field.type) {
		case 'text':
			return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
		case 'number':
			return <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />;
		case 'checkbox':
			return <Checkbox checked={!!value} onCheckedChange={onChange} />;
		case 'select':
			return (
				<Select value={value} onValueChange={onChange}>
					{field.options?.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</Select>
			);
		// ... other types
	}
}
```

**Files to Create:**

- `apps/web/src/components/plugins/DynamicSubProviderFields.tsx`

---

## Task 17.6: Pipeline Mode Toggle

**Title:** Add Standard vs Full Pipeline toggle

**Description:**
Add a radio button group to switch between Standard Pipeline (step-by-step) and Full Pipeline Provider mode.

**Implementation Details:**

```tsx
// apps/web/src/components/directories/detail/generator/PipelineModeSelector.tsx
interface PipelineModeSelectorProps {
	fullPipelineProviders: ProviderOption[];
	selectedMode: 'standard' | 'full';
	selectedFullProvider: string | null;
	onModeChange: (mode: 'standard' | 'full') => void;
	onProviderChange: (providerId: string | null) => void;
}

export function PipelineModeSelector({
	fullPipelineProviders,
	selectedMode,
	selectedFullProvider,
	onModeChange,
	onProviderChange
}: PipelineModeSelectorProps) {
	return (
		<div className="space-y-4">
			<Label>Pipeline Mode</Label>
			<RadioGroup value={selectedMode} onValueChange={onModeChange}>
				<div className="flex items-center space-x-2">
					<RadioGroupItem value="standard" id="standard" />
					<Label htmlFor="standard">Standard Pipeline (step-by-step)</Label>
				</div>
				<div className="flex items-center space-x-2">
					<RadioGroupItem value="full" id="full" />
					<Label htmlFor="full">Full Pipeline Provider</Label>
					{selectedMode === 'full' && (
						<Select value={selectedFullProvider || ''} onValueChange={onProviderChange}>
							{fullPipelineProviders.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									<PluginIcon icon={p.icon} className="mr-2" />
									{p.name}
								</SelectItem>
							))}
						</Select>
					)}
				</div>
			</RadioGroup>
		</div>
	);
}
```

**Files to Create:**

- `apps/web/src/components/directories/detail/generator/PipelineModeSelector.tsx`

---

## Task 17.7: Generator Form Integration

**Title:** Integrate provider selection into GeneratorForm

**Description:**
Update the existing GeneratorForm to include provider selection dropdowns and dynamic plugin fields.

**Implementation Details:**

1. Fetch generator form schema from API on mount
2. Add PipelineModeSelector component
3. Conditionally show/hide provider selectors based on mode
4. Render dynamic plugin fields for selected providers
5. Include providers and pluginOptions in form submission

```tsx
// apps/web/src/components/directories/detail/generator/GeneratorForm.tsx
export function GeneratorForm({ directoryId }: { directoryId: string }) {
	const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
	const [pipelineMode, setPipelineMode] = useState<'standard' | 'full'>('standard');
	const [selectedProviders, setSelectedProviders] = useState<ProvidersDto>({});
	const [pluginOptions, setPluginOptions] = useState<Record<string, unknown>>({});

	useEffect(() => {
		fetchGeneratorFormSchema(directoryId).then(setFormSchema);
	}, [directoryId]);

	const handleSubmit = (data: FormData) => {
		const generationOptions = {
			...data,
			providers: pipelineMode === 'full' ? { pipeline: selectedProviders.pipeline } : selectedProviders,
			pluginOptions
		};
		// Submit generation
	};

	return (
		<form onSubmit={handleSubmit}>
			{/* Existing form fields */}

			<PipelineModeSelector
				fullPipelineProviders={formSchema?.providers.fullPipeline || []}
				selectedMode={pipelineMode}
				selectedFullProvider={selectedProviders.pipeline}
				onModeChange={setPipelineMode}
				onProviderChange={(id) => setSelectedProviders({ ...selectedProviders, pipeline: id })}
			/>

			{pipelineMode === 'standard' && (
				<div className="space-y-4">
					<ProviderSelector
						category="search"
						label="Search Provider"
						providers={formSchema?.providers.search || []}
						value={selectedProviders.search}
						defaultValue={formSchema?.defaults.search || ''}
						onChange={(id) => setSelectedProviders({ ...selectedProviders, search: id })}
					/>
					<ProviderSelector
						category="screenshot"
						label="Screenshot Provider"
						providers={formSchema?.providers.screenshot || []}
						value={selectedProviders.screenshot}
						defaultValue={formSchema?.defaults.screenshot || ''}
						onChange={(id) => setSelectedProviders({ ...selectedProviders, screenshot: id })}
					/>
					<ProviderSelector
						category="ai"
						label="AI Provider"
						providers={formSchema?.providers.ai || []}
						value={selectedProviders.ai}
						defaultValue={formSchema?.defaults.ai || ''}
						onChange={(id) => setSelectedProviders({ ...selectedProviders, ai: id })}
					/>
				</div>
			)}

			{/* Dynamic plugin fields */}
			{Object.entries(formSchema?.pluginFields || {}).map(([pluginId, fields]) => {
				const isActive = selectedProviders[getCategoryForPlugin(pluginId)] === pluginId;
				if (!isActive) return null;
				return (
					<DynamicPluginFields
						key={pluginId}
						pluginId={pluginId}
						fields={fields}
						values={pluginOptions[pluginId] || {}}
						onChange={(id, values) => setPluginOptions({ ...pluginOptions, [id]: values })}
					/>
				);
			})}

			{/* Existing form fields continue... */}
		</form>
	);
}
```

**Files to Modify:**

- `apps/web/src/components/directories/detail/generator/GeneratorForm.tsx`
- `apps/web/src/lib/api/items-generator.ts` (add fetchGeneratorFormSchema)

---

## Task 17.8: ConfigDto Field Graying

**Title:** Gray out ConfigDto fields handled by selected sub-provider

**Description:**
When a sub-provider declares `handledConfigFields`, those fields in the standard ConfigDto form should be visually grayed out (disabled) to indicate the sub-provider handles them.

**Implementation Details:**

```tsx
// apps/web/src/components/directories/detail/generator/ConfigFields.tsx
interface ConfigFieldsProps {
	config: ConfigDto;
	onChange: (config: ConfigDto) => void;
	handledFields: string[]; // Fields handled by selected sub-provider
}

export function ConfigFields({ config, onChange, handledFields }: ConfigFieldsProps) {
	const isHandled = (fieldName: string) => {
		return handledFields.includes('*') || handledFields.includes(fieldName);
	};

	return (
		<div className="space-y-4">
			<div className={cn('space-y-2', isHandled('max_search_queries') && 'opacity-50')}>
				<Label>Max Search Queries</Label>
				<Input
					type="number"
					value={config.max_search_queries}
					onChange={(e) => onChange({ ...config, max_search_queries: Number(e.target.value) })}
					disabled={isHandled('max_search_queries')}
				/>
				{isHandled('max_search_queries') && <HandledFieldIndicator fieldName="max_search_queries" />}
			</div>

			<div className={cn('space-y-2', isHandled('max_results_per_query') && 'opacity-50')}>
				<Label>Max Results Per Query</Label>
				<Input
					type="number"
					value={config.max_results_per_query}
					onChange={(e) => onChange({ ...config, max_results_per_query: Number(e.target.value) })}
					disabled={isHandled('max_results_per_query')}
				/>
				{isHandled('max_results_per_query') && <HandledFieldIndicator fieldName="max_results_per_query" />}
			</div>

			{/* More config fields... */}
		</div>
	);
}

// Helper to get handled fields from selected sub-providers
function getHandledConfigFields(formSchema: GeneratorFormSchema, selectedProviders: SubProviderSelectionDto): string[] {
	const handled: string[] = [];

	for (const [category, subProviderId] of Object.entries(selectedProviders)) {
		if (!subProviderId) continue;
		const allProviders = [
			...formSchema.providers.search,
			...formSchema.providers.screenshot,
			...formSchema.providers.ai,
			...formSchema.providers.fullPipeline
		];
		const subProvider = allProviders.find((sp) => sp.id === subProviderId);
		if (subProvider?.handledConfigFields) {
			handled.push(...subProvider.handledConfigFields);
		}
	}

	return [...new Set(handled)];
}
```

**Files to Create/Modify:**

- `apps/web/src/components/directories/detail/generator/ConfigFields.tsx`
- `apps/web/src/lib/utils/config-field-handling.ts` (new)

---

## Task 17.9: Config Field Tooltips

**Title:** Show "Handled by {sub-provider name}" tooltips on grayed fields

**Description:**
When a ConfigDto field is handled by a sub-provider, show a tooltip explaining which sub-provider handles it.

**Implementation Details:**

```tsx
// apps/web/src/components/directories/detail/generator/HandledFieldIndicator.tsx
interface HandledFieldIndicatorProps {
	fieldName: string;
	subProviderName: string;
}

export function HandledFieldIndicator({ fieldName, subProviderName }: HandledFieldIndicatorProps) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						<InfoIcon className="h-3 w-3" />
						<span>Handled by {subProviderName}</span>
					</div>
				</TooltipTrigger>
				<TooltipContent>
					<p>
						This setting is managed by <strong>{subProviderName}</strong>. The value shown will be passed to
						the provider but may be overridden or ignored based on the provider's configuration.
					</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

// Usage in ConfigFields
{
	isHandled('max_search_queries') && (
		<HandledFieldIndicator
			fieldName="max_search_queries"
			subProviderName={getSubProviderName(selectedProviders.search, formSchema)}
		/>
	);
}
```

**Files to Create:**

- `apps/web/src/components/directories/detail/generator/HandledFieldIndicator.tsx`

---

## Task 17.10: Sub-provider Resolution Service

**Title:** Create backend service to resolve sub-provider IDs to plugins

**Description:**
Create a service that resolves sub-provider IDs (e.g., "exa:websets", "exa:search") to their parent plugin and the correct capability method.

**Implementation Details:**

```typescript
// packages/agent/src/plugins/sub-provider-resolver.service.ts
import { Injectable } from '@nestjs/common';
import { PluginRegistryService } from './plugin-registry.service';
import { ISubProviderPlugin, IPlugin, PluginSubProvider } from '@ever-works/plugin';

export interface ResolvedSubProvider {
	pluginId: string;
	plugin: IPlugin;
	subProviderId: string;
	subProvider: PluginSubProvider | null; // null for simple plugins
	capability: string;
}

@Injectable()
export class SubProviderResolverService {
	constructor(private readonly registry: PluginRegistryService) {}

	/**
	 * Resolve a sub-provider ID to its parent plugin and capability.
	 *
	 * @param subProviderId - e.g., "exa:websets", "exa:search", "tavily"
	 * @returns Resolved sub-provider info or null if not found
	 */
	resolve(subProviderId: string): ResolvedSubProvider | null {
		// Check if it's a compound ID (plugin:subprovider)
		if (subProviderId.includes(':')) {
			const [pluginId] = subProviderId.split(':');
			const plugin = this.registry.getPlugin(pluginId);

			if (!plugin) return null;

			// Check if plugin has sub-providers
			if (this.hasSubProviders(plugin)) {
				const subProvider = (plugin as ISubProviderPlugin).subProviders.find((sp) => sp.id === subProviderId);

				if (subProvider) {
					return {
						pluginId,
						plugin,
						subProviderId,
						subProvider,
						capability: subProvider.capability
					};
				}
			}

			return null;
		}

		// Simple plugin ID (e.g., "tavily", "screenshotone")
		const plugin = this.registry.getPlugin(subProviderId);
		if (!plugin) return null;

		return {
			pluginId: subProviderId,
			plugin,
			subProviderId,
			subProvider: null,
			capability: plugin.category
		};
	}

	/**
	 * Get the correct plugin method based on resolved sub-provider capability.
	 */
	getPluginMethod<T>(resolved: ResolvedSubProvider): T | null {
		const { plugin, capability } = resolved;

		switch (capability) {
			case 'full-pipeline':
				return (plugin as any).executePipeline?.bind(plugin) ?? null;
			case 'search':
				return (plugin as any).search?.bind(plugin) ?? null;
			case 'screenshot':
				return (plugin as any).capture?.bind(plugin) ?? null;
			case 'ai':
				return (plugin as any).chat?.bind(plugin) ?? null;
			default:
				return null;
		}
	}

	private hasSubProviders(plugin: IPlugin): plugin is ISubProviderPlugin {
		return 'subProviders' in plugin && Array.isArray((plugin as any).subProviders);
	}
}
```

**Files to Create:**

- `packages/agent/src/plugins/sub-provider-resolver.service.ts`

**Files to Modify:**

- `packages/agent/src/plugins/plugins.module.ts` (add provider)

---

# Story 18: Testing Infrastructure

**Story Title:** Create Comprehensive Testing Infrastructure for Plugin System

**Story Description:**
All plugin code must be testable with comprehensive test coverage. Create testing utilities, mock factories, and establish testing patterns for the plugin system.

**Acceptance Criteria:**

- `@ever-works/plugin-test-utils` package created with mock factories
- `createMockPluginContext()` factory for mocking plugin context
- `createMockPluginEnvironment()` factory for mocking env vars
- `createPluginContractTests()` base test suite for plugin validation
- All built-in plugins have 80%+ test coverage
- CI pipeline includes plugin test coverage validation
- Documentation includes testing patterns and examples

---

## Task 18.1: Plugin Test Utilities Package

**Title:** Create `@ever-works/plugin-test-utils` package

**Description:**
Create a new package providing testing utilities for plugin development.

**Implementation Details:**

```typescript
// packages/plugin-test-utils/src/index.ts
export { createMockPluginContext, MockPluginContext } from './mock-context';
export { createMockPluginEnvironment, MockPluginEnvironment } from './mock-environment';
export { createPluginContractTests } from './contract-tests';
export { createMockDataSource } from './mock-datasource';
export { createMockLogger } from './mock-logger';
export { createMockServices } from './mock-services';
```

**Files to Create:**

- `packages/plugin-test-utils/package.json`
- `packages/plugin-test-utils/tsconfig.json`
- `packages/plugin-test-utils/src/index.ts`

---

## Task 18.2: MockPluginContext Factory

**Title:** Create factory for mocking PluginContext

**Description:**
Create a factory function that creates a fully mocked PluginContext for unit testing.

**Implementation Details:**

```typescript
// packages/plugin-test-utils/src/mock-context.ts
import { PluginContext, PluginEnvironment } from '@ever-works/plugin';
import { createMockPluginEnvironment } from './mock-environment';

export interface MockPluginContextOptions {
	settings?: Record<string, unknown>;
	userSettings?: Record<string, unknown>;
	directorySettings?: Record<string, unknown>;
	env?: PluginEnvironment | Record<string, string>;
}

export function createMockPluginContext(options: MockPluginContextOptions = {}): PluginContext {
	const env =
		options.env instanceof Object && 'get' in options.env
			? options.env
			: createMockPluginEnvironment((options.env as Record<string, string>) ?? {});

	return {
		dataSource: createMockDataSource(),
		getRepository: jest.fn(),
		services: createMockServices(),
		eventEmitter: { on: jest.fn(), emit: jest.fn() } as any,
		onEvent: jest.fn(),
		emitEvent: jest.fn(),
		getSettings: jest.fn().mockResolvedValue(options.settings ?? {}),
		getUserSettings: jest.fn().mockResolvedValue(options.userSettings ?? {}),
		getDirectorySettings: jest.fn().mockResolvedValue(options.directorySettings ?? {}),
		env,
		registerController: jest.fn(),
		registerCustomCapability: jest.fn(),
		getCustomCapability: jest.fn(),
		hasCustomCapability: jest.fn().mockReturnValue(false),
		listCustomCapabilities: jest.fn().mockReturnValue([]),
		logger: createMockLogger(),
		cache: createMockCache()
	};
}
```

**Files to Create:**

- `packages/plugin-test-utils/src/mock-context.ts`

---

## Task 18.3: MockPluginEnvironment Factory

**Title:** Create factory for mocking PluginEnvironment

**Description:**
Create a mock implementation of PluginEnvironment for testing env var handling.

**Implementation Details:**

```typescript
// packages/plugin-test-utils/src/mock-environment.ts
import { PluginEnvironment } from '@ever-works/plugin';

export function createMockPluginEnvironment(envVars: Record<string, string> = {}): PluginEnvironment {
	return {
		get: (name: string) => envVars[name],
		getRequired: (name: string) => {
			if (!(name in envVars)) {
				throw new Error(`Missing required env var: ${name}`);
			}
			return envVars[name];
		},
		has: (name: string) => name in envVars,
		getAll: () => ({ ...envVars })
	};
}
```

**Files to Create:**

- `packages/plugin-test-utils/src/mock-environment.ts`

---

## Task 18.4: Plugin Contract Tests

**Title:** Create base test suite for plugin contract validation

**Description:**
Create a reusable test suite that validates any plugin implements IPlugin correctly.

**Implementation Details:**

```typescript
// packages/plugin-test-utils/src/contract-tests.ts
import { IPlugin, PluginContext } from '@ever-works/plugin';
import { createMockPluginContext } from './mock-context';
import { createMockPluginEnvironment } from './mock-environment';

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
			expect(typeof plugin.id).toBe('string');
			expect(plugin.name).toBeDefined();
			expect(typeof plugin.name).toBe('string');
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

**Files to Create:**

- `packages/plugin-test-utils/src/contract-tests.ts`

---

## Task 18.5: Plugin Loader Tests

**Title:** Create unit tests for plugin discovery and loading

**Description:**
Write comprehensive unit tests for PluginLoaderService.

**Files to Create:**

- `packages/agent/src/plugins/__tests__/plugin-loader.service.spec.ts`

---

## Task 18.6: Plugin Registry Tests

**Title:** Create unit tests for plugin registry

**Description:**
Write unit tests for PluginRegistryService - registration, lookup, capability querying.

**Files to Create:**

- `packages/agent/src/plugins/__tests__/plugin-registry.service.spec.ts`

---

## Task 18.7: Plugin Lifecycle Tests

**Title:** Create tests for plugin lifecycle management

**Description:**
Test onLoad, onEnable, onDisable, onUnload lifecycle transitions.

**Files to Create:**

- `packages/agent/src/plugins/__tests__/plugin-lifecycle.service.spec.ts`

---

## Task 18.8: Pipeline Builder Tests

**Title:** Create unit tests for PipelineBuilderService

**Description:**
Test step injection, replacement, disable, and topological sort functionality.

**Files to Create:**

- `packages/agent/src/pipeline/__tests__/pipeline-builder.service.spec.ts`

---

## Task 18.9: Pipeline Executor Tests

**Title:** Create unit tests for pipeline execution

**Description:**
Test step execution, parallel groups, error handling for optional steps.

**Files to Create:**

- `packages/agent/src/pipeline/__tests__/step-executor.service.spec.ts`

---

## Task 18.10: GitHub Plugin Tests

**Title:** Create unit tests for GitHub plugin

**Description:**
Test GitHub plugin with mocked Octokit.

**Files to Create:**

- `packages/plugins/github/src/__tests__/github.plugin.spec.ts`

---

## Task 18.11: Vercel Plugin Tests

**Title:** Create unit tests for Vercel plugin

**Description:**
Test Vercel plugin with mocked SDK.

**Files to Create:**

- `packages/plugins/vercel/src/__tests__/vercel.plugin.spec.ts`

---

## Task 18.12: ScreenshotOne Plugin Tests

**Title:** Create unit tests for ScreenshotOne plugin

**Description:**
Test ScreenshotOne plugin with mocked SDK.

**Files to Create:**

- `packages/plugins/screenshotone/src/__tests__/screenshotone.plugin.spec.ts`

---

## Task 18.13: Facade Tests

**Title:** Create unit tests for service facades

**Description:**
Test all facade services with mocked plugin registry.

**Files to Create:**

- `packages/agent/src/facades/__tests__/git.facade.spec.ts`
- `packages/agent/src/facades/__tests__/deploy.facade.spec.ts`
- `packages/agent/src/facades/__tests__/screenshot.facade.spec.ts`
- `packages/agent/src/facades/__tests__/ai.facade.spec.ts`

---

## Task 18.14: Integration Tests

**Title:** Create E2E tests for plugin system

**Description:**
Create integration tests for plugin loading → capability usage → results flow.

**Files to Create:**

- `packages/agent/src/plugins/__tests__/plugins.integration.spec.ts`

---

## Task 18.15: CI Pipeline Update

**Title:** Update CI workflow for plugin tests

**Description:**
Add plugin tests to CI workflow, ensure coverage requirements are met.

**Implementation Details:**

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

            # Run plugin tests
            - run: pnpm --filter "@ever-works/plugin" test:cov

            # Run plugin-test-utils tests
            - run: pnpm --filter "@ever-works/plugin-test-utils" test

            # Run all plugin tests
            - run: pnpm --filter "@ever-works/plugin-*" test:cov

            # Run agent plugin runtime tests
            - run: pnpm --filter "@packages/agent" test -- --testPathPattern="plugins|pipeline"

            # Verify coverage thresholds
            - name: Check coverage
              run: |
                  COVERAGE_THRESHOLD=80
                  for pkg in packages/plugin packages/plugin-test-utils packages/plugins/*; do
                    if [ -f "$pkg/coverage/coverage-summary.json" ]; then
                      COVERAGE=$(cat "$pkg/coverage/coverage-summary.json" | jq '.total.lines.pct')
                      if (( $(echo "$COVERAGE < $COVERAGE_THRESHOLD" | bc -l) )); then
                        echo "❌ Coverage for $pkg is $COVERAGE%, required $COVERAGE_THRESHOLD%"
                        exit 1
                      else
                        echo "✅ Coverage for $pkg is $COVERAGE%"
                      fi
                    fi
                  done
```

**Files to Create/Modify:**

- `.github/workflows/plugin-tests.yml` (new)

---

# Implementation Phases

## Phase 1: Foundation (Stories 1-2)

- Week 1-2
- Plugin contracts package
- Plugin runtime system

## Phase 2: Pipeline (Story 3)

- Week 3
- Pipeline refactoring
- Step/full pipeline support

## Phase 3: Module Decoupling (Stories 5-8)

- Week 4-5
- Git, Deploy, Screenshot, AI modules

## Phase 4: Built-in Plugins (Story 4)

- Week 6-7
- Create all plugin packages
- Migrate existing code

## Phase 5: Data Sources (Story 9)

- Week 8
- Data source plugins

## Phase 6: Service Facades (Story 10)

- Week 9
- Create all facades
- Update consumers

## Phase 7: API Refactoring (Story 11)

- Week 10-11
- Generic endpoints
- Plugin management API

## Phase 8: Frontend (Stories 12-16)

- Week 12-14
- API layer
- Settings
- Directory components
- OAuth
- Actions

## Phase 9: Testing & CI (Story 18)

- Week 15
- Testing utilities package
- Plugin contract tests
- Unit tests for all plugins
- Integration tests
- CI pipeline updates
- Coverage validation (80% minimum)
