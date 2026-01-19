# Items Generation Pipeline

## Overview

The Items Generation Pipeline is the core content discovery and extraction system that transforms a user's prompt into structured directory items. It uses a 14-step sequential pipeline with AI-powered content discovery, extraction, deduplication, and enrichment.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ItemsGeneratorService                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   PipelineExecutor                        │   │
│  │                                                           │   │
│  │   Step 1: PromptComparison                               │   │
│  │      ↓                                                    │   │
│  │   Step 2: PromptProcessing                               │   │
│  │      ↓                                                    │   │
│  │   Step 3: DomainDetection                                │   │
│  │      ↓                                                    │   │
│  │   Step 4: [Parallel]                                     │   │
│  │      ├── AiItemGeneration                                │   │
│  │      └── SearchQueryGeneration                           │   │
│  │      ↓                                                    │   │
│  │   Step 5: WebPageRetrieval                               │   │
│  │      ↓                                                    │   │
│  │   Step 6: ContentFiltering                               │   │
│  │      ↓                                                    │   │
│  │   Step 7: ItemExtraction                                 │   │
│  │      ↓                                                    │   │
│  │   Step 8: DataAggregation                                │   │
│  │      ↓                                                    │   │
│  │   Step 9: CategoryProcessing                             │   │
│  │      ↓                                                    │   │
│  │   Step 10: SourceValidation                              │   │
│  │      ↓                                                    │   │
│  │   Step 11: BadgeProcessing                               │   │
│  │      ↓                                                    │   │
│  │   Step 12: MarkdownGeneration                            │   │
│  │                                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Returns: {items, categories, tags, brands, metrics}            │
└─────────────────────────────────────────────────────────────────┘
```

## Pipeline Steps Detail

### Step 1: Prompt Comparison

**Service**: `PromptComparisonService`

**Purpose**: Determines if the new prompt is related to the existing directory content.

**Logic**:

```typescript
// If similarity < threshold, treats as fresh start
if (promptSimilarity.confidence < config.prompt_comparison_confidence_threshold) {
	context.shouldResetExisting = true;
}
```

**Inputs**: `dto.prompt`, `existing.initialPrompt`

**Outputs**: `context.shouldResetExisting`

---

### Step 2: Prompt Processing

**Service**: `PromptProcessingService`

**Purpose**: Extracts structured information from the user's natural language prompt.

**AI Prompt Used**: Extracts subject, categories, keywords, featured item hints

**Inputs**: `dto.prompt`, `dto.initial_categories`, `dto.priority_categories`

**Outputs**:

- `context.subject` - Main topic
- `context.allInitialCategories` - Merged categories
- `context.allPriorityCategories` - Priority ordering
- `context.featuredItemHints` - Items to mark as featured
- `context.extractedUrls` - URLs mentioned in prompt

---

### Step 3: Domain Detection

**Service**: `DomainDetectionService`

**Purpose**: Classifies the directory's domain type for domain-specific processing.

**Domain Types**:

```typescript
enum DomainType {
	SOFTWARE = 'software', // Tools, libraries, APIs
	ECOMMERCE = 'ecommerce', // Products, stores
	SERVICES = 'services', // Service providers
	GENERAL = 'general' // Catch-all
}
```

**Outputs**:

```typescript
context.domainAnalysis = {
	domain_type: DomainType.SOFTWARE,
	confidence: 0.95,
	item_noun: 'tool',
	expected_attributes: ['pricing', 'open_source', 'github_url'],
	official_source_patterns: ['github.com', 'gitlab.com'],
	aggregator_domains: ['alternativeto.net', 'g2.com']
};
```

---

### Step 4a: AI Item Generation (Parallel)

**Service**: `AiItemGenerationService`

**Enabled**: `config.ai_first_generation_enabled`

**Purpose**: Generate items directly from AI knowledge without web search.

**Custom Prompt Support**: `advancedPrompts.itemGeneration`

**Outputs**: `context.initialAiItems`

---

### Step 4b: Search Query Generation (Parallel)

**Service**: `SearchQueryGenerationService`

**Purpose**: Generate optimized search queries to find relevant content.

**Custom Prompt Support**: `advancedPrompts.searchQuery`

**Example Output**:

```typescript
context.searchQueries = [
	'best open source monitoring tools 2024',
	'prometheus alternatives comparison',
	'cloud native observability platforms'
];
```

---

### Step 5: Web Page Retrieval

**Service**: `WebPageRetrievalService`

**Purpose**: Execute searches and retrieve web page content.

**Search Provider**: Tavily API

**Outputs**:

```typescript
context.webPages = [
	{
		source_url: 'https://example.com/tools',
		retrieved_at: '2024-01-15T10:30:00Z',
		raw_content: '...'
	}
];
context.contentCache = Map<string, string>; // URL → content
```

---

### Step 6: Content Filtering

**Service**: `ContentFilteringService`

**Purpose**: Filter pages by relevance to reduce noise and API costs.

**Custom Prompt Support**: `advancedPrompts.relevanceAssessment`

**Logic**:

```typescript
// Each page gets relevance score 0-1
const relevance = await assessRelevance(page, context.subject);
if (relevance >= config.relevance_threshold_content) {
	filteredPages.push(page);
}
```

---

### Step 7: Item Extraction

**Service**: `ItemExtractionService`

**Purpose**: Extract structured items from web page content using LLM.

**Custom Prompt Support**: `advancedPrompts.itemExtraction`

**Chunking**: Large pages split into 3000-char chunks with 200-char overlap

**Output Schema** (Zod):

```typescript
const itemDataSchema = z.object({
	name: z.string(),
	description: z.string(),
	source_url: z.string().url(),
	featured: z.boolean().optional(),
	tags: z.array(z.string()).optional()
});
```

---

### Step 8: Data Aggregation & Deduplication

**Service**: `DataAggregationService`

**Sub-services**:

- `AiDeduplicatorService` - AI-based duplicate detection
- `NewItemsExtractorService` - Identify truly new items

**Custom Prompt Support**: `advancedPrompts.deduplication`

**Deduplication Rules**:

- Same/similar names (React vs React.js)
- Same URL (ignoring www, trailing slashes)
- Same underlying product (Docker vs Docker Desktop)

**Outputs**: `context.aggregatedItems` (only new, deduplicated items)

---

### Step 9: Category Processing

**Service**: `CategoryProcessingService`

**Purpose**: Assign categories and tags to items.

**Custom Prompt Support**: `advancedPrompts.categorization`

**Rules**:

- ONE category per item
- 1-3 tags per item
- Max 50 items per category (creates new if exceeded)
- Maintains consistency with existing categories

**Outputs**: `context.finalCategories`, `context.finalTags`, items with categories

---

### Step 10: Source Validation

**Service**: `SourceValidationService`

**Purpose**: Validate that source URLs are official/canonical.

**Custom Prompt Support**: `advancedPrompts.sourceValidation`

**URL Classifications**:

- `official_website` - Company's main site
- `github` - Official repository
- `documentation` - Official docs
- `blog` - Blog post (lower priority)
- `aggregator` - Third-party listing (filtered out)

---

### Step 11: Badge Processing

**Service**: `BadgeProcessingService`

**Enabled**: `config.badge_evaluation_enabled`

**Badge Types**:

```typescript
interface ItemBadges {
	open_source?: boolean;
	verified?: boolean;
	featured?: boolean;
	// Domain-specific badges
}
```

---

### Step 12: Markdown Generation

**Service**: `MarkdownGenerationService`

**Purpose**: Generate detailed markdown content for each item.

**Uses**: `context.contentCache` for source content

**Output**: Items with `markdown` field populated

---

## Interfaces

### ItemData

```typescript
interface ItemData {
	name: string;
	description: string;
	source_url: string;
	slug?: string;
	category: string;
	tags: string[];
	featured?: boolean;
	order?: number;
	markdown?: string;
	badges?: ItemBadges;
	brand?: string;
	brand_logo_url?: string | null;
	images?: string[];
}
```

### GenerationContext

See [Pipeline Overview](../../architecture/pipeline-overview.md) for full interface.

### CreateItemsGeneratorDto

```typescript
class CreateItemsGeneratorDto {
	name: string; // Directory name
	prompt: string; // User's description
	company?: CompanyDto; // Optional company info
	initial_categories?: string[]; // Seed categories
	priority_categories?: string[]; // First-shown categories
	target_keywords?: string[]; // Search keywords
	source_urls?: string[]; // Seed URLs
	config: ConfigDto; // Generation config
	generation_method?: 'CREATE_UPDATE' | 'RECREATE';
	update_with_pull_request?: boolean;
	badge_evaluation_enabled?: boolean;
}
```

## Configuration

### ConfigDto

| Field                                    | Type    | Default | Description                 |
| ---------------------------------------- | ------- | ------- | --------------------------- |
| `max_search_queries`                     | number  | 10      | Max queries to generate     |
| `max_results_per_query`                  | number  | 5       | Results per query           |
| `max_pages_to_process`                   | number  | 10      | Max pages to process        |
| `relevance_threshold_content`            | number  | 0.6     | Min relevance (0-1)         |
| `min_content_length_for_extraction`      | number  | 100     | Min chars for extraction    |
| `ai_first_generation_enabled`            | boolean | false   | Enable AI-only generation   |
| `content_filtering_enabled`              | boolean | true    | Enable relevance filtering  |
| `prompt_comparison_confidence_threshold` | number  | 0.5     | Prompt similarity threshold |

## Advanced Prompts (Per-Directory Customization)

Users can append custom instructions to each pipeline step:

```typescript
interface AdvancedPromptsContext {
	relevanceAssessment?: string; // Step 6
	itemGeneration?: string; // Step 4a
	itemExtraction?: string; // Step 7
	searchQuery?: string; // Step 4b
	categorization?: string; // Step 9
	deduplication?: string; // Step 8
	sourceValidation?: string; // Step 10
}
```

Custom prompts are **appended** (not replaced) using:

```typescript
function appendCustomPrompt(basePrompt: string, customPrompt?: string): string {
	if (!customPrompt) return basePrompt;
	return `${basePrompt}\n\n## Additional User Instructions:\n${customPrompt}`;
}
```

## Metrics

```typescript
interface ItemsGeneratorMetrics {
	urls_scanned: number;
	pages_processed: number;
	items_extracted_current_run: number;
	new_items_added_to_store: number;
	total_items_in_store: number;
	total_tokens_used?: number;
	total_cost?: number;
}
```

## File Locations

```
/packages/agent/src/items-generator/
├── items-generator.service.ts          # Main service
├── items-generator.module.ts           # NestJS module
├── interfaces/
│   ├── pipeline.interface.ts           # GenerationContext, IPipelineStep
│   └── items-generator.interfaces.ts   # WebPageData, DomainAnalysis
├── dto/
│   ├── create-items-generator.dto.ts   # Input DTO
│   ├── item-data.dto.ts                # ItemData
│   └── items-generator-response.dto.ts # Response DTO
├── schemas/
│   └── item-extraction.schemas.ts      # Zod schemas
├── constants/
│   └── steps.ts                        # ItemsGeneratorStep enum
├── pipeline/
│   ├── pipeline-executor.ts            # Step orchestration
│   └── steps/parallel.step.ts          # Parallel execution
├── steps/                              # 14 step services
│   ├── prompt-comparison.service.ts
│   ├── prompt-processing.service.ts
│   ├── domain-detection.service.ts
│   ├── ai-item-generation.service.ts
│   ├── search-query-generation.service.ts
│   ├── web-page-retrieval.service.ts
│   ├── content-filtering.service.ts
│   ├── item-extraction.service.ts
│   ├── data-aggregation.service.ts
│   ├── data-aggregation/
│   │   ├── ai-deduplicator.service.ts
│   │   ├── new-items-extractor.service.ts
│   │   └── shared-utils.service.ts
│   ├── category-processing.service.ts
│   ├── source-validation.service.ts
│   ├── badge-processing.service.ts
│   └── markdown-generation.service.ts
├── shared/
│   ├── search.service.ts               # Tavily integration
│   └── badge-evaluation.service.ts
└── utils/
    ├── text.utils.ts                   # Slugify, etc.
    ├── metrics.util.ts                 # Metrics accumulation
    ├── prompt.util.ts                  # Custom prompt appending
    └── error.util.ts
```

## See Also

- [Pipeline Overview](../../architecture/pipeline-overview.md)
- [Advanced Prompts Spec](../advanced-prompts/spec.md)
- [Data Generator Spec](../data-generator/spec.md)
