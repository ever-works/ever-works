---
id: import-system
title: Directory Import System
sidebar_label: Import System
sidebar_position: 1
---

# Directory Import System

The import system allows users to populate directories from external sources rather than starting from scratch. It supports three import modes: importing from an existing data repository, parsing an Awesome List README, and linking to an existing data repository.

## Architecture

The import system is implemented in `packages/agent/src/import/` with three key services:

| Service | Purpose |
|---|---|
| `ImportExecutorService` | Orchestrates import by source type, delegates to specialized methods |
| `AwesomeReadmeParserService` | Parses Awesome List README files using AI to extract structured items |
| `SourceRepoAnalyzerService` | Analyzes repository structure, detects source type, validates access |

## Import Source Types

### Data Repository Import (`data_repo`)

Imports from a structured Ever Works data repository that already contains items, categories, and tags in the expected format.

**Flow:**

1. Clone the source repository via `GitFacadeService.cloneOrPull()`.
2. Create a `DataRepository` instance from the cloned directory.
3. Read items, categories, tags, and config from the repository.
4. Validate that items exist (return error if zero items found).
5. Initialize the target directory with `DataGeneratorService.initializeWithImportedData()`.
6. Initialize markdown and website generators.
7. Return success with import counts.

**Required structure in source repo:**

```
config.yml          # Directory configuration
categories.yml      # Category definitions
data/
  item-slug-1/      # One directory per item
    item.yml         # Item metadata
    README.md        # Item description
  item-slug-2/
    ...
```

### Awesome README Import (`awesome_readme`)

Imports from any GitHub "Awesome List" -- a curated README with categorized links.

**Flow:**

1. Fetch the README content via `SourceRepoAnalyzerService.getReadmeContent()`.
2. Pass the markdown content to `AwesomeReadmeParserService.parseReadme()`.
3. The parser uses AI in three phases:
   - **Phase 1**: Extract category structure from headings.
   - **Phase 2**: Extract items from each category section.
   - **Phase 3**: Deduplicate items and extract unique tags.
4. Initialize the target directory with the parsed data.
5. Initialize markdown and website generators.

### Link Existing Repository (`link_existing`)

Links to an existing data repository that the user already controls, optionally creating missing markdown and website repos.

**Flow:**

1. Analyze the repository for linking suitability via `SourceRepoAnalyzerService.analyzeForLinking()`.
2. Verify write access to the repository.
3. Clone the repository and read its contents.
4. Optionally create missing companion repositories (markdown, website).
5. Return the linked repository data.

## Awesome README Parser

The `AwesomeReadmeParserService` is the most complex part of the import system. It uses AI structured output (via `AiFacadeService.askJson()` with Zod schemas) to extract data from unstructured markdown.

### Text Splitting

Large READMEs are split into chunks using LangChain's `RecursiveCharacterTextSplitter`:

- **Category extraction**: chunks up to 8,000 characters, split on heading boundaries.
- **Item extraction**: chunks up to 6,000 characters with 200-character overlap, split on list item and heading boundaries.

### Category Extraction

The AI is prompted to identify H2/H3 headings that represent content categories, ignoring meta sections like "Contributing", "License", and "Table of Contents". A fallback regex-based extractor runs if AI extraction fails.

### Item Extraction

For each category section, the AI extracts items matching common Awesome List formats:

- `**[Name](url)** - Description`
- `[Name](url) - Description`
- `[Name](url): Description`

Each extracted item includes: name, description, source URL, category, and tags.

### Deduplication

Items are deduplicated by a composite key of `name.toLowerCase()` + `source_url.toLowerCase()`. When duplicates are found, tags are merged.

### Metrics Tracking

The parser tracks total tokens used and total cost across all AI calls, reporting these in the final result for usage monitoring.

## Source Repository Analyzer

The `SourceRepoAnalyzerService` provides repository analysis capabilities:

### URL Parsing

Supports multiple Git providers:

- **GitHub**: `https://github.com/owner/repo`
- **GitLab**: `https://gitlab.com/owner/repo`
- **Bitbucket**: `https://bitbucket.org/owner/repo`

### Repository Type Detection

Analyzes the root directory contents to classify repositories:

1. **Data repo**: Has `config.yml` + `data/` directory.
2. **Awesome README**: Has `README.md` that passes the "awesome list" heuristic (section headers + multiple categorized links).
3. **Unknown**: Neither pattern matches.

### Ecosystem Detection

For non-data repos, the analyzer checks if companion repositories exist following the naming convention: `{slug}-data`, `{slug}-website`. This enables linking workflows where a user points to their existing ecosystem.

## Error Handling

The import system defines typed error codes in `DirectoryImportErrorCode`:

| Error Code | When |
|---|---|
| `PARSE_FAILED` | No items found or README not parseable |
| `CLONE_FAILED` | Git clone operation failed |
| `CREATE_REPO_FAILED` | Failed to initialize the data repository |
| `REPO_ACCESS_DENIED` | User lacks access to the source repository |
| `AI_EXTRACTION_FAILED` | AI-powered extraction encountered an error |

Each import method returns a `DirectoryImportResult` with `success`, `directoryId`, item/category/tag counts on success, or `error` and `errorCode` on failure.
