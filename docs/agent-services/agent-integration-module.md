---
id: agent-integration-module
title: Integration Module
sidebar_label: Integration
sidebar_position: 30
---

# Integration Module

## Overview

The Integration module in `@ever-works/agent` encompasses the systems that connect a work to external sources and community contributions. It includes three major sub-systems: the **Import system** for bootstrapping works from external repositories, the **Community PR processor** for handling community-submitted pull requests, and the **OAuth facade** for managing third-party authentication flows.

Together, these systems allow works to be populated from existing data, accept community contributions via Git pull requests, and authenticate with external services like GitHub for API access.

## Module Structure

```
packages/agent/src/
  import/
    import.module.ts                  # NestJS module definition
    import-executor.service.ts        # Core import orchestration
    source-repo-analyzer.service.ts   # Repository structure analysis
    awesome-readme-parser.service.ts  # Awesome-list README parsing
    index.ts                          # Public exports
  community-pr/
    community-pr.module.ts            # NestJS module definition
    community-pr-processor.service.ts # PR processing service
    index.ts                          # Public exports
  facades/
    oauth.facade.ts                   # OAuth provider facade
  tasks/
    work-import-dispatcher.ts    # Import dispatcher interface
    work-import.types.ts         # Import payload and result types
```

## Key Classes and Services

### Import System

#### `ImportExecutorService`

The core import orchestration service that handles three import source types:

**`importFromDataRepo(options)`**

Imports from an existing Ever Works data repository:

1. Clones the source repository via `GitFacadeService`
2. Reads items, categories, tags, and config from the source using `DataRepository`
3. Initializes the target work's data repository with the imported data
4. Initializes markdown and website repositories from templates
5. Tracks import metadata (source URL, import timestamp, source type)

**`importFromAwesomeReadme(options)`**

Imports from an "awesome list" style README repository:

1. Fetches the README content from the source repository
2. Parses the markdown using `AwesomeReadmeParserService` with AI-assisted extraction
3. Converts parsed items into the Ever Works data format
4. Initializes all three repositories with the extracted data
5. Returns import metrics (items, categories, tags extracted)

**`linkExistingDataRepo(options)`**

Links a work to an existing data repository without copying:

1. Analyzes the repository structure via `SourceRepoAnalyzerService`
2. Verifies write access to the repository
3. Clones and reads the existing data to count items and categories
4. Optionally creates missing markdown and website repositories
5. Links the work to the existing data repo as-is

**`executeBySourceType(options)`**

Dispatcher method that routes to the appropriate import method based on `sourceType`:

| Source Type      | Method                    | Description                            |
| ---------------- | ------------------------- | -------------------------------------- |
| `data_repo`      | `importFromDataRepo`      | Clone and copy from another data repo  |
| `awesome_readme` | `importFromAwesomeReadme` | Parse an awesome-list README with AI   |
| `link_existing`  | `linkExistingDataRepo`    | Link to an existing data repo in-place |

#### `SourceRepoAnalyzerService`

Analyzes external repositories to determine their type and structure:

- **`parseGitUrl(url)`** -- parse a repository URL into `{ owner, repo, provider }`. Supports GitHub, GitLab, and Bitbucket URL patterns.
- **`analyzeRepository(sourceUrl, token?)`** -- analyze a repository's structure and detect its type. Checks for `works.yml` + `data/` work (data repo), or README with list patterns (awesome list).
- **`analyzeForLinking(sourceUrl, token)`** -- extended analysis for the link-existing workflow. Checks write access, counts items/categories, and detects related repos (markdown, website).
- **`checkSlugConflicts(owner, slug, token)`** -- check if repository names would conflict with existing repos. Suggests alternative slugs if conflicts are found.
- **`getReadmeContent(sourceUrl, token?)`** -- fetch README content with multiple fallback strategies.

**Repository type detection:**

The analyzer classifies repositories by examining their contents:

- `data_repo` -- has `works.yml` (or `.yaml`) AND a `data/` work
- `awesome_readme` -- has a README with section headers and 5+ list-formatted links
- `null` -- structure not recognized

**Multi-file awesome list detection:**

The analyzer also detects "multi-file" awesome lists where categories are split into subworks, each with their own README. These are identified by 3+ work links in the main README.

#### `AwesomeReadmeParserService`

Parses markdown README files from "awesome list" repositories using AI to extract structured items:

- Sends the README content to the AI facade for structured extraction
- Uses Zod schemas to validate the AI output
- Returns items with name, description, URL, category, and tags
- Handles both single-file and multi-file awesome list formats

### Community PR Processing

#### `CommunityPrProcessorService`

Processes community-submitted pull requests to the work's main repository, extracting new items via AI and adding them to the data repository:

