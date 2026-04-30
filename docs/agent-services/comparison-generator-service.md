---
id: comparison-generator-service
title: "ComparisonGenerationService Deep Dive"
sidebar_label: "Comparison Generator"
sidebar_position: 19
---

# ComparisonGenerationService Deep Dive

## Overview

The `ComparisonGenerationService` generates AI-powered comparison pages between pairs of directory items. It supports both automatic pair selection (picking the next best un-compared pair) and manual pair specification. The pipeline researches items via web search, generates structured comparison data with dimension-by-dimension scoring, and produces a full markdown article -- all committed to the directory's data repository.

## Architecture

The comparison system is split into a service layer and a set of pure functions for pair selection, research, and content generation. This design enables thorough unit testing of the core logic without service dependencies.

```
ComparisonGenerationService (NestJS service)
        |
        +-- Pair Selection Layer (pure functions)
        |       +-- selectNextPair()
        |       +-- findManualPair()
        |       +-- countRemainingPairs()
        |       +-- buildPairKey()
        |
        +-- Research Layer (pure function + injected deps)
        |       +-- researchPair()
        |       +-- buildSearchQueries()
        |
        +-- Generation Layer (pure function + injected deps)
        |       +-- generateComparison()
        |           +-- AI structured data (askJson)
        |           +-- AI markdown article (askText)
        |           +-- AI extended analysis (askText, optional)
        |
        +-- Persistence Layer
                +-- DataRepository.writeComparison()
                +-- DataRepository.writeComparisonMarkdown()
                +-- Git add/commit/push
```

## API Reference

### Methods

#### `generateNextComparison(directoryId, userId)`

Automatically selects and generates the next comparison pair.

| Parameter | Type | Description |
|-----------|------|-------------|
| `directoryId` | `string` | The directory ID |
| `userId` | `string` | The requesting user's ID |

**Returns:** `Promise<ComparisonResult>`

```typescript
interface ComparisonResult {
    status: 'success' | 'skipped' | 'error';
    slug?: string;
    message: string;
}
```

#### `generateManualComparison(directoryId, userId, itemASlug, itemBSlug)`

Generates a comparison for two specifically chosen items.

**Returns:** `Promise<ComparisonResult>`

#### `getRemainingCount(directoryId, userId)`

Counts how many un-generated comparison pairs remain.

**Returns:** `Promise<number>`

#### `listComparisons(directoryId, userId)`

Lists all existing comparisons for a directory.

**Returns:** `Promise<ComparisonData[]>`

#### `getComparison(directoryId, userId, slug)`

Retrieves a single comparison by slug, including markdown content and optional extended analysis.

**Returns:** `Promise<{ comparison: ComparisonData | null; markdown?: string; extendedAnalysisMarkdown?: string }>`

#### `deleteComparison(directoryId, userId, slug)`

Deletes a comparison by slug, updates the comparison state, and pushes the changes.

**Returns:** `Promise<ComparisonResult>`

## Implementation Details

### Pair Selection Algorithm

The `selectNextPair()` function implements a category-aware, priority-sorted pair selection:

1. **Group items by category** -- items are grouped by their primary category
2. **Filter by minimum size** -- categories with fewer items than `min_items_for_comparison` (default: 3) are skipped
3. **Sort by priority** -- within each category, items are sorted: featured first, then by order, then alphabetically
4. **Generate all pairs** -- all combinatorial pairs within a category are generated
5. **Skip existing** -- pairs already in `generated_pairs` are filtered out
6. **Return first match** -- the first un-generated pair is returned

### Canonical Pair Keys

Pair keys are order-independent. `buildPairKey('vercel', 'netlify')` and `buildPairKey('netlify', 'vercel')` both produce `"netlify--vercel"`. This prevents duplicate comparisons regardless of argument order.

### Research Pipeline

The `researchPair()` function:

1. Generates up to 4 search queries per pair (e.g., `"Vercel vs Netlify"`, `compare Vercel and Netlify`)
2. Executes up to 3 queries via the search facade
3. Deduplicates results by URL
4. Extracts content from up to 5 top results
5. Trims each extraction to 2,000 characters to control token costs
6. Falls back to search snippets when extraction fails

