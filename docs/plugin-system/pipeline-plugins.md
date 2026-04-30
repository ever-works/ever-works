---
id: pipeline-plugins
title: Pipeline Plugins
sidebar_label: Pipelines
sidebar_position: 13
---

# Pipeline Plugins

Pipeline plugins define the content generation workflow -- the sequence of steps that transform a user's prompt into a fully populated directory with items, categories, tags, and collections. The platform ships with two built-in pipelines and supports custom pipeline creation.

## IPipelinePlugin Interface

```typescript
interface IPipelinePlugin<TStepId extends string = string> extends IPlugin {
	/** Define all pipeline steps */
	getStepDefinitions(): readonly PipelineStepDefinition<TStepId>[];

	/** Execute the full pipeline */
	execute(
		directory: DirectoryReference,
		request: GenerationRequest,
		existing: ExistingItems,
		options?: PipelineExecutionOptions,
		onProgress?: PipelineProgressCallback
	): Promise<PipelineResult>;

	// Optional: Engine-orchestrated step execution
	isValidStepId?(stepId: string): stepId is TStepId;
	registerStepExecutor?(stepId: TStepId, executor: IBuiltInStepExecutor): void;
	executeStep?(stepId, context, execContext, options?, onProgress?): Promise<IPipelineContext>;

	// Optional: Context lifecycle hooks
	createContext?(directory, request, existing): IPipelineContext;
	contextToSnapshot?(context): unknown;
	contextFromSnapshot?(snapshot): IPipelineContext;
	extractResult?(context, meta): PipelineResult;
	isCheckpointViable?(snapshot, completedSteps): boolean;
	canSkipStep?(stepId, context): boolean;

	// Optional: Lifecycle
	cancel?(): Promise<void>;
	getState?(): PipelineState | null;
}
```

## Pipeline Flavors

Pipelines come in two flavors:

### Engine-Orchestratable

Implements `executeStep()` and `registerStepExecutor()`. The platform engine can:

- Run individual steps
- Inject new steps via pipeline-modifier plugins
- Replace or disable existing steps
- Checkpoint and resume execution

**Example:** Standard Pipeline

### Self-Managed

Only implements the required `execute()` method. The plugin owns execution entirely -- the engine cannot modify the step sequence.

**Example:** Agent Pipeline, Claude Code

You can check if a pipeline is engine-orchestratable:

```typescript
import { isStepOrchestratablePipeline } from '@ever-works/plugin';

if (isStepOrchestratablePipeline(pipeline)) {
	// Engine can run steps individually
}
```

## Step Definitions

Each step in a pipeline is described by a `PipelineStepDefinition`:

```typescript
interface PipelineStepDefinition<TStepId extends string = string> {
	id: TStepId; // Unique step identifier
	name: string; // Display name
	description?: string; // What this step does
	position: StepPosition<TStepId>; // Where in the pipeline
	dependencies?: StepDependency[]; // Steps that must run first
	optional?: boolean; // Can be skipped
	parallelizable?: boolean; // Can run alongside other steps
	provides?: string[]; // Data keys this step produces
	requires?: string[]; // Data keys this step needs
	estimatedDuration?: number; // Seconds (for progress estimation)
}
```

### Step Positioning

```typescript
type StepPosition<TStepId extends string = string> =
	| { type: 'before'; stepId: TStepId } // Insert before a step
	| { type: 'after'; stepId: TStepId } // Insert after a step
	| { type: 'replace'; stepId: TStepId } // Replace a step entirely
	| { type: 'disable'; stepId: TStepId } // Disable a step
	| { type: 'first' } // Run as the first step
	| { type: 'last' }; // Run as the last step
```

## Standard Pipeline (15 Steps)

The standard pipeline is the default generation workflow. It is engine-orchestratable with 15 steps organized into phases:

### Phase 1: Initialization

| Step              | ID                  | Provides                       | Description                                               |
| ----------------- | ------------------- | ------------------------------ | --------------------------------------------------------- |
| Prompt Comparison | `prompt-comparison` | `shouldStop`                   | Compares with previous generation to avoid redundant runs |
| Prompt Processing | `prompt-processing` | `subject`, `featuredItemHints` | Extracts subject and item hints from the user prompt      |
| Domain Detection  | `domain-detection`  | `domainAnalysis`               | Analyzes the prompt domain for specialized handling       |

### Phase 2: Content Generation

| Step                    | ID                        | Provides           | Description                                    |
| ----------------------- | ------------------------- | ------------------ | ---------------------------------------------- |
| AI Item Generation      | `ai-item-generation`      | `aiGeneratedItems` | Uses AI to generate initial item suggestions   |
| Search Query Generation | `search-query-generation` | `searchQueries`    | Creates optimized search queries               |
| Web Search              | `web-search`              | `searchResults`    | Executes searches via the active search plugin |
| Content Retrieval       | `content-retrieval`       | `extractedContent` | Extracts full content from search result URLs  |
| Content Filtering       | `content-filtering`       | `filteredContent`  | Filters and deduplicates extracted content     |

### Phase 3: Data Extraction

| Step             | ID                 | Provides          | Description                                 |
| ---------------- | ------------------ | ----------------- | ------------------------------------------- |
| Item Extraction  | `item-extraction`  | `extractedItems`  | Extracts structured items from content      |
| Data Aggregation | `data-aggregation` | `aggregatedItems` | Merges items from all sources, deduplicates |

### Phase 4: Enrichment & Output

