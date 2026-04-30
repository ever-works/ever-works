---
id: agent-items-module
title: Items Module
sidebar_label: Items
sidebar_position: 25
---

# Items Module

## Overview

The Items module in `@ever-works/agent` handles individual item lifecycle within a directory -- submission, removal, metadata updates, and content enrichment. Items are the fundamental content units of a directory, stored as structured data in per-item directories within the Git-backed data repository.

The module supports two workflow modes for item modifications: direct-commit (changes are pushed to the main branch immediately) and PR-based (changes are submitted as pull requests for review). The PR-based workflow integrates with the community PR processing system for external contributions.

## Module Structure

```
packages/agent/src/
  items-generator/
    item-submission.service.ts       # Core item submission, removal, update
    items-generator.module.ts        # NestJS module definition
  generators/
    data-generator/
      data-repository.ts             # Item file I/O (data.json, content.md)
  services/
    directory-generation.service.ts  # Higher-level item operations (submitItem, removeItem, etc.)
  dto/
    submit-item.dto.ts               # Submission validation
```

## Key Classes and Services

### `ItemSubmissionService`

The core service for item-level operations that manages Git repository interactions:

**`submitItem(directory, user, itemData, options)`**

Adds a new item to the directory:

1. Clones or pulls the data repository locally
2. Creates the item directory structure (`data/<item-slug>/`)
3. Writes `data.json` (structured metadata) and `content.md` (markdown description)
4. If a `source_url` is provided, attempts to auto-capture a screenshot via the screenshot facade
5. Commits the changes with a descriptive message
6. Either pushes directly to main or creates a pull request, based on the `autoapproval` setting

**`removeItem(directory, user, itemSlug, options)`**

Removes an item from the directory:

1. Clones or pulls the data repository
2. Verifies the item directory exists
3. Removes the entire item directory
4. Commits and pushes (direct or PR-based)

**`updateItem(directory, user, itemSlug, metadata, options)`**

Updates item metadata without changing content:

1. Clones or pulls the data repository
2. Reads the existing `data.json`
3. Merges in the metadata updates (e.g., `featured`, `order`, custom fields)
4. Writes back and commits

**Workflow modes:**

| Mode          | Behavior                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Direct commit | Changes pushed to main branch immediately. Used when the user is the directory owner/editor.        |
| PR-based      | Changes submitted as a pull request. Used for community contributions or when approval is required. |

The mode is determined by the `autoapproval` option and the user's role in the directory.

### `DataRepository` (Item Methods)

Low-level file operations for item data:

- `getItems()` -- scan all item directories under `data/` and parse their `data.json` files
- `getItem(slug)` -- read a single item's data
- `createItemDir(itemData)` -- create the `data/<slug>/` directory
- `writeItem(itemData)` -- write `data.json` with structured fields
- `writeItemMarkdown(itemData, markdown)` -- write `content.md`
- `removeItemDir(slug)` -- delete an item directory

### Item Data Structure

Each item is stored in `data/<item-slug>/` with two files:

**`data.json`:**

```json
{
	"name": "Example Tool",
	"slug": "example-tool",
	"description": "A brief description of the tool",
	"source_url": "https://example.com",
	"category": "developer-tools",
	"tags": ["open-source", "freemium"],
	"images": ["screenshot.png"],
	"featured": false,
	"order": 0,
	"metadata": {}
}
```

**`content.md`:**

```markdown
# Example Tool

A detailed description of the tool with markdown formatting.

## Features

- Feature 1
- Feature 2
```

## API Reference

### ItemSubmissionService

```typescript
submitItem(
    directory: Directory,
    user: User,
    itemData: {
        name: string;
        slug?: string;
        description: string;
        source_url?: string;
        category?: string;
        tags?: string[];
        content?: string;
    },
    options?: {
        autoapproval?: boolean;
        prTitle?: string;
        prBody?: string;
    }
): Promise<{ slug: string; prUrl?: string }>

removeItem(
    directory: Directory,
    user: User,
    itemSlug: string,
    options?: { autoapproval?: boolean }
): Promise<{ prUrl?: string }>

updateItem(
    directory: Directory,
    user: User,
    itemSlug: string,
    metadata: {
        featured?: boolean;
        order?: number;
        [key: string]: unknown;
    },
    options?: { autoapproval?: boolean }
): Promise<void>
```

### DirectoryGenerationService (Item Operations)

Higher-level wrappers that add validation, notifications, and item count tracking:

```typescript
submitItem(directory: Directory, user: User, itemData: SubmitItemDto): Promise<void>
removeItem(directory: Directory, user: User, itemSlug: string): Promise<void>
updateItemMetadata(directory: Directory, user: User, slug: string, metadata: object): Promise<void>
extractItemDetails(directory: Directory, user: User, url: string): Promise<ExtractedItemDetails>
```

## Configuration

### Auto-Screenshot Capture

When a `source_url` is provided during item submission, the system attempts to capture a screenshot if the screenshot facade is configured. The captured image is saved to the item's directory and referenced in `data.json`.

This behavior is automatic and requires no configuration beyond having a screenshot provider plugin enabled (e.g., `screenshotone`, `urlbox`).

### PR-Based Workflow Settings

PR-based submission is controlled by:

- The `autoapproval` option on the submission call
- The user's role in the directory (owners/editors default to direct commit)
- The directory's `communityPrEnabled` setting (enables external PR processing)

### Item Slug Generation

If no `slug` is provided, it is auto-generated from the item name using `slugifyText()`. Slugs must be unique within a directory -- the service checks for existing item directories before creating.

## Dependencies

| Dependency                     | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `@ever-works/agent/facades`    | `GitFacadeService` for repository operations, `ScreenshotFacadeService` for auto-capture |
| `@ever-works/agent/generators` | `DataRepository` for item file I/O                                                       |
| `@ever-works/agent/utils`      | `slugifyText` for slug generation                                                        |
| `isomorphic-git`               | Local git clone, commit, push operations                                                 |

## Usage Examples

### Submitting a New Item

```typescript
import { ItemSubmissionService } from '@ever-works/agent/items-generator';

const result = await submissionService.submitItem(
	directory,
	user,
	{
		name: 'VS Code',
		description: 'A powerful code editor by Microsoft',
		source_url: 'https://code.visualstudio.com',
		category: 'developer-tools',
		tags: ['editor', 'open-source', 'microsoft']
	},
	{ autoapproval: true }
);

console.log(`Item created: ${result.slug}`); // 'vs-code'
```

### Removing an Item

```typescript
await submissionService.removeItem(directory, user, 'vs-code', {
	autoapproval: true
});
```

### Submitting via Pull Request

```typescript
const result = await submissionService.submitItem(
	directory,
	user,
	{
		name: 'New Tool',
		description: 'A new tool to add',
		source_url: 'https://newtool.dev'
	},
	{
		autoapproval: false,
		prTitle: 'Add New Tool to directory',
		prBody: 'This tool provides...'
	}
);

console.log(`PR created: ${result.prUrl}`);
```

### Updating Item Metadata

```typescript
await submissionService.updateItem(directory, user, 'vs-code', {
	featured: true,
	order: 1
});
```
