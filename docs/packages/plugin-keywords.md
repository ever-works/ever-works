---
id: plugin-keywords
title: Plugin Keywords System
sidebar_label: Plugin Keywords System
sidebar_position: 8
---

# Plugin Keywords System

The Plugin Keywords module (`@ever-works/plugin/keywords`) provides keyword extraction utilities used throughout the platform for search optimization, content categorization, and relevance scoring. It combines stopword removal, Unicode-aware tokenization via `Intl.Segmenter`, and regex fallback strategies to extract meaningful terms from text content and user prompts.

## Package Overview

| Property         | Value                                                           |
| ---------------- | --------------------------------------------------------------- |
| **Import path**  | `@ever-works/plugin/keywords`                                   |
| **Location**     | `platform/packages/plugin/src/keywords/`                        |
| **Dependencies** | None (uses only built-in `Intl.Segmenter` and regex)            |
| **Used by**      | Search plugins, content generation pipeline, item deduplication |

## Module Exports

```typescript
export { extractKeywords, extractKeywordsFromPrompt } from './keyword-utils.js';
```

## Core Functions

### extractKeywords

Extracts significant keywords from arbitrary text content. Designed for processing longer text like item descriptions, article bodies, or page content.

```typescript
import { extractKeywords } from '@ever-works/plugin/keywords';

const keywords = extractKeywords('The best TypeScript frameworks for building modern web applications in 2025');
// => ['typescript', 'frameworks', 'building', 'modern', 'web', 'applications', '2025']
```

### extractKeywordsFromPrompt

Optimized for shorter user-provided prompts. Applies the same extraction pipeline but with adjusted thresholds suited for query-length text.

```typescript
import { extractKeywordsFromPrompt } from '@ever-works/plugin/keywords';

const keywords = extractKeywordsFromPrompt('Find open source React component libraries');
// => ['open', 'source', 'react', 'component', 'libraries']
```

## Extraction Pipeline

Both functions follow the same multi-step extraction pipeline:

### Step 1: Text Normalization

The input text is normalized before tokenization:

| Operation                | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| Lowercase conversion     | All text is lowercased for consistent matching                 |
| Whitespace normalization | Multiple spaces, tabs, and newlines collapsed to single spaces |
| Trimming                 | Leading and trailing whitespace removed                        |

### Step 2: Tokenization

The module uses a two-tier tokenization strategy:

**Primary: `Intl.Segmenter`**

When available (Node.js 16+), the module uses `Intl.Segmenter` with word-level granularity for Unicode-aware tokenization. This correctly handles:

- CJK (Chinese, Japanese, Korean) characters
- Accented characters and diacritics
- Hyphenated compound words
- Punctuation-adjacent words

```typescript
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const segments = segmenter.segment(text);

for (const { segment, isWordLike } of segments) {
	if (isWordLike) {
		tokens.push(segment);
	}
}
```

**Fallback: Regex Splitting**

When `Intl.Segmenter` is unavailable, the module falls back to regex-based splitting:

