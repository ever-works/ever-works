---
id: comparison-generator
title: Comparison Generator
sidebar_label: Comparison Generator
sidebar_position: 2
---

# Comparison Generator

The comparison generator creates structured "X vs Y" comparison pages for items within a directory. It combines web research, AI analysis, and scored dimensions to produce detailed comparison content.

## Architecture

The comparison system spans two packages:

| Location                                   | Purpose                             |
| ------------------------------------------ | ----------------------------------- |
| `packages/agent/src/comparison-generator/` | Core service and generation logic   |
| `packages/plugins/comparison-generator/`   | Plugin manifest and settings schema |

### Core Service

`ComparisonGenerationService` orchestrates the full comparison workflow. It is a NestJS injectable service that depends on:

- **AiFacadeService** -- structured AI output and text generation
- **SearchFacadeService** -- web search for research data
- **ContentExtractorFacadeService** -- web page content extraction
- **GitFacadeService** -- reading and writing to data repositories

### Supporting Modules

The `comparison/` subdirectory contains pure functions and focused modules:

| Module                     | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `pair-selector.ts`         | Selects the next uncompared pair of items          |
| `comparison-researcher.ts` | Researches two items via web search and extraction |
| `comparison-writer.ts`     | Generates comparison content via AI                |

## Comparison Workflow

### 1. Pair Selection

The `selectNextPair()` function picks the best pair to compare next:

- Groups items by category.
- Prioritizes same-category pairs (more meaningful comparisons).
- Skips already-generated pairs tracked in `comparison_state.generated_pairs`.
- Respects `minItemsForComparison` (minimum items in a category to enable comparisons) and `maxComparisons` limits.

Pair keys are order-independent: `buildPairKey('vercel', 'netlify')` always produces `netlify--vercel` (alphabetical order).

### 2. Research Phase

The `researchPair()` function gathers context about both items:

- Performs web searches for each item individually and as a comparison query.
- Extracts content from the most relevant result URLs.
- Returns combined research context for the AI generation step.

### 3. AI Generation

The `generateComparison()` function produces structured output:

**Structured JSON output** (via Zod schema):

```typescript
{
    title: string,           // e.g., "Vercel vs Netlify"
    summary: string,         // Brief comparison overview
    verdict: string,         // Overall assessment
    verdict_winner: 'item_a' | 'item_b' | 'tie',
    dimensions: [{
        name: string,        // e.g., "Performance"
        item_a_summary: string,
        item_b_summary: string,
        item_a_score: number, // 1-10
        item_b_score: number, // 1-10
        winner: 'item_a' | 'item_b' | 'tie',
    }],
}
```

**Markdown content** -- a human-readable comparison article.

**Extended analysis** (optional) -- deeper analysis when `extended_analysis` is enabled in plugin settings.

### 4. Persistence

Results are written to the data repository:

- Comparison metadata as YAML (`comparisons/{slug}.yml`).
- Markdown content (`comparisons/{slug}.md`).
- Optional extended analysis markdown.
- Config updated with comparison state tracking.
- Changes committed and pushed to Git.

## Plugin Settings

The comparison generator is controlled via the `comparison-generator` plugin, which provides these settings:

| Setting                    | Default   | Description                                           |
| -------------------------- | --------- | ----------------------------------------------------- |
| `max_comparisons_mode`     | `limited` | `limited` or `unlimited`                              |
| `max_comparisons`          | 10        | Maximum comparison count when limited                 |
| `min_items_for_comparison` | 3         | Minimum items in a category to enable comparisons     |
| `ai_provider`              | (default) | Override the AI provider for comparison generation    |
| `ai_model`                 | (default) | Override the AI model                                 |
| `custom_prompt`            | (none)    | Custom instructions appended to the comparison prompt |
| `extended_analysis`        | false     | Generate extended analysis content                    |

## API Operations

The service exposes five operations:

| Method                                                        | Purpose                                      |
| ------------------------------------------------------------- | -------------------------------------------- |
| `generateNextComparison(directoryId, userId)`                 | Auto-select and generate the next comparison |
| `generateManualComparison(directoryId, userId, itemA, itemB)` | Generate comparison for two specific items   |
| `listComparisons(directoryId, userId)`                        | List all comparisons for a directory         |
| `getComparison(directoryId, userId, slug)`                    | Get a single comparison with markdown        |
| `deleteComparison(directoryId, userId, slug)`                 | Delete a comparison and update state         |

## Manual vs Automatic Comparisons

- **Automatic**: The system picks the best pair via `selectNextPair()`. Returns `skipped` if no pairs remain.
- **Manual**: The user specifies two item slugs. Returns `skipped` if the comparison already exists.

Both flows share the same generation pipeline after pair selection.

## State Tracking

Comparison state is persisted in the data repository's `config.yml` under `metadata.comparison_state`:

```yaml
metadata:
    comparison_state:
        generated_pairs:
            - 'netlify--vercel'
            - 'angular--react'
        last_generated_at: '2025-01-15T10:30:00.000Z'
        total_generated: 2
```

This prevents re-generating existing comparisons and enables the `countRemainingPairs()` function to report how many comparisons are left to generate.