| Step                | ID                    | Provides             | Description                                           |
| ------------------- | --------------------- | -------------------- | ----------------------------------------------------- |
| Category Processing | `category-processing` | `categories`, `tags` | Generates categories and tags from items              |
| Source Validation   | `source-validation`   | `validatedItems`     | Validates source URLs are reachable                   |
| Badge Processing    | `badge-processing`    | `badges`             | Assigns badges (featured, trending, etc.)             |
| Image Capture       | `image-capture`       | `screenshots`        | Captures screenshots via the active screenshot plugin |
| Markdown Generation | `markdown-generation` | `markdown`           | Generates markdown descriptions for items             |

### Data Flow

The pipeline uses a typed context object that accumulates data as steps execute. Each step declares what data it `provides` and `requires`, enabling the engine to:

- Validate step ordering
- Skip steps when their inputs are missing
- Resume from checkpoints

## Agent Pipeline (5 Steps)

The agent pipeline is a self-managed pipeline that uses an AI agent with tool-calling to autonomously research and generate directory items.

| Property       | Value                               |
| -------------- | ----------------------------------- |
| Package        | `@ever-works/agent-pipeline-plugin` |
| Capabilities   | `pipeline`, `form-schema-provider`  |
| Orchestratable | No (self-managed)                   |
| AI SDK         | Vercel AI SDK (`ai` package)        |

The agent pipeline gives the AI model access to tools (search, content extraction, screenshot capture) and lets it decide the research strategy autonomously. It uses the `generateText` function from the Vercel AI SDK with tool calling.

### Agent Pipeline Steps

| Step                | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| Initialize          | Set up workspace and resolve provider settings                        |
| Research            | AI agent researches items using tools (search, extract, data sources) |
| Collect             | Gather generated item files from the agent's workspace                |
| Capture Screenshots | Take screenshots for discovered items                                 |
| Finalize            | Build the final pipeline result with items, categories, and tags      |

### Custom Form Fields

Both pipeline plugins implement `IFormSchemaProvider` to define their own configuration form. The agent pipeline adds fields for:

- Maximum agent steps
- Context budget ratio
- Tool configuration

## Pipeline Execution Options

```typescript
interface PipelineExecutionOptions {
	timeout?: number; // Max execution time in ms
	skipSteps?: string[]; // Steps to skip
	onlySteps?: string[]; // Run only these steps
	stepSettings?: Record<string, Record<string, unknown>>; // Per-step settings
	signal?: AbortSignal; // Cancellation signal
	continueOnError?: boolean; // Continue on step failure
	maxConcurrent?: number; // Parallel step limit
	execContext?: StepExecutionContext; // Facade access for providers
}
```

## Pipeline Result

```typescript
interface PipelineResult {
	success: boolean;
	outputs: PipelineOutputs; // items, categories, tags, collections, brands
	metrics?: PipelineMetrics; // Timing, token usage, etc.
	duration: number; // Total execution time in ms
	stepsCompleted: number;
	totalSteps: number;
	error?: Error | string;
	failedStep?: string;
	warnings?: string[]; // Non-fatal issues
}

interface PipelineOutputs {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	collections: Collection[];
	brands: Brand[];
	domainAnalysis?: DomainAnalysis;
	extra?: Record<string, unknown>;
}
```

## Pipeline Modifier Plugins

Pipeline modifier plugins extend engine-orchestratable pipelines by injecting, replacing, or disabling steps. They implement `IPipelineModifierPlugin`:

```typescript
interface IPipelineModifierPlugin extends IPlugin {
	readonly targetPipelines: readonly string[];

	execute(context: IPipelineContext, options?, onProgress?): Promise<IPipelineContext>;
	getStepDefinitions?(): PipelineStepDefinition[];
	getStepDefinition?(stepId?: string): PipelineStepDefinition | undefined;
	canSkip?(context: IPipelineContext): Promise<boolean>;
	validate?(context: IPipelineContext): Promise<{ valid: boolean; error?: string }>;
	rollback?(context: IPipelineContext, error: Error): Promise<void>;
}
```

The `BasePipelineStep` abstract class simplifies creating modifier plugins:

```typescript
import { BasePipelineStep } from '@ever-works/plugin/abstract';

export class MyCustomStep extends BasePipelineStep {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly stepId = 'my-custom-step';
	readonly stepName = 'My Custom Step';
	readonly stepPosition = BasePipelineStep.after('web-search');
	readonly targetPipelines = ['standard-pipeline'];

	readonly provides = ['customData'];
	readonly requires = ['searchResults'];

	async execute(context, options?, onProgress?) {
		this.reportProgress(onProgress, 0, 'Starting custom processing');
		// Process context.searchResults
		// Add custom data to context
		this.reportProgress(onProgress, 100, 'Done');
		return context;
	}
}
```

### Modifier Positioning Helpers

`BasePipelineStep` provides static helpers for step positioning:

| Helper                                | Position Type           | Example                       |
| ------------------------------------- | ----------------------- | ----------------------------- |
| `BasePipelineStep.after('step-id')`   | After a specific step   | Insert after web search       |
| `BasePipelineStep.before('step-id')`  | Before a specific step  | Insert before item extraction |
| `BasePipelineStep.replace('step-id')` | Replace a step entirely | Replace content filtering     |
| `BasePipelineStep.first()`            | First step              | Run before everything         |
| `BasePipelineStep.last()`             | Last step               | Run as final cleanup          |

The `targetPipelines` array specifies which pipelines the modifier targets. Use `['*']` to target all engine-orchestratable pipelines.