```typescript
const tokens = text.split(/[\s\-_.,;:!?'"()\[\]{}|\\/<>@#$%^&*+=~`]+/).filter((token) => token.length > 0);
```

### Step 3: Stopword Removal

Extracted tokens are filtered against a comprehensive stopword list. The stopword set includes common English function words that carry little semantic meaning.

**Stopword Categories:**

| Category        | Examples                                                           |
| --------------- | ------------------------------------------------------------------ |
| Articles        | the, a, an                                                         |
| Prepositions    | in, on, at, to, for, with, from, by, about, between                |
| Conjunctions    | and, or, but, nor, yet, so                                         |
| Pronouns        | i, you, he, she, it, we, they, this, that, these, those            |
| Auxiliary verbs | is, are, was, were, be, been, being, have, has, had, do, does, did |
| Common verbs    | will, would, shall, should, can, could, may, might, must           |
| Adverbs         | very, really, just, also, only, even, still, already, here, there  |
| Determiners     | some, any, all, each, every, no, other, another                    |
| Misc            | not, than, then, when, where, how, what, which, who, whom          |

```typescript
const STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'in',
	'on',
	'at',
	'to',
	'for',
	'of',
	'with',
	'by',
	'from',
	'is',
	'are',
	'was',
	'were'
	// ... comprehensive list
]);
```

### Step 4: Minimum Length Filter

After stopword removal, tokens shorter than a minimum length are discarded:

| Function                    | Minimum Length |
| --------------------------- | -------------- |
| `extractKeywords`           | 2 characters   |
| `extractKeywordsFromPrompt` | 2 characters   |

This removes single-character artifacts while preserving meaningful short terms like abbreviations and numbers.

### Step 5: Deduplication

The final keyword list is deduplicated while preserving the order of first occurrence. This ensures that repeated terms in the source text do not inflate the keyword list.

```typescript
const unique = [...new Set(filteredTokens)];
```

## Usage Patterns

### Search Query Enhancement

```typescript
import { extractKeywordsFromPrompt } from '@ever-works/plugin/keywords';

async function searchItems(userQuery: string): Promise<Item[]> {
	const keywords = extractKeywordsFromPrompt(userQuery);

	// Use keywords for database full-text search
	return itemRepository.search({
		keywords,
		matchAny: true
	});
}
```

### Content Categorization

```typescript
import { extractKeywords } from '@ever-works/plugin/keywords';

function categorizeItem(item: ItemData): string[] {
	const titleKeywords = extractKeywords(item.name);
	const descKeywords = extractKeywords(item.description);

	const allKeywords = [...new Set([...titleKeywords, ...descKeywords])];
	return matchCategories(allKeywords, categoryDefinitions);
}
```

### Deduplication Scoring

```typescript
import { extractKeywords } from '@ever-works/plugin/keywords';

function calculateSimilarity(itemA: ItemData, itemB: ItemData): number {
	const keywordsA = new Set(extractKeywords(itemA.name + ' ' + itemA.description));
	const keywordsB = new Set(extractKeywords(itemB.name + ' ' + itemB.description));

	const intersection = new Set([...keywordsA].filter((k) => keywordsB.has(k)));
	const union = new Set([...keywordsA, ...keywordsB]);

	return intersection.size / union.size; // Jaccard similarity
}
```

### Pipeline Integration

The keywords module is used within the content generation pipeline for:

| Stage                   | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| Search query generation | Extracting core terms from user prompts to build web search queries |
| Content filtering       | Matching extracted web content against user intent keywords         |
| Deduplication           | Comparing keyword overlap between items to identify duplicates      |
| Category assignment     | Mapping item keywords to predefined category taxonomies             |
| Tag generation          | Suggesting tags based on frequently occurring extracted keywords    |

## Design Decisions

### Why `Intl.Segmenter` Over Simple Regex

The `Intl.Segmenter` API provides ICU-standard word boundary detection, which handles edge cases that regex cannot:

| Scenario             | Regex Result                    | Segmenter Result        |
| -------------------- | ------------------------------- | ----------------------- |
| `"can't"`            | `['can', 't']`                  | `['can't']`             |
| `"state-of-the-art"` | `['state', 'of', 'the', 'art']` | `['state-of-the-art']`  |
| `"C++"`              | `['C']`                         | `['C++']`               |
| CJK text             | Incorrect splits                | Correct word boundaries |

### Why No Stemming

The module intentionally does not apply stemming (e.g., Porter stemmer) because:

1. Stemming can merge semantically different terms (e.g., "running" and "run" may have different relevance)
2. The keywords are used for exact-match search in many contexts
3. The overhead of stemming is unnecessary for the platform's primary use cases
4. LLM-based processing downstream handles semantic similarity

## File Structure

```
plugin/src/keywords/
  index.ts          # Public exports
  keyword-utils.ts  # extractKeywords and extractKeywordsFromPrompt implementation
```
