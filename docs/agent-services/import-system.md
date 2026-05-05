---
id: import-system
title: 'Import System Deep Dive'
sidebar_label: 'Import System'
sidebar_position: 18
---

# Import System Deep Dive

## Overview

The Import System is a module comprising three services that handle the low-level mechanics of importing works from external sources. `SourceRepoAnalyzerService` detects repository types and structures, `AwesomeReadmeParserService` uses AI to extract structured data from Awesome List READMEs, and `ImportExecutorService` orchestrates the end-to-end import execution for each source type.

## Architecture

The module is composed of three distinct services with clear responsibilities:

```
WorkImportService (orchestrator layer)
        |
        v
ImportModule
        |
        +-- SourceRepoAnalyzerService
        |       |
        |       +-- parseGitUrl()           --> URL parsing for GitHub/GitLab/Bitbucket
        |       +-- analyzeRepository()     --> Type detection (data_repo, awesome_readme)
        |       +-- analyzeForLinking()     --> Link-existing feasibility check
        |       +-- getReadmeContent()      --> README fetching with fallbacks
        |       +-- checkSlugConflicts()    --> Git provider slug collision detection
        |
        +-- AwesomeReadmeParserService
        |       |
        |       +-- parseReadme()           --> Full AI-powered extraction pipeline
        |           |
        |           +-- extractCategories() --> Multi-chunk category extraction
        |           +-- extractItemsFromSection() --> Per-section item extraction
        |           +-- deduplicateItems()  --> Cross-section deduplication
        |
        +-- ImportExecutorService
                |
                +-- executeBySourceType()   --> Router for import strategies
                +-- importFromDataRepo()    --> Clone + copy data
                +-- importFromAwesomeReadme() --> AI parse + generate repos
                +-- linkExistingDataRepo()  --> Verify + link repos
```

## SourceRepoAnalyzerService

### URL Parsing

The `parseGitUrl()` method supports multiple git providers:

| Provider  | URL Pattern                            |
| --------- | -------------------------------------- |
| GitHub    | `https://github.com/{owner}/{repo}`    |
| GitLab    | `https://gitlab.com/{owner}/{repo}`    |
| Bitbucket | `https://bitbucket.org/{owner}/{repo}` |

All patterns handle optional `.git` suffixes and trailing slashes.

### Repository Type Detection

The `analyzeRepository()` method inspects repository contents to determine the source type:

| Detection          | Criteria                                                     | Result Type      |
| ------------------ | ------------------------------------------------------------ | ---------------- |
| Data Repository    | Has root `works.yml` AND `data/` work                        | `data_repo`      |
| Awesome List       | Has `README.md` with section headers + list links (5+ items) | `awesome_readme` |
| Multi-file Awesome | Has `README.md` with 3+ internal work links                  | `awesome_readme` |
| Unrecognized       | None of the above                                            | `null`           |

### Ecosystem Detection

For non-data repos, the service detects the "work ecosystem" by looking for companion `-data` repos. For example, analyzing `my-work-website` will detect `my-work-data` as the data repo and return `baseSlug: 'my-work'`.

### Slug Conflict Checking

`checkSlugConflicts()` checks three repo names (`{slug}`, `{slug}-data`, `{slug}-website`) against the git provider. If conflicts exist, it suggests alternatives from `{slug}-2` through `{slug}-10`, falling back to a timestamp-based suffix.

## AwesomeReadmeParserService

### Three-Stage Pipeline

The parser processes Awesome List READMEs in three stages:

**Stage 1: Category Extraction**

- Splits large READMEs into chunks (8,000 chars each) if needed
- Sends each chunk to AI with the `CATEGORY_EXTRACTION_PROMPT`
- Deduplicates categories by ID across chunks
- Falls back to regex-based header extraction if AI fails

**Stage 2: Item Extraction**

- Splits README into sections based on extracted categories
- For each section, sends content to AI with the `ITEM_EXTRACTION_PROMPT`
- Large sections are further chunked (6,000 chars with 200-char overlap)
- Processes chunks with a 500ms delay between batches to avoid rate limiting

**Stage 3: Finalization**

- Extracts unique tags from all items
- Deduplicates items by name + source URL combination
- Merges tags from duplicate items

### Token Metrics Tracking

The parser tracks AI token usage and cost through an accumulator pattern:

```typescript
interface MetricsAccumulator {
	total_tokens_used: number;
	total_cost: number;
}
```

These metrics are returned in the `ParsedAwesomeData` response for billing and monitoring.

### Fallback Category Extraction

If AI-based category extraction fails, the service falls back to regex-based extraction that:

- Finds all H2/H3 markdown headers
- Filters out meta sections (Contents, Contributing, License, Authors, etc.)
- Generates slugified IDs from header text

## ImportExecutorService

### Source Type Router

The `executeBySourceType()` method routes to the appropriate import strategy based on `ImportSourceType`:

| Source Type      | Strategy Method             | Requires Token |
| ---------------- | --------------------------- | -------------- |
| `data_repo`      | `importFromDataRepo()`      | Yes            |
| `awesome_readme` | `importFromAwesomeReadme()` | Optional       |
| `link_existing`  | `linkExistingDataRepo()`    | Yes            |

### Data Repo Import Flow

1. Clone the source data repository via `GitFacadeService`
2. Read items, categories, tags, and config from the `DataRepository`
3. Initialize the new work's data repo with imported data
4. Generate markdown and website repos

### Awesome README Import Flow

1. Fetch README content via `SourceRepoAnalyzerService`
2. Parse with `AwesomeReadmeParserService` (AI extraction)
3. Initialize the new work's data repo with parsed data
4. Generate markdown and website repos

### Link Existing Flow

1. Verify linking feasibility via `SourceRepoAnalyzerService.analyzeForLinking()`
2. Clone and read the existing data repo to get item/category/tag counts
3. Optionally create missing markdown/website repos if `createMissingRepos` is set

### Error Codes

All import strategies return `WorkImportResult` with typed error codes:

| Error Code             | Meaning                                   |
| ---------------------- | ----------------------------------------- |
| `PARSE_FAILED`         | Could not parse README or no items found  |
| `CLONE_FAILED`         | Git clone/pull operation failed           |
| `REPO_ACCESS_DENIED`   | Token missing or insufficient permissions |
| `CREATE_REPO_FAILED`   | Failed to initialize data repository      |
| `AI_EXTRACTION_FAILED` | AI-based extraction failed                |
| `GENERATION_FAILED`    | Data generation step failed               |

## Database Interactions

The Import System services primarily interact with git repositories through `GitFacadeService` and `DataRepository` rather than the database directly. The orchestrating `WorkImportService` handles database persistence.

## Event System

The Import System does not emit events directly. Events are emitted by the orchestrating `WorkImportService`.

## Error Handling

- **SourceRepoAnalyzerService:** Returns structured error responses in the DTO rather than throwing exceptions. All git provider errors are caught and translated to user-friendly messages.
- **AwesomeReadmeParserService:** Uses per-chunk error handling -- individual chunk failures are logged and skipped, with parsing continuing on remaining chunks. Parse errors are collected and returned in `metadata.parseErrors`.
- **ImportExecutorService:** Catches all errors per strategy and returns structured `WorkImportResult` with typed error codes.

## Usage Examples

```typescript
// Analyze a repository
const analysis = await sourceRepoAnalyzer.analyzeRepository('https://github.com/sindresorhus/awesome-nodejs', token);
// analysis.detectedType === 'awesome_readme'
// analysis.structure.itemCount === 150

// Parse an awesome readme
const parsed = await awesomeReadmeParser.parseReadme(readmeContent, { userId: user.id, workId: work.id });
// parsed.items.length === 150
// parsed.categories.length === 20
// parsed.metrics.total_tokens_used === 45000

// Execute a full import
const result = await importExecutor.executeBySourceType({
	work,
	user,
	sourceType: 'awesome_readme',
	sourceOwner: 'sindresorhus',
	sourceRepo: 'awesome-nodejs',
	sourceUrl: 'https://github.com/sindresorhus/awesome-nodejs',
	token
});
// result.success === true, result.itemsImported === 150
```

## Configuration

| Setting               | Value       | Description                                       |
| --------------------- | ----------- | ------------------------------------------------- |
| `MAX_CHUNK_SIZE`      | 6,000 chars | Maximum size for item extraction chunks           |
| `CHUNK_OVERLAP`       | 200 chars   | Overlap between adjacent chunks                   |
| `CATEGORY_CHUNK_SIZE` | 8,000 chars | Maximum size for category extraction chunks       |
| `BATCH_DELAY_MS`      | 500ms       | Delay between AI calls to avoid rate limiting     |
| AI temperature        | 0.1         | Low temperature for consistent extraction results |

## Related Services

- [Work Import Service](/agent-services/work-import-service) -- orchestrates import operations using this module
- [Community PR Service](/agent-services/community-pr-service) -- similar AI extraction pattern for PR diffs
- [Work Detail Service](/agent-services/work-detail-service) -- complementary metadata extraction