**`processAllWorks()`**

Batch processor that finds all works with `communityPrEnabled === true` and processes their open PRs:

1. Queries all works with community PR processing enabled
2. For each work, loads the PR processing state (processed PR numbers, total items added)
3. Calls `processWork()` for each
4. Returns aggregate results with processed count and any errors

**`processWork(work, state?, autoClose?)`**

Processes unprocessed PRs for a single work:

1. Lists open PRs on the work's main repository
2. Filters out already-processed PRs using the `communityPrState.processedPrNumbers` set
3. For each unprocessed PR, calls `processSinglePr()`
4. Updates the work's community PR state with new processed numbers
5. Caps `processedPrNumbers` at 500 entries to prevent unbounded growth
6. Atomically increments the work's `itemsCount`

**`processSinglePr(work, pr, gitOptions, autoClose)` (private)**

Processes a single PR:

1. Fetches PR file changes (patches)
2. Builds a change context string from patches (capped at 50,000 characters)
3. Clones the data repository to read existing categories
4. Sends the PR context to the AI facade with a structured extraction prompt
5. Validates extracted items against a Zod schema
6. Writes extracted items to the data repository (creates item works, writes data.json and content.md)
7. Commits and pushes changes to the data repository
8. Comments on the PR with the list of added items
9. Optionally closes the PR if `autoClose` is enabled

**AI extraction schema:**

```typescript
const extractedItemSchema = z.object({
	items: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			source_url: z.string(),
			category: z.string(),
			tags: z.array(z.string())
		})
	)
});
```

### OAuth Facade

#### `OAuthFacadeService`

Implements `IOAuthFacade` and provides OAuth authentication flows through plugin-based providers:

**Capability:** `PLUGIN_CAPABILITIES.OAUTH`

**Operations:**

- **`isConfigured()`** -- check if any OAuth provider is available
- **`getAvailableProviders()`** -- list registered OAuth providers with enabled status
- **`getAuthorizationUrl(providerId, state, config?)`** -- generate the OAuth authorization URL for redirect
- **`exchangeCodeForToken(providerId, code, config?)`** -- exchange an authorization code for an access token
- **`getAuthenticatedUser(providerId, token)`** -- get the authenticated user's profile
- **`hasValidCredentials(userId, providerId)`** -- check if a user has a valid (non-expired) OAuth token
- **`getAccessToken(userId, providerId)`** -- retrieve the stored access token for a user
- **`revokeToken(userId, providerId)`** -- revoke and delete a stored OAuth token

**Token storage:**

OAuth tokens are stored in the `OAuthToken` entity via `OAuthTokenRepository`. The facade handles token lifecycle including expiration checking and remote revocation (if supported by the provider).

**Custom errors:**

- `NoOAuthProviderError` -- no OAuth provider configured
- `OAuthProviderNotFoundError` -- specified provider not found
- `OAuthNotSupportedError` -- plugin does not implement the OAuth interface

## API Reference

### ImportExecutorService

```typescript
executeBySourceType(options: ExecuteBySourceTypeOptions): Promise<WorkImportResult>
importFromDataRepo(options: ImportFromDataRepoOptions): Promise<WorkImportResult>
importFromAwesomeReadme(options: ImportFromAwesomeReadmeOptions): Promise<WorkImportResult>
linkExistingDataRepo(options: LinkExistingDataRepoOptions): Promise<WorkImportResult>
```

### WorkImportResult

```typescript
interface WorkImportResult {
	success: boolean;
	workId: string;
	itemsImported?: number;
	categoriesImported?: number;
	tagsImported?: number;
	error?: string;
	errorCode?: WorkImportErrorCode;
	metrics?: ImportMetrics;
}
```

### SourceRepoAnalyzerService

```typescript
parseGitUrl(url: string): ParsedRepoUrl | null
analyzeRepository(sourceUrl: string, token?: string): Promise<AnalyzeRepositoryResponseDto>
analyzeForLinking(sourceUrl: string, token: string): Promise<AnalyzeForLinkingResponseDto>
checkSlugConflicts(owner: string, slug: string, token: string, provider?: string): Promise<SlugConflictResult>
getReadmeContent(sourceUrl: string, token?: string): Promise<{ content: string; path: string } | null>
```

### CommunityPrProcessorService

```typescript
processAllWorks(): Promise<CommunityPrProcessingResult>
processWork(work: Work, state?: CommunityPrState, autoClose?: boolean): Promise<number>
```

### OAuthFacadeService

