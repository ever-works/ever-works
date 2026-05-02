---
id: standard-pipeline-deep-dive
title: Standard Pipeline Plugin Deep Dive
sidebar_label: Standard Pipeline
sidebar_position: 61
---

# Standard Pipeline Plugin Deep Dive

## Overview

The Standard Pipeline plugin (`@ever-works/plugins/standard-pipeline`) is the default work generation engine in Ever Works. It implements a 15-step, engine-orchestrated pipeline that transforms a user prompt into a fully structured work with items, categories, tags, badges, images, and markdown descriptions.

Unlike the Agent Pipeline (which uses autonomous tool calling), the Standard Pipeline follows a deterministic execution order where each step runs in sequence with explicit data dependencies. The pipeline engine controls step execution, checkpoint/resume, and context management.

- **Plugin ID**: `standard-pipeline`
- **Category**: `pipeline`
- **Capabilities**: `pipeline`, `form-schema`
- **Configuration Mode**: `hybrid`
- **Source**: `packages/plugins/standard-pipeline/src/`

## Architecture

### Pipeline Phases and Steps

The 15 built-in steps are organized into 8 logical phases:

| Phase                     | Step ID                              | Step Name                        | Est. Duration |
| ------------------------- | ------------------------------------ | -------------------------------- | ------------- |
| **1. Initialization**     | `prompt-comparison`                  | Prompt Comparison                | 5s            |
|                           | `prompt-processing`                  | Prompt Processing                | 5s            |
|                           | `domain-detection`                   | Domain Detection                 | 5s            |
| **2. Content Generation** | `ai-first-items-generation`          | AI First Items Generation        | 30s           |
| **3. Search**             | `search-queries-generation`          | Search Queries Generation        | 10s           |
|                           | `web-search`                         | Web Search                       | 30s           |
| **4. Extraction**         | `content-retrieval`                  | Content Retrieval                | 30s           |
|                           | `content-filtering`                  | Content Filtering                | 10s           |
|                           | `items-extraction`                   | Items Extraction                 | 30s           |
| **5. Aggregation**        | `deduplication-and-data-aggregation` | Deduplication & Data Aggregation | 15s           |
| **6. Categorization**     | `categories-tags-processing`         | Categories & Tags Processing     | 15s           |
| **7. Enrichment**         | `sources-validation`                 | Sources Validation               | 20s           |
|                           | `badges-processing`                  | Badges Processing                | 10s           |
|                           | `image-capture`                      | Image Capture                    | 30s           |
| **8. Output**             | `markdown-generation`                | Markdown Generation              | 30s           |

### Step Dependencies

Each step declares explicit `provides` and `requires` arrays that the pipeline engine uses to validate execution order and determine checkpoint viability:

```
prompt-comparison    → provides: ['prompt-comparison-result']
prompt-processing    → provides: ['extractedUrls', 'subject', 'allInitialCategories', ...]
domain-detection     → provides: ['domainAnalysis']
                       requires: ['subject']
ai-first-items-gen   → provides: ['initialAiItems']
                       requires: ['subject', 'domainAnalysis']
search-queries-gen   → provides: ['searchQueries']
                       requires: ['subject']
web-search           → provides: ['webPages', 'contentCache']
                       requires: ['searchQueries', 'extractedUrls']
content-retrieval    → provides: ['retrievedContent']
                       requires: ['webPages']
content-filtering    → provides: ['filteredContent']
                       requires: ['retrievedContent']
items-extraction     → provides: ['extractedWebItems']
                       requires: ['filteredContent', 'domainAnalysis']
dedup-and-aggregation → provides: ['aggregatedItems', 'finalItems']
                        requires: ['initialAiItems', 'extractedWebItems']
categories-tags      → provides: ['finalCategories', 'finalTags', ...]
                       requires: ['finalItems', 'domainAnalysis']
sources-validation   → provides: ['validatedSources']
                       requires: ['finalItems']
badges-processing    → provides: ['processedBadges']
                       requires: ['finalItems']
image-capture        → provides: ['capturedImages']
                       requires: ['finalItems']
markdown-generation  → provides: ['generatedMarkdown']
                       requires: ['finalItems', 'finalCategories']
```

### Engine-Orchestrated Execution

The Standard Pipeline is **engine-orchestrated**, meaning the pipeline engine (not the plugin itself) controls step execution. The plugin's top-level `execute()` method throws an error if called directly:

```typescript
async execute(): Promise<PipelineResult> {
    throw new Error(
        'StandardPipelinePlugin uses engine-orchestrated execution. ' +
        'Call executeStep() for individual steps.'
    );
}
```

Instead, the engine calls `executeStep(stepId, context, execContext)` for each step, which routes to the appropriate step class.

