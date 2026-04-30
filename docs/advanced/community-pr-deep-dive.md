---
id: community-pr-deep-dive
title: Community PR Processing Deep Dive
sidebar_label: Community PR Processing
sidebar_position: 3
---

# Community PR Processing Deep Dive

The community PR system enables directories to accept contributions from external users via GitHub pull requests. When community members submit PRs to a directory's main repository, the system automatically extracts new items, adds them to the data repository, and provides feedback on the PR.

## Architecture

The system is implemented in `packages/agent/src/community-pr/` with a single service:

- **`CommunityPrProcessorService`** -- processes open PRs across all community-enabled directories.

Dependencies:

- **GitFacadeService** -- lists PRs, reads file changes, creates comments, closes PRs
- **AiFacadeService** -- extracts structured item data from PR diffs
- **DirectoryRepository** -- queries directories with community PR enabled, persists state

## Processing Flow

### 1. Directory Discovery

```
processAllDirectories()
  -> findWithCommunityPrEnabled()
  -> for each directory: processDirectory()
```

The scheduler (via Trigger.dev or BullMQ) periodically calls `processAllDirectories()`, which loads all directories with community PR processing enabled.

### 2. PR Enumeration

For each directory, the service:

1. Resolves the directory owner and main repository name.
2. Lists open PRs via `gitFacade.listPullRequests()` (up to 100 per batch).
3. Filters out already-processed PRs using `state.processedPrNumbers` (a Set for O(1) lookups).

### 3. Single PR Processing

For each unprocessed PR, `processSinglePr()` runs:

#### Step 1: Extract Change Context

```typescript
const files = await this.gitFacade.getPullRequestFiles(owner, mainRepo, pr.number, gitOptions);
```

File patches are concatenated into a change context string, capped at 50,000 characters to prevent prompt overflow:

```
--- path/to/file.md (added) ---
+ ## New Tool
+ - [ToolName](https://example.com) - Description of the tool
```

If no meaningful changes are found, the system posts a comment explaining this and skips the PR.

#### Step 2: Clone Data Repository

The data repository is cloned/pulled to get the current state, including existing categories for context.

#### Step 3: AI Item Extraction

The change context is sent to the AI with a structured extraction prompt:

```
You are analyzing a community pull request submitted to the "{directoryName}" directory.
Directory description: {description}
Existing categories: {categoryNames}
PR Title: {prTitle}
PR Changes: {changeContext}

Extract all new items being proposed in this PR...
```

The AI returns a structured response validated against a Zod schema:

```typescript
const extractedItemSchema = z.object({
    items: z.array(z.object({
        name: z.string(),
        description: z.string(),
        source_url: z.string(),
        category: z.string(),
        tags: z.array(z.string()),
    })),
});
```

If zero items are extracted, the system posts a comment and skips.

#### Step 4: Write to Data Repository

For each extracted item:

1. Create the item directory in the data repo.
2. Write the `item.yml` metadata file.
3. Write a markdown description file.

#### Step 5: Commit and Push

```typescript
await this.gitFacade.add(directory.gitProvider, dest, '.');
await this.gitFacade.commit(
    directory.gitProvider, dest,
    `Add ${items.length} item(s) from community PR #${pr.number}`,
);
await this.gitFacade.push({ dir: dest }, gitOptions);
```

#### Step 6: Comment and Optionally Close

The service posts a comment listing all added items:

```
Thank you for your contribution! The following items have been added:
- Tool A
- Tool B
The data repository has been updated automatically.
```

If `autoClose` is enabled on the directory, the PR is closed after processing.

## State Management

Each directory maintains a `CommunityPrState` object:

```typescript
interface CommunityPrState {
    processedPrNumbers: number[];   // PR numbers already processed
    totalItemsAdded: number;        // Cumulative items added
    lastProcessedAt?: string;       // ISO timestamp of last processing
    lastError?: string;             // Most recent error message
}
```

### Bounded Growth

The `processedPrNumbers` array is capped at 500 entries to prevent unbounded growth:

```typescript
if (state.processedPrNumbers.length > MAX_PROCESSED_PR_NUMBERS) {
    state.processedPrNumbers = state.processedPrNumbers.slice(-MAX_PROCESSED_PR_NUMBERS);
}
```

Old PR numbers are trimmed from the start since they are unlikely to reappear as open PRs.

### State Persistence

After processing all unprocessed PRs for a directory, the updated state is saved:

```typescript
await this.directoryRepository.update(directory.id, { communityPrState: state });
```

Item counts are atomically incremented:

```typescript
await this.directoryRepository.increment(directory.id, 'itemsCount', totalItemsAdded);
```

## Error Handling

Errors are handled at two levels:

1. **Per-directory**: If processing a directory fails entirely, the error is logged and added to the result's `errors` array. Other directories continue processing.
2. **Per-PR**: If a single PR fails, the error is logged and stored in `state.lastError`. The PR number is still added to `processedPrNumbers` to avoid reprocessing a broken PR.

## Configuration

Community PR processing is controlled by two directory settings:

| Setting | Type | Description |
|---|---|---|
| `communityPrEnabled` | boolean | Enable/disable community PR processing |
| `communityPrAutoClose` | boolean | Automatically close PRs after processing |

## Limits and Constants

| Constant | Value | Purpose |
|---|---|---|
| `MAX_PROCESSED_PR_NUMBERS` | 500 | Cap on tracked processed PR numbers |
| `MAX_CHANGE_CONTEXT_LENGTH` | 50,000 | Maximum characters of PR diff sent to AI |

## Batch Processing Results

The `processAllDirectories()` method returns an aggregate result:

```typescript
interface CommunityPrProcessingResult {
    processed: number;                          // Total items added across all directories
    errors: Array<{ directoryId: string; error: string }>;  // Failed directories
}
```
