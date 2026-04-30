---
id: items-generator
title: Items Generator Module
sidebar_label: Items Generator
sidebar_position: 5
---

# Items Generator Module

The Items Generator module handles individual item operations within a directory -- submitting new items, removing existing items, and updating item metadata. It operates directly on the data Git repository using branch-based workflows with optional pull request creation.

**Sources:**

- `packages/agent/src/items-generator/items-generator.module.ts`
- `packages/agent/src/items-generator/item-submission.service.ts`
- `packages/agent/src/items-generator/dto/`
- `packages/agent/src/items-generator/schemas/item-extraction.schemas.ts`

## Module Structure

```
items-generator/
    dto/
        create-items-generator.dto.ts    # Generation trigger DTOs
        submit-item.dto.ts               # Single item submission
        submit-item-response.dto.ts      # Submission response
        remove-item.dto.ts               # Item removal request
        remove-item-response.dto.ts      # Removal response
        update-item.dto.ts               # Metadata update
        extract-item-details.dto.ts      # Detail extraction request
        extract-item-details-response.dto.ts
        items-generator-response.dto.ts  # Generation response
        delete-items-generator.dto.ts    # Directory deletion
        index.ts                         # Barrel export
    schemas/
        item-extraction.schemas.ts       # Zod schemas for AI extraction
    item-submission.service.ts           # Core submission logic
    items-generator.module.ts            # NestJS module definition
    index.ts                             # Public API
```

## NestJS Module

```typescript
@Module({
	imports: [DatabaseModule, FacadesModule, PipelineModule],
	providers: [ItemSubmissionService],
	exports: [ItemSubmissionService]
})
export class ItemsGeneratorModule {}
```

The module is intentionally lightweight. Bulk generation is handled by the `PipelineOrchestratorService`; this module focuses on single-item operations.

## ItemSubmissionService

### Submit Item

The `submitItem` method adds a new item to a directory's data repository:

```typescript
const result = await submissionService.submitItem(directory, user, {
	name: 'VS Code',
	description: 'A popular code editor by Microsoft',
	source_url: 'https://code.visualstudio.com',
	category: 'Editors',
	tags: ['ide', 'microsoft', 'open-source']
});
```

#### Workflow

1. **Clone/pull** the data repository using the directory owner's credentials.
2. **Read config** to check autoapproval settings.
3. **Determine commit strategy:**

| Condition                      | Strategy                    |
| ------------------------------ | --------------------------- |
| `create_pull_request === true` | Always create a PR (forced) |
| `pay_and_publish_now === true` | Direct commit to main       |
| `config.autoapproval === true` | Direct commit to main       |
| Default                        | Create a PR                 |

4. **Branch management:**
    - For PRs: Create a new branch named `item-{slugified-name}-{timestamp}`.
    - For direct commits: Switch to the main branch.

5. **Prepare item data** with the `MutableItemData` structure.
6. **Capture screenshot** if the item has a `source_url` and the screenshot service is available.
7. **Write files** to the data repository: item JSON and item markdown.
8. **Commit and push** using the current user as the committer (for Git attribution).
9. **Create PR** (if applicable) with a descriptive title and body including badge information.

#### Response Types

```typescript
// Direct commit response
{
    status: 'success',
    slug: 'my-directory',
    item_name: 'VS Code',
    item_slug: 'vs-code',
    direct_commit: true,
    item: { /* full item data */ },
}

// PR creation response
{
    status: 'success',
    slug: 'my-directory',
    item_name: 'VS Code',
    item_slug: 'vs-code',
    pr_number: 42,
    pr_url: 'https://github.com/...',
    pr_branch_name: 'item-vs-code-1234567890',
    auto_merged: false,
    item: { /* full item data */ },
}
```

### Remove Item

The `removeItem` method removes an item from the data repository:

```typescript
const result = await submissionService.removeItem(directory, user, {
	item_slug: 'vs-code',
	reason: 'No longer maintained',
	create_pull_request: true
});
```

#### Workflow

1. Clone/pull the data repository.
2. Verify the item exists via `data.itemExists()`.
3. Read item details for the response.
4. Create a branch (if PR requested) or switch to main.
5. Remove the item directory via `data.removeItem()`.
6. Commit with an optional reason in the message.
7. Push and optionally create a PR.