### Context System

The pipeline uses a typed context system with three key components:

1. **`MutableGenerationContext`** - The mutable state bag passed between steps. Contains all pipeline data: `extractedUrls`, `searchQueries`, `webPages`, `initialAiItems`, `extractedWebItems`, `aggregatedItems`, `finalItems`, `finalCategories`, `finalTags`, `contentCache`, `metrics`, `domainAnalysis`, `subject`, and more.

2. **`TypedGenerationContext`** - Concrete implementation that adds `toSnapshot()` and `fromSnapshot()` for checkpoint/resume, plus `getStepResult()`/`setStepResult()` for typed step data access.

3. **`StepDataTypes`** - Type mapping interface that maps `StepDataKey` strings to their concrete types, providing type safety for step result storage and retrieval.

### Checkpoint and Resume

The `TypedGenerationContext` supports serialization via `toSnapshot()` which captures all context state as a JSON-serializable object. The `fromSnapshot()` static method reconstructs the context from a snapshot. The plugin also implements `isCheckpointViable()` to determine whether a checkpoint at a given step has enough data to resume meaningfully.

## Configuration

### Settings Schema

The Standard Pipeline provides a comprehensive form schema through the `IFormSchemaProvider` interface. Key configuration groups:

#### Sources & Content

| Field                 | Type       | Default | Description                       |
| --------------------- | ---------- | ------- | --------------------------------- |
| `source_urls`         | `string[]` | `[]`    | Seed URLs to extract content from |
| `initial_categories`  | `string[]` | `[]`    | Pre-defined categories            |
| `priority_categories` | `string[]` | `[]`    | Categories that appear first      |

#### Search Settings

| Field                   | Type     | Default | Description                           |
| ----------------------- | -------- | ------- | ------------------------------------- |
| `max_search_queries`    | `number` | `10`    | Maximum search queries to execute     |
| `max_results_per_query` | `number` | `10`    | Results per search query              |
| `max_pages_to_process`  | `number` | `50`    | Maximum pages to extract content from |

#### Volume Settings

| Field       | Type     | Default | Description                 |
| ----------- | -------- | ------- | --------------------------- |
| `max_items` | `number` | `50`    | Target number of work items |

#### Feature Toggles

| Field                 | Type      | Default    | Description                   |
| --------------------- | --------- | ---------- | ----------------------------- |
| `enable_badges`       | `boolean` | `true`     | Enable badge processing       |
| `enable_screenshots`  | `boolean` | `true`     | Enable image capture          |
| `capture_screenshots` | `boolean` | `false`    | Capture screenshots for items |
| `generation_method`   | `string`  | `'CREATE'` | `CREATE` or `CREATE_UPDATE`   |

#### Advanced Settings

| Field              | Type     | Default | Description               |
| ------------------ | -------- | ------- | ------------------------- |
| `advanced_prompts` | `object` | `{}`    | Per-step prompt overrides |

### Form Schema Provider

The plugin implements `IFormSchemaProvider` to provide dynamic form fields for the UI:

```typescript
getFormSchema(): PluginFormSchema {
    return {
        fields: [...],
        groups: [
            { id: 'sources', label: 'Sources & Content', ... },
            { id: 'search', label: 'Search Settings', ... },
            { id: 'volume', label: 'Volume', ... },
            { id: 'features', label: 'Features', ... },
            { id: 'advanced', label: 'Advanced', ... }
        ],
        validation: [...],
        defaults: { ... },
        transforms: { ... }
    };
}
```

## Capabilities

### Core Capabilities

- **`pipeline`** - Full work generation from prompt to structured output
- **`form-schema`** - Dynamic form field definitions for the generation UI

### What the Pipeline Produces

The pipeline outputs a complete `PipelineResult` containing:

- **Items** with name, slug, description, source URL, image, featured flag, badges
- **Categories** with names, slugs, item assignments, priority ordering
- **Tags** extracted and normalized from content
- **Collections** for grouping related items
- **Brands** detected from item data
- **Markdown** descriptions generated for each item
- **Metrics** including token usage, costs, items extracted, pages retrieved

## API Reference

### Plugin Class

```typescript
class StandardPipelinePlugin implements IPlugin, IPipelinePlugin<BuiltInStepId>, IFormSchemaProvider {
	readonly id = 'standard-pipeline';
	readonly name = 'Standard Pipeline';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'pipeline';
	readonly capabilities = ['pipeline', 'form-schema'];
	readonly executionMode = 'engine-orchestrated';

	// Step execution (called by engine)
	async executeStep(
		stepId: BuiltInStepId,
		context: PipelineContext,
		execContext: StepExecutionContext
	): Promise<PipelineContext>;

	// Step definitions
	getSteps(): PipelineStepDefinition<BuiltInStepId>[];

	// Checkpoint viability
	isCheckpointViable(stepId: BuiltInStepId, context: PipelineContext): boolean;

	// Form schema
	getFormSchema(): PluginFormSchema;

	// Lifecycle
	async onLoad(context: PluginContext): Promise<void>;
	async onUnload(): Promise<void>;
	async healthCheck(): Promise<PluginHealthCheck>;
	getManifest(): PluginManifest;
}
```

