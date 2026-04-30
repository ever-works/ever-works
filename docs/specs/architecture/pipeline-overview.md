# Pipeline Architecture Overview

## Overview

The Ever Works directory generation system uses a **14-step sequential pipeline** orchestrated by Trigger.dev for background execution. The pipeline transforms a user's prompt into a fully populated directory with items, categories, tags, markdown content, and a deployed website.

## High-Level Flow

```
User Request
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DirectoryGenerationService                    │
│  (Entry point - validates, creates history, dispatches to       │
│   Trigger.dev)                                                  │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼ [Trigger.dev Task]
┌─────────────────────────────────────────────────────────────────┐
│                TriggerGenerationOrchestrator                     │
│  Coordinates three generator services sequentially:              │
│                                                                  │
│  1. DataGeneratorService.initialize()                           │
│     └── ItemsGeneratorService.generateItems()                   │
│         └── PipelineExecutor (14 steps)                         │
│                                                                  │
│  2. MarkdownGeneratorService.initialize()                       │
│     └── Creates/updates markdown repository                     │
│                                                                  │
│  3. WebsiteGeneratorService.initialize()                        │
│     └── Creates/duplicates website template                     │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Repositories                          │
│  ├── Data Repository (YAML config + JSON items)                 │
│  ├── Markdown Repository (README + details/)                    │
│  └── Website Repository (Next.js template)                      │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Steps (14 Total)

### Phase 1: Prompt Analysis (Steps 1-3)

| Step | Service                 | Purpose                                           |
| ---- | ----------------------- | ------------------------------------------------- |
| 1    | PromptComparisonService | Compare new vs existing prompt for similarity     |
| 2    | PromptProcessingService | Extract subject, categories, keywords from prompt |
| 3    | DomainDetectionService  | Classify domain type (SOFTWARE, ECOMMERCE, etc.)  |

### Phase 2: Content Discovery (Steps 4-5, Parallel)

| Step | Service                      | Purpose                                    |
| ---- | ---------------------------- | ------------------------------------------ |
| 4a   | AiItemGenerationService      | Generate items directly from AI (optional) |
| 4b   | SearchQueryGenerationService | Generate search queries for web crawling   |
| 5    | WebPageRetrievalService      | Execute searches, retrieve web pages       |

### Phase 3: Content Extraction (Steps 6-8)

| Step | Service                 | Purpose                                     |
| ---- | ----------------------- | ------------------------------------------- |
| 6    | ContentFilteringService | Filter pages by relevance threshold         |
| 7    | ItemExtractionService   | Extract items from filtered pages using LLM |
| 8    | DataAggregationService  | Deduplicate and merge with existing items   |

### Phase 4: Content Enhancement (Steps 9-12)

| Step | Service                   | Purpose                                  |
| ---- | ------------------------- | ---------------------------------------- |
| 9    | CategoryProcessingService | Assign categories and tags               |
| 10   | SourceValidationService   | Validate source URLs are official        |
| 11   | BadgeProcessingService    | Evaluate and assign badges (optional)    |
| 12   | MarkdownGenerationService | Generate detailed markdown for each item |

## Generation Context

The `GenerationContext` object flows through all pipeline steps, accumulating data:

```typescript
interface GenerationContext {
	// Input (immutable)
	directory: Directory;
	dto: CreateItemsGeneratorDto;
	existing: ExistingItems;

	// Accumulated State
	searchQueries: string[]; // From step 4b
	webPages: WebPageData[]; // From step 5
	contentCache: Map<string, string>; // URL → content cache

	// Generated Items (evolves through pipeline)
	initialAiItems: ItemData[]; // From step 4a
	extractedWebItems: ItemData[]; // From step 7
	aggregatedItems: ItemData[]; // From step 8
	finalItems: ItemData[]; // Final output
	finalCategories: Category[];
	finalTags: Tag[];

	// Intelligence
	domainAnalysis?: DomainAnalysis;
	advancedPrompts?: AdvancedPromptsContext;

	// Metrics
	metrics: ItemsGeneratorMetrics;
}
```

## Checkpointing & Resilience

The `PipelineExecutor` implements checkpointing for fault tolerance:

```typescript
// After each step completes:
await this.saveCheckpoint(directoryId, {
    completedSteps: ['STEP_1', 'STEP_2', ...],
    context: serializedContext,
    timestamp: Date.now()
});

// On resume:
const checkpoint = await this.loadCheckpoint(directoryId);
if (checkpoint) {
    // Skip completed steps, resume from last
}
```

**Checkpoint Storage**: CacheManager with 1-hour TTL

**Serialization**: Context is serialized excluding non-serializable objects (Directory entity, Map instances)

## Trigger.dev Integration

```typescript
// Task definition
export const directoryGenerationTask = task({
	id: 'directory-generation',
	maxDuration: 3600 * 5, // 5 hours
	machine: 'medium-1x', // Configurable
	run: async (payload: DirectoryGenerationPayload) => {
		const orchestrator = new TriggerGenerationOrchestrator();
		return orchestrator.run(payload);
	}
});

// Payload structure
interface DirectoryGenerationPayload {
	directoryId: string;
	userId: string;
	mode: 'create' | 'update';
	dto: CreateItemsGeneratorDto;
	historyId: string;
	triggerSource: 'user' | 'schedule' | 'api';
}
```

## Configuration Options

| Option                        | Default | Description                    |
| ----------------------------- | ------- | ------------------------------ |
| `max_search_queries`          | 10      | Max search queries to generate |
| `max_results_per_query`       | 5       | Results per search             |
| `max_pages_to_process`        | 10      | Max pages to process           |
| `relevance_threshold_content` | 0.6     | Minimum relevance (0-1)        |
| `ai_first_generation_enabled` | false   | Skip web search, use AI only   |
| `content_filtering_enabled`   | true    | Filter irrelevant pages        |
| `badge_evaluation_enabled`    | false   | Enable badge evaluation        |

## Error Handling

1. **Step Failure**: Logged, checkpoint saved, can resume
2. **AI Provider Failure**: Retries with exponential backoff
3. **GitHub API Failure**: Retries, falls back gracefully
4. **Cancellation**: Handled via Trigger.dev `onCancel` hook

## Key File Locations

```
/packages/agent/src/
├── items-generator/
│   ├── items-generator.service.ts      # Main orchestrator
│   ├── pipeline/pipeline-executor.ts   # Step execution
│   └── steps/                          # 14 step services
├── data-generator/
│   └── data-generator.service.ts       # Data repo management
├── markdown-generator/
│   └── markdown-generator.service.ts   # Markdown repo management
└── website-generator/
    └── website-generator.service.ts    # Website repo creation

/packages/tasks/src/
├── tasks/trigger/
│   └── directory-generation.task.ts    # Trigger.dev task
└── trigger/
    └── trigger-generation.orchestrator.ts
```

## See Also

- [Data Generator Spec](../features/data-generator/spec.md)
- [Markdown Generator Spec](../features/markdown-generator/spec.md)
- [Website Generator Spec](../features/website-generator/spec.md)
