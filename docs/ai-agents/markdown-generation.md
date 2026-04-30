---
id: markdown-generation
title: Markdown Content Generation
sidebar_label: Markdown Generation
sidebar_position: 4
---

# Markdown Content Generation

The Markdown Generation system transforms structured directory data into human-readable README files and detail pages. It creates a separate Git repository that serves as the public-facing markdown representation of a directory.

## Architecture Overview

Located in `packages/agent/src/generators/markdown-generator/`, the system comprises:

| Component                  | File                            | Purpose                                       |
| -------------------------- | ------------------------------- | --------------------------------------------- |
| `MarkdownGeneratorService` | `markdown-generator.service.ts` | Orchestrates the markdown generation workflow |
| `MarkdownRepository`       | `markdown-repository.ts`        | File I/O for the markdown repository          |
| `ReadmeBuilder`            | `readme-builder.ts`             | Programmatic README.md construction           |
| `MarkdownGeneratorModule`  | `markdown-generator.module.ts`  | NestJS module definition                      |

## Markdown Repository Structure

Each directory gets a dedicated markdown repository with this layout:

```
<directory-slug>/
  README.md            # Auto-generated README with categorized item listings
  LICENSE.md           # License file (copied from data repo)
  details/
    <item-slug>.md     # Detailed markdown content per item
```

## Generation Workflow

The `MarkdownGeneratorService.initialize()` method runs the full pipeline:

### Step 1: Repository Setup

```
1. Create a Git repository for the markdown content (if it does not exist)
2. Clone/pull the markdown repository locally
3. Clone/pull the data repository locally (source of truth)
```

### Step 2: Branch Management

The service supports three branching strategies based on the `GenerationMethod`:

| Method              | Behavior                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `RECREATE`          | Switches to main branch, deletes all existing item files, regenerates everything |
| `APPEND` / `UPDATE` | Creates or switches to a PR branch, preserving existing content                  |

```typescript
if (generation_method === GenerationMethod.RECREATE) {
	await this.gitFacade.switchBranch(provider, markdownRepo.dir, defaultBranch);
	await markdownRepo.resetFiles();
} else if (canCreatePR) {
	await Promise.all([
		this.gitFacade.switchBranch(provider, markdownRepo.dir, pr_update.branch, true),
		this.gitFacade.switchBranch(provider, dataRepo.dir, pr_update.branch, true)
	]);
}
```

### Step 3: Content Synchronization

The service reads all items from the data repository and:

1. **Copies detail markdown** -- For each item with a `.md` file in the data repo, it writes the content to `details/<slug>.md`.
2. **Groups items by category** -- Items are organized into a `Record<string, ItemData[]>` map.
3. **Populates tags and categories** -- Resolves tag/category references from their respective YAML definition files.
4. **Handles multi-category items** -- Items with multiple categories appear under each one.

### Step 4: README Generation

The `ReadmeBuilder` constructs the README programmatically:

```typescript
const builder = new ReadmeBuilder(header, footer);
if (config.content_table) {
	builder.enableToC();
}
for (const categoryId of sortedCategoryIds) {
	builder.addSubHeader(categoryDetails.name, items.length);
	for (const item of items) {
		builder.addItem(item, { hasDetails: markdowns.has(item.slug) });
	}
}
return builder.build();
```

### Step 5: Commit and Push

After generating the README and detail files:

```
1. git add --all
2. git commit -m "sync README.md"
3. git push
4. If PR mode: create a pull request from the feature branch to main
```

## ReadmeBuilder API

The `ReadmeBuilder` class provides a fluent interface for constructing README files:

| Method                      | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `addHeader(text)`           | Adds a top-level `# Header`                                  |
| `addSubHeader(text, count)` | Adds a `## Section` with optional item count                 |
| `addItem(item, options)`    | Renders an item as a list entry with link, description, tags |
| `enableToC()`               | Enables table of contents generation                         |
| `build()`                   | Assembles the final markdown string                          |

### Item Rendering Format

Each item is rendered as:

```markdown
- [Item Name](https://source.url) - Item description ([Read more](/details/item-slug.md)) `Tag1` `Tag2`
```

The `[Read more]` link is only included if the item has a detail markdown file.

### Table of Contents

When enabled, the ToC is generated using `github-slugger` for GitHub-compatible anchor links:

```markdown
## Table of Contents

- [Category Name (42)](#category-name)
- [Another Category (15)](#another-category)
```

## Category Sorting

Categories are sorted using a multi-level priority system:

1. **Featured items first** -- Categories containing featured items are promoted.
2. **Priority field** -- Categories with explicit `priority` values are sorted numerically.
3. **Featured count** -- Among equally prioritized categories, those with more featured items rank higher.
4. **Alphabetical** -- Final tiebreaker is alphabetical by category name.

Within each category, items are sorted by:

1. Featured status (featured items first)
2. Explicit `order` field (ascending)
3. Alphabetical by name

## Pull Request Integration

When using `APPEND` or `UPDATE` modes with a PR configuration:

```typescript
const pr = await this.gitFacade.createPullRequest({
	owner: directory.getRepoOwner(),
	repo: directory.slug,
	base: defaultBranch,
	head: pr_update.branch,
	title: pr_update.title,
	body: pr_update.body
});
```

The PR metadata (number, URL, branch) is stored in the directory entity for tracking.

## Repository Cleanup

The service provides lifecycle management methods:

- `removeItemDetail(directory, user, slug)` -- Removes a single item's detail file.
- `removeRepository(directory, user)` -- Deletes the entire markdown repository from the Git provider.
- `cleanup(directory)` -- Removes local cloned files.

## Module Dependencies

```
MarkdownGeneratorModule
  +-- DataGeneratorModule (access to DataRepository for reading item data)
  +-- FacadesModule (GitFacadeService for all Git operations)
  +-- DatabaseModule (TypeORM repositories)
  +-- DirectoryOperationsModule (directory entity operations)
```
