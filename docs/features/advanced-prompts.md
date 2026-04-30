---
id: advanced-prompts
title: Advanced Prompts
sidebar_label: Advanced Prompts
sidebar_position: 8
---

# Advanced Prompts

Advanced prompts let you customize the AI's behavior for specific pipeline steps on a per-directory basis. Each prompt is appended to the system's default prompt for that step, giving you additional control without replacing the base behavior.

## Available Prompt Fields

| Field | Pipeline Step | Description |
|-------|--------------|-------------|
| `relevanceAssessment` | Relevance check | Custom criteria for deciding if a discovered item belongs in the directory |
| `itemGeneration` | Content generation | Additional instructions for generating item descriptions and content |
| `itemExtraction` | Content extraction | Guidelines for extracting structured data from web pages |
| `searchQuery` | Search queries | Custom instructions for how search queries are constructed |
| `categorization` | Categorization | Rules for assigning categories and tags to items |
| `deduplication` | Deduplication | Custom logic for identifying and merging duplicate items |
| `sourceValidation` | Source validation | Criteria for validating whether a source URL is acceptable |

:::info
All prompt fields are optional. Set a field to `null` or omit it to use only the system's default prompt for that step. Maximum length: 2,000 characters per field.
:::

## API

All endpoints require JWT authentication.

### Get Advanced Prompts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/directories/:id/advanced-prompts` | Get current prompt overrides |

```bash
curl http://localhost:3100/api/directories/:id/advanced-prompts \
  -H "Authorization: Bearer <token>"
```

Response:

```json
{
  "directoryId": "uuid",
  "relevanceAssessment": "Only include tools that are actively maintained and have >100 GitHub stars",
  "itemGeneration": null,
  "itemExtraction": null,
  "searchQuery": "Focus on developer tools and SaaS platforms",
  "categorization": null,
  "deduplication": null,
  "sourceValidation": null,
  "updatedAt": "2025-01-15T10:30:00Z"
}
```

### Update Advanced Prompts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `PUT` | `/api/directories/:id/advanced-prompts` | Set prompt overrides |

```bash
curl -X PUT http://localhost:3100/api/directories/:id/advanced-prompts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "relevanceAssessment": "Only include tools that are actively maintained and have >100 GitHub stars",
    "searchQuery": "Focus on developer tools and SaaS platforms"
  }'
```

Fields not included in the request body are not modified. Set a field to `null` to clear it.

## Tips