### Comparison Generation

The `generateComparison()` function makes two (optionally three) AI calls:

1. **Structured data** (`askJson`): Generates title, summary, verdict, verdict winner, and 3-8 scored dimensions
2. **Markdown article** (`askText`): Produces a full article with introduction, feature table, analysis, pros/cons, and verdict
3. **Extended analysis** (`askText`, optional): Deep-dive covering feature breakdowns, use-case analysis, migration considerations, cost analysis, and future outlook

### Dimension Scoring

Each comparison dimension includes:
- Per-item summaries
- Scores from 1-10 for each item
- A winner designation (`item_a`, `item_b`, or `tie`)

The overall verdict also designates a winner.

### Plugin Settings

Comparison behavior is configurable per-directory via the `comparison-generator` plugin:

| Setting | Default | Description |
|---------|---------|-------------|
| `max_comparisons_mode` | `custom` | `custom` (uses max_comparisons) or `unlimited` |
| `max_comparisons` | 50 | Maximum total comparisons to generate |
| `min_items_for_comparison` | 3 | Minimum items in a category to enable comparisons |
| `ai_provider` | (default) | Override AI provider for comparisons |
| `ai_model` | (default) | Override AI model for comparisons |
| `custom_prompt` | (none) | Additional instructions appended to all prompts |
| `extended_analysis` | `false` | Whether to generate extended analysis markdown |

## Database Interactions

| Repository | Method | Purpose |
|------------|--------|---------|
| `DirectoryRepository` | `findById` | Load directory entity |
| `DirectoryPluginRepository` | `findByDirectoryAndPlugin` | Load comparison plugin settings |
| `DataRepository` | `getItems`, `getConfig`, `getComparisons`, `writeComparison`, `writeComparisonMarkdown`, `removeComparison`, `mergeConfig` | Git-backed data operations |

## Event System

This service does not emit domain events. Comparison state is tracked in the data repository's config metadata.

## Error Handling

| Scenario | Result |
|----------|--------|
| Directory not found | `NotFoundException` |
| No pairs available | `{ status: 'skipped', message: 'No more pairs available' }` |
| Item slugs not found | `{ status: 'error', message: 'Could not find items...' }` |
| Comparison already exists | `{ status: 'skipped' }` with existing slug |
| Comparison not found on delete | `{ status: 'error' }` |
| Search/extraction failures | Silently degraded -- continues with available snippets |
| Missing item slugs | Throws `Error` during generation |

## Usage Examples

```typescript
// Generate the next automatic comparison
const result = await comparisonService.generateNextComparison(directoryId, userId);
// { status: 'success', slug: 'netlify--vercel', message: 'Generated comparison: ...' }

// Generate a specific comparison
const result = await comparisonService.generateManualComparison(
    directoryId,
    userId,
    'react',
    'vue',
);

// Check remaining pairs
const remaining = await comparisonService.getRemainingCount(directoryId, userId);
// 45

// List all comparisons
const comparisons = await comparisonService.listComparisons(directoryId, userId);

// Get a comparison with markdown
const detail = await comparisonService.getComparison(directoryId, userId, 'netlify--vercel');

// Delete a comparison
await comparisonService.deleteComparison(directoryId, userId, 'netlify--vercel');
```

## Configuration

| Setting | Source | Description |
|---------|--------|-------------|
| Plugin settings | `DirectoryPluginRepository` | Per-directory comparison configuration |
| AI provider/model | Plugin settings or system default | Controls which AI generates comparisons |
| Search facade | System configuration | Web search provider for research |
| Content extractor | System configuration | Web content extraction provider |

## Related Services

- [Directory Generation](/agent-services/directory-generation) -- may trigger comparison generation as part of scheduled updates
- [Directory Taxonomy](/agent-services/directory-taxonomy-service) -- categories used for pair grouping
- [Advanced Prompts](/agent-services/directory-advanced-prompts) -- custom prompts can be layered via plugin settings