### Update Item Metadata

The `updateItem` method modifies metadata fields on an existing item:

```typescript
const result = await submissionService.updateItem(directory, user, {
	item_slug: 'vs-code',
	featured: true,
	order: 1,
	create_pull_request: false
});
```

Supports updating `featured` status and `order` position. Uses the same branch/PR strategy as other operations.

## DTOs

### SubmitItemDto

| Field                 | Type       | Required    | Description                                         |
| --------------------- | ---------- | ----------- | --------------------------------------------------- |
| `name`                | `string`   | Yes         | Item display name                                   |
| `description`         | `string`   | Yes         | Item description                                    |
| `source_url`          | `string`   | Yes         | Canonical URL (must be HTTP/HTTPS)                  |
| `category`            | `string`   | Conditional | Single category (required if `categories` is empty) |
| `categories`          | `string[]` | Conditional | Category array (required if `category` is empty)    |
| `tags`                | `string[]` | No          | Keywords and labels                                 |
| `featured`            | `boolean`  | No          | Featured flag (default: false)                      |
| `order`               | `number`   | No          | Sort order (min: 0)                                 |
| `slug`                | `string`   | No          | URL-friendly identifier (auto-generated from name)  |
| `brand`               | `string`   | No          | Brand/manufacturer name                             |
| `brand_logo_url`      | `string`   | No          | Brand logo URL                                      |
| `images`              | `string[]` | No          | Image URLs                                          |
| `pay_and_publish_now` | `boolean`  | No          | Skip PR, commit directly                            |
| `create_pull_request` | `boolean`  | No          | Force PR creation                                   |

### RemoveItemDto

| Field                 | Type      | Required | Description                                     |
| --------------------- | --------- | -------- | ----------------------------------------------- |
| `item_slug`           | `string`  | Yes      | Slug of the item to remove                      |
| `reason`              | `string`  | No       | Reason for removal (included in commit message) |
| `create_pull_request` | `boolean` | No       | Whether to create a PR                          |

### CreateItemsGeneratorDto

| Field                                | Type                              | Required | Description                               |
| ------------------------------------ | --------------------------------- | -------- | ----------------------------------------- |
| `name`                               | `string`                          | Yes      | Directory/generation name (max 200 chars) |
| `prompt`                             | `string`                          | Yes      | AI generation prompt (max 5000 chars)     |
| `generation_method`                  | `GenerationMethod`                | No       | `CREATE_UPDATE` (default) or `RECREATE`   |
| `update_with_pull_request`           | `boolean`                         | No       | Create PRs for updates (default: true)    |
| `website_repository_creation_method` | `WebsiteRepositoryCreationMethod` | No       | Template-based creation (default)         |
| `providers`                          | `ProvidersDto`                    | No       | Plugin selection for AI, search, etc.     |
| `pluginConfig`                       | `Record<string, unknown>`         | No       | Plugin-specific form configuration        |

## Zod Schemas for AI Extraction

The `item-extraction.schemas.ts` file defines Zod schemas used by the AI pipeline to validate extracted item data:

### Core Schemas

| Schema                                | Fields                                                                 | Purpose                           |
| ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `itemDataSchema`                      | name, description, source_url, featured, brand, brand_logo_url, images | Base item data from extraction    |
| `itemDataWithCategoriesAndTagsSchema` | Extends `itemDataSchema` + slug, category, tags                        | Full item with taxonomy           |
| `itemDataWithBadgesSchema`            | Extends base + badges (security, license, quality)                     | Items with quality badges         |
| `extractedItemsSchema`                | `{ items: itemDataSchema[] }`                                          | Batch extraction result           |
| `promptUnderstandingAssessmentSchema` | can_proceed, reason_if_cannot_proceed, suggested_clarifications        | Validates AI prompt understanding |

### Badge Schema

```typescript
const badgeSchema = z.object({
	value: z.string(),
	evaluated_at: z.string().nullable(),
	details: z.string().nullable()
});

const itemBadgesSchema = z.record(badgeSchema.nullable());
```

Badges provide quality indicators (security score, license type, code quality) that are displayed on the generated website.