### Step Interface

Each step extends `BasePipelineStep`:

```typescript
abstract class BasePipelineStep implements IBuiltInStepExecutor {
	abstract readonly stepId: string;
	abstract readonly name: string;

	// Called by engine
	async run(context: PipelineContext, execContext: StepExecutionContext): Promise<PipelineContext>;

	// Implemented by each step
	abstract execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext>;

	// Metric accumulation
	protected accumulateMetrics(metrics: StandardPipelineMetrics, usage: TokenUsage, cost?: CostBreakdown): void;

	// Warning helper
	protected addWarning(context: MutableGenerationContext, message: string): void;
}
```

### Built-In Step IDs

```typescript
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

### Metrics

```typescript
interface StandardPipelineMetrics extends PipelineMetrics {
	urlsExtracted: number;
	pagesRetrieved: number;
	itemsExtracted: number;
	itemsAfterDedup: number;
}
```

## Implementation Details

### Step 1: Prompt Comparison (`prompt-comparison`)

Compares a new prompt with the existing work's previous prompt (for `CREATE_UPDATE` mode). Uses AI with a zod schema to determine if prompts are related:

```typescript
const schema = z.object({
	areRelated: z.boolean(),
	confidence: z.number().min(0).max(1),
	reasoning: z.string()
});
```

Falls back to Jaccard similarity (word overlap) if the AI call fails. If prompts are unrelated with high confidence, the step adds a warning to the context.

### Step 2: Prompt Processing (`prompt-processing`)

Extracts structured metadata from the user's free-text prompt:

- **URLs** - Explicitly mentioned URLs extracted for content retrieval
- **Categories** - Category hints from phrases like "organize into categories: X, Y, Z"
- **Priority Categories** - Categories with priority indicators ("start with X", "X first")
- **Featured Item Hints** - Items to highlight ("feature X", "showcase X")
- **Subject** - Core topic stripped of decorative words ("Awesome Vector Databases" becomes "vector databases")
- **Rewritten Prompt** - Clean prompt with URLs and meta-instructions removed

Uses AI with structured output (zod schema). Falls back to regex URL extraction and simple pattern-based subject extraction on failure.

### Step 3: Domain Detection (`domain-detection`)

Classifies the work's domain to optimize downstream extraction:

```typescript
interface DomainAnalysis {
	domain_type: 'software' | 'ecommerce' | 'services' | 'general';
	confidence: number;
	item_noun: string;
	expected_attributes: string[];
	official_source_patterns: string[];
	aggregator_domains: string[];
}
```

Falls back to `'software'` domain type on failure.

### Step 4: AI First Items Generation (`ai-first-items-generation`)

Two-phase generation:

1. **Clarity Assessment** - AI evaluates whether the prompt is clear enough for direct item generation
2. **Item Generation** - Generates initial items from AI knowledge, incorporating featured item hints and domain analysis

Uses `extractedItemsSchema` for structured validation. Generates items with name, description, source URL, category, tags, and featured status.

### Step 5: Search Queries Generation (`search-queries-generation`)

Generates optimized search queries based on the subject, domain analysis, and any gaps identified in AI-generated items.

### Step 6: Web Search (`web-search`)

Executes search queries and retrieves web content:

- Uses `SearchFacade` for web search queries
- Uses `ContentExtractorFacade` for content extraction from URLs
- Batch processing with `BATCH_SIZE = 10`
- 1-second delay between search batches, 500ms for URL batches
- Deduplicates URLs across extracted URLs and search results
- Populates `contentCache` for reuse in markdown generation
- Reports search provider errors as user-facing warnings

### Step 7-8: Content Retrieval and Filtering

Retrieves full content from discovered URLs and filters out irrelevant or low-quality pages based on domain analysis and content heuristics.

### Step 9: Items Extraction (`items-extraction`)

Extracts work items from web page content:

- Uses `RecursiveCharacterTextSplitter` with `MAX_CHUNK_SIZE = 6000` and `CHUNK_OVERLAP = 200`
- Processes chunks in batches of 10
- Deduplicates by normalized item name
- Validates extracted items against the domain schema

### Step 10: Deduplication & Data Aggregation (`deduplication-and-data-aggregation`)

Merges and deduplicates items from all sources:

1. Combines AI-generated items with web-extracted items
2. Deduplicates by field (slug, source_url)
3. Identifies new items vs. existing items (for `CREATE_UPDATE`)
4. AI-powered deduplication for fuzzy matching
5. Queries data sources for enrichment
6. Applies `max_items` limit

### Step 11: Categories & Tags Processing (`categories-tags-processing`)

Organizes items into categories and tags:

- Processes initial categories from prompt extraction
- Applies priority ordering
- Normalizes and deduplicates tags
- Creates collections and brand groupings
- Applies category assignment from domain analysis

### Step 12: Sources Validation (`sources-validation`)

Validates source URLs for accessibility and correctness.

### Step 13: Badges Processing (`badges-processing`)

Assigns badges (e.g., "Open Source", "Free", "Popular") to items based on their attributes and content analysis.

### Step 14: Image Capture (`image-capture`)

Captures screenshots for items that have source URLs but no images:

- Uses `ScreenshotFacade.getSmartImage()` for domain-aware image capture
- Only processes items without existing images
- 500ms delay between captures to respect rate limits
- Handles failures gracefully (items remain without images)

### Step 15: Markdown Generation (`markdown-generation`)

Generates markdown descriptions for each item using the content cache populated during web search. Leverages the AI facade for content summarization and formatting.

## Usage Examples

### Basic Work Generation

```typescript
// The pipeline is invoked by the engine, not directly
// Configuration is passed through the generation request:

const request = {
	prompt: 'Create a work of the best React component libraries',
	config: {
		max_items: 30,
		max_search_queries: 8,
		max_results_per_query: 10,
		enable_badges: true,
		enable_screenshots: true,
		generation_method: 'CREATE'
	}
};
```

### Update Existing Work

```typescript
const request = {
	prompt: 'Add more animation and charting libraries',
	config: {
		generation_method: 'CREATE_UPDATE',
		max_items: 50,
		source_urls: ['https://github.com/topics/react-components']
	}
};
```

### With Categories and Priority

```typescript
const request = {
	prompt: 'Create a work of DevOps tools. Categories: CI/CD, Monitoring, Infrastructure. Start with CI/CD.',
	config: {
		initial_categories: ['CI/CD', 'Monitoring', 'Infrastructure'],
		priority_categories: ['CI/CD']
	}
};
```

## Error Handling

### Step-Level Error Handling

Each step wraps its execution in try/catch blocks. Errors are handled in three ways:

1. **Warnings** - Non-fatal issues are added to context via `addWarning()` and surfaced to the user
2. **Fallbacks** - Many steps have fallback logic (e.g., regex URL extraction when AI fails, Jaccard similarity when prompt comparison AI fails)
3. **Propagation** - Critical errors propagate to the engine, which handles checkpoint storage and user notification

### Common Error Patterns

| Error                      | Step              | Handling                                   |
| -------------------------- | ----------------- | ------------------------------------------ |
| AI call failure            | prompt-processing | Falls back to regex URL extraction         |
| Search provider error      | web-search        | Adds warning with provider name, continues |
| Content extraction failure | web-search        | Logs warning, skips URL, continues batch   |
| Screenshot capture failure | image-capture     | Logs error, item remains without image     |
| Domain detection failure   | domain-detection  | Falls back to 'software' domain type       |
| Prompt comparison failure  | prompt-comparison | Falls back to Jaccard word similarity      |

### Metrics Tracking

Every AI call accumulates metrics (input/output tokens, cost) through `accumulateMetrics()`. The `StandardPipelineMetrics` extends base metrics with pipeline-specific counters:

- `urlsExtracted` - Total URLs found from prompt and search
- `pagesRetrieved` - Pages successfully fetched
- `itemsExtracted` - Items extracted from web content
- `itemsAfterDedup` - Items remaining after deduplication

## Related Plugins

- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Alternative autonomous pipeline using tool calling
- **[Claude Code](./claude-code-deep-dive.md)** - Alternative pipeline delegating to Claude Code CLI
- **[Search plugins](./search-plugins.md)** (Exa, Tavily, SerpAPI, Brave) - Used by the `web-search` step via `SearchFacade`
- **[Content Extraction plugins](./content-extraction-plugins.md)** (Local Content Extractor, Notion Extractor) - Used by `web-search` and `content-retrieval` steps via `ContentExtractorFacade`
- **[Screenshot plugins](./screenshotone-deep-dive.md)** (ScreenshotOne, Urlbox) - Used by the `image-capture` step via `ScreenshotFacade`
- **[AI Provider plugins](./openai-plugin-deep-dive.md)** (OpenAI, Anthropic, Google, Groq, etc.) - Used by all AI-powered steps via `AiFacade`