```typescript
isConfigured(): boolean
getAvailableProviders(): OAuthProviderInfo[]
getAuthorizationUrl(providerId: string, state: string, config?: Partial<OAuthConfig>): string
exchangeCodeForToken(providerId: string, code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>
getAuthenticatedUser(providerId: string, token: string): Promise<OAuthUser>
hasValidCredentials(userId: string, providerId: string): Promise<boolean>
getAccessToken(userId: string, providerId: string): Promise<string | null>
revokeToken(userId: string, providerId: string): Promise<void>
```

## Configuration

### Import Dispatch

Imports can be dispatched to background workers via the `WORK_IMPORT_DISPATCHER` Symbol token:

```typescript
interface WorkImportDispatcher {
	dispatchWorkImport(payload: WorkImportPayload): Promise<string | null>;
}
```

### Community PR State

The `communityPrState` JSON field on the Work entity tracks processing progress:

```typescript
interface CommunityPrState {
	processedPrNumbers: number[]; // Capped at 500
	totalItemsAdded: number;
	lastProcessedAt?: string; // ISO timestamp
	lastError?: string;
}
```

### Work Import Error Codes

```typescript
enum WorkImportErrorCode {
	CLONE_FAILED = 'CLONE_FAILED',
	PARSE_FAILED = 'PARSE_FAILED',
	CREATE_REPO_FAILED = 'CREATE_REPO_FAILED',
	REPO_ACCESS_DENIED = 'REPO_ACCESS_DENIED',
	AI_EXTRACTION_FAILED = 'AI_EXTRACTION_FAILED'
}
```

### Git Provider URL Patterns

The `SourceRepoAnalyzerService` supports these URL patterns:

| Provider  | Pattern                                |
| --------- | -------------------------------------- |
| GitHub    | `https://github.com/{owner}/{repo}`    |
| GitLab    | `https://gitlab.com/{owner}/{repo}`    |
| Bitbucket | `https://bitbucket.org/{owner}/{repo}` |

URLs with `.git` suffix or trailing slashes are automatically cleaned.

## Dependencies

| Dependency                     | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `@ever-works/agent/facades`    | `GitFacadeService`, `AiFacadeService`, `OAuthFacadeService`                   |
| `@ever-works/agent/generators` | `DataGeneratorService`, `MarkdownGeneratorService`, `WebsiteGeneratorService` |
| `@ever-works/agent/database`   | `WorkRepository`, `OAuthTokenRepository`                                      |
| `@ever-works/plugin`           | `IOAuthPlugin`, `PLUGIN_CAPABILITIES`, plugin interfaces                      |
| `@ever-works/contracts`        | `Category`, `Tag` type definitions                                            |
| `zod`                          | Schema validation for AI extraction output                                    |

## Usage Examples

### Importing from a Data Repository

```typescript
import { ImportExecutorService } from '@ever-works/agent/import';

const result = await importExecutor.importFromDataRepo({
	work,
	user,
	source: { owner: 'example-org', repo: 'tools-data' },
	token: gitAccessToken
});

if (result.success) {
	console.log(`Imported ${result.itemsImported} items, ${result.categoriesImported} categories`);
}
```

### Importing from an Awesome List

```typescript
const result = await importExecutor.importFromAwesomeReadme({
	work,
	user,
	sourceUrl: 'https://github.com/sindresorhus/awesome-nodejs',
	token: gitAccessToken,
	aiProviderOverride: 'openai'
});
```

### Analyzing a Repository Before Import

```typescript
import { SourceRepoAnalyzerService } from '@ever-works/agent/import';

const analysis = await analyzer.analyzeRepository('https://github.com/example/cool-tools', token);

console.log(`Type: ${analysis.detectedType}`); // 'data_repo' | 'awesome_readme' | null
console.log(`Items: ${analysis.structure.itemCount}`);
console.log(`Public: ${analysis.isPublic}`);
```

### Processing Community PRs

```typescript
import { CommunityPrProcessorService } from '@ever-works/agent/community-pr';

// Process all enabled works (typically called by a cron job)
const result = await processor.processAllWorks();
console.log(`Processed ${result.processed} items from community PRs`);
result.errors.forEach((e) => {
	console.error(`Work ${e.workId}: ${e.error}`);
});
```

### OAuth Authentication Flow

```typescript
import { OAuthFacadeService } from '@ever-works/agent/facades';

// Step 1: Generate authorization URL
const authUrl = oauthFacade.getAuthorizationUrl('github', stateToken);
// Redirect user to authUrl...

// Step 2: Exchange code for token (after redirect callback)
const token = await oauthFacade.exchangeCodeForToken('github', authorizationCode);

// Step 3: Get user info
const githubUser = await oauthFacade.getAuthenticatedUser('github', token.accessToken);

// Later: Check if credentials are still valid
const isValid = await oauthFacade.hasValidCredentials(userId, 'github');
```