- Keep prompts concise and directive — the AI performs best with clear, specific instructions.
- Focus on what makes your directory unique (e.g., inclusion criteria, preferred sources, categorization rules).
- Test with a small generation run before enabling [Scheduled Updates](./scheduled-updates).
- For comparison-specific prompt customization, use the `custom_prompt` setting in the [Comparison Generator](/plugin-system/built-in-plugins#comparison-generator) plugin settings instead.

## Related

- [AI & Generation](/ai-agents/) — pipeline steps overview
- [Comparisons](./comparisons) — comparison-specific custom prompt
- [Scheduled Updates](./scheduled-updates) — prompts are used on every scheduled run

# Advanced Prompts System

The advanced prompts system allows directory owners to customize the AI behavior for their specific directory by providing additional instructions that are appended to the platform's standard prompts during generation.

## Overview

Every AI operation in the generation pipeline uses a hardcoded base prompt optimized for the general case. The advanced prompts system lets users add supplementary instructions per directory without modifying the core prompts. These custom instructions are appended as "Additional User Instructions" to the base prompt.

## Architecture

The system is implemented across several layers:

| File | Purpose |
|---|---|
| `entities/directory-advanced-prompts.entity.ts` | TypeORM entity with nullable text columns per prompt type |
| `database/repositories/directory-advanced-prompts.repository.ts` | CRUD operations for the entity |
| `services/directory-advanced-prompts.service.ts` | Business logic with access control |
| `dto/directory-advanced-prompts.dto.ts` | Request/response DTOs |
| `utils/prompt.util.ts` | Utility for appending custom prompts to base prompts |

## Prompt Types

The system supports seven customizable prompt areas, each corresponding to a specific phase of the generation pipeline:

### Relevance Assessment

```
Column: relevanceAssessment
```

Controls which web pages the AI considers relevant to the directory topic. Useful for narrowing or broadening the scope of discovered sources.

**Example**: "Focus only on open-source tools. Ignore paid SaaS products unless they have a free tier."

### Item Generation

```
Column: itemGeneration
```

Affects AI-generated items during initial directory creation or expansion. Controls what kinds of items the AI proposes.

**Example**: "Each item should be a specific library or framework, not a general concept or methodology."

### Item Extraction

```
Column: itemExtraction
```

Controls how items are identified and what metadata is extracted from web pages during the content extraction phase.

**Example**: "Always extract the programming language and license type as tags."

### Search Query

```
Column: searchQuery
```

Affects what search queries the AI generates when looking for sources to populate the directory.

**Example**: "Include queries for GitHub repositories and NPM packages, not just blog posts."

### Categorization

```
Column: categorization
```

Controls how items are organized into categories and tagged. Useful for enforcing a specific taxonomy structure.

**Example**: "Use the following categories only: Frontend, Backend, DevOps, Testing, Documentation. Do not create new categories."

### Deduplication

```
Column: deduplication
```

Affects how duplicate items are identified and merged. Useful when the default similarity threshold is too aggressive or too lenient.

**Example**: "Consider items with different major versions as separate entries (e.g., Angular vs AngularJS)."

### Source Validation

```
Column: sourceValidation
```

Controls which URLs are accepted as official sources for items. Useful for directories with strict sourcing requirements.

**Example**: "Only accept GitHub repository URLs or official documentation sites. Reject blog posts and tutorials as source URLs."

## Entity Structure

The `DirectoryAdvancedPrompts` entity uses a one-to-one relationship with the `Directory` entity:

```typescript
@Entity({ name: 'directory_advanced_prompts' })
export class DirectoryAdvancedPrompts {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    directoryId: string;

    @OneToOne(() => Directory, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'directoryId' })
    directory: Directory;

    @Column({ type: 'text', nullable: true })
    relevanceAssessment?: string | null;

    @Column({ type: 'text', nullable: true })
    itemGeneration?: string | null;

    // ... other prompt columns (all nullable text)

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
```

All prompt columns are nullable. A `null` value means the standard prompt is used without modification.

## Service API

### Get Prompts

```typescript
async getAdvancedPrompts(directoryId: string, userId: string): Promise<DirectoryAdvancedPromptsResponseDto>
```

Returns the current prompts for a directory. Requires at least viewer access.

### Update Prompts

```typescript
async updateAdvancedPrompts(
    directoryId: string,
    dto: UpdateDirectoryAdvancedPromptsDto,
    userId: string
): Promise<DirectoryAdvancedPromptsResponseDto>
```

Creates or updates prompts for a directory. Requires editor role. Uses `createOrUpdate` to upsert -- creating a new record if none exists, or updating the existing one.

### Get Prompts for Generation (Internal)

```typescript
async getPromptsForGeneration(directoryId: string): Promise<DirectoryAdvancedPrompts | null>
```

Internal method used by the `ItemsGeneratorService` during generation. No access control -- called within the trusted generation pipeline context.

### Delete Prompts

```typescript
async deleteAdvancedPrompts(directoryId: string, userId: string): Promise<boolean>
```

Removes all custom prompts for a directory, reverting to standard behavior. Requires editor role.

## Access Control

The service uses `DirectoryOwnershipService` for access checks:

- **`ensureAccess(directoryId, userId)`** -- minimum viewer role to read prompts.
- **`ensureCanEdit(directoryId, userId)`** -- editor role required to modify prompts.

This integrates with the directory membership system, so team members with appropriate roles can customize prompts.

## Integration with Generation Pipeline

During generation, the `ItemsGeneratorService` loads custom prompts and appends them to each base prompt. The pattern uses the `prompt.util.ts` utility:

```typescript
const customPrompts = await advancedPromptsService.getPromptsForGeneration(directoryId);

const effectivePrompt = appendCustomPrompt(
    BASE_RELEVANCE_PROMPT,
    customPrompts?.relevanceAssessment
);
```

The `appendCustomPrompt` function:

1. Returns the base prompt unchanged if the custom prompt is `null` or empty.
2. Appends the custom text under a clear separator:

```
{base prompt content}

---
Additional User Instructions:
{custom prompt content}
```

## Response DTO

The response DTO returns all prompt values along with metadata:

```typescript
interface DirectoryAdvancedPromptsResponseDto {
    directoryId: string;
    relevanceAssessment: string | null;
    itemGeneration: string | null;
    itemExtraction: string | null;
    searchQuery: string | null;
    categorization: string | null;
    deduplication: string | null;
    sourceValidation: string | null;
    updatedAt: string | null;
}
```

