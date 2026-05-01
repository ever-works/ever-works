---
id: directory-advanced-prompts
title: 'DirectoryAdvancedPromptsService Deep Dive'
sidebar_label: 'Advanced Prompts'
sidebar_position: 16
---

# DirectoryAdvancedPromptsService Deep Dive

## Overview

The `DirectoryAdvancedPromptsService` manages per-directory custom prompt overrides that are appended to the standard hardcoded prompts during the AI generation pipeline. This allows directory owners to fine-tune how the AI generates, extracts, categorizes, and validates items without modifying the platform's core prompt templates.

## Architecture

The service provides a thin layer over the `DirectoryAdvancedPromptsRepository` with ownership-based access control. During generation, the `ItemsGeneratorService` calls `getPromptsForGeneration()` (no auth required) to load custom prompts that augment the standard pipeline prompts.

```
API Layer (authenticated)                    Generation Pipeline (internal)
        |                                              |
        v                                              v
getAdvancedPrompts(directoryId, userId)    getPromptsForGeneration(directoryId)
updateAdvancedPrompts(directoryId, dto)           |
deleteAdvancedPrompts(directoryId, userId)        v
        |                                  DirectoryAdvancedPrompts entity
        v                                  (appended to standard prompts)
DirectoryAdvancedPromptsRepository
```

## API Reference

### Methods

#### `getAdvancedPrompts(directoryId, userId)`

Retrieves the custom prompts for a directory. Requires at least viewer access.

| Parameter     | Type     | Description              |
| ------------- | -------- | ------------------------ |
| `directoryId` | `string` | The directory ID         |
| `userId`      | `string` | The requesting user's ID |

**Returns:** `Promise<DirectoryAdvancedPromptsResponseDto>`

#### `updateAdvancedPrompts(directoryId, dto, userId)`

Creates or updates the custom prompts. Requires editor access.

| Parameter     | Type                                | Description              |
| ------------- | ----------------------------------- | ------------------------ |
| `directoryId` | `string`                            | The directory ID         |
| `dto`         | `UpdateDirectoryAdvancedPromptsDto` | Prompt fields to set     |
| `userId`      | `string`                            | The requesting user's ID |

**Returns:** `Promise<DirectoryAdvancedPromptsResponseDto>`

#### `getPromptsForGeneration(directoryId)`

Internal method for the generation pipeline. No authentication check -- used by background jobs and internal services.

| Parameter     | Type     | Description      |
| ------------- | -------- | ---------------- |
| `directoryId` | `string` | The directory ID |

**Returns:** `Promise<DirectoryAdvancedPrompts | null>`

#### `deleteAdvancedPrompts(directoryId, userId)`

Deletes all custom prompts for a directory, resetting to platform defaults. Requires editor access.

| Parameter     | Type     | Description              |
| ------------- | -------- | ------------------------ |
| `directoryId` | `string` | The directory ID         |
| `userId`      | `string` | The requesting user's ID |

**Returns:** `Promise<boolean>`

### Prompt Fields

Each prompt field corresponds to a specific stage in the AI generation pipeline:

| Field                 | Pipeline Stage         | Description                                                                               |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `relevanceAssessment` | Item relevance scoring | Custom instructions for evaluating whether a discovered item is relevant to the directory |
| `itemGeneration`      | Item creation          | Custom instructions for how items should be generated (tone, detail level, format)        |
| `itemExtraction`      | Content extraction     | Custom rules for extracting structured data from web pages                                |
| `searchQuery`         | Web search             | Custom instructions for generating search queries to discover new items                   |
| `categorization`      | Category assignment    | Custom rules for assigning items to categories                                            |
| `deduplication`       | Duplicate detection    | Custom criteria for determining when two items are duplicates                             |
| `sourceValidation`    | Source URL validation  | Custom rules for validating whether a source URL is acceptable                            |

## Implementation Details

### Null Semantics

All prompt fields are nullable. A `null` value means "use the standard platform prompt only." A non-null string value is appended to the standard prompt for that pipeline stage. This design allows granular control -- a user might customize only `categorization` while leaving all other stages at defaults.

### Input Sanitization

The DTO layer sanitizes all prompt inputs:

1. Empty or whitespace-only strings are normalized to `null`
2. Non-string values are coerced to `null`
3. Values are trimmed and sanitized via `sanitizePrompt()` (strips control characters)
4. Maximum length is enforced at 2,000 characters per field

### Response Mapping

The `toResponseDto()` method maps the entity to a flat response, using nullish coalescing to convert `undefined` fields to `null` for consistent API responses:

```typescript
relevanceAssessment: prompts?.relevanceAssessment ?? null,
```

### Cascade Deletion

When a directory is deleted, advanced prompts are automatically removed via database cascade. The `deleteAdvancedPrompts` method exists for manual prompt reset.

## Database Interactions

| Repository                           | Method                          | Purpose                      |
| ------------------------------------ | ------------------------------- | ---------------------------- |
| `DirectoryAdvancedPromptsRepository` | `findByDirectoryId`             | Load prompts for a directory |
| `DirectoryAdvancedPromptsRepository` | `createOrUpdate`                | Upsert prompt configuration  |
| `DirectoryAdvancedPromptsRepository` | `delete`                        | Remove prompt configuration  |
| `DirectoryOwnershipService`          | `ensureAccess`, `ensureCanEdit` | Authorization checks         |

## Event System

This service does not emit or consume events.

## Error Handling

| Scenario                 | Behavior                                           |
| ------------------------ | -------------------------------------------------- |
| Directory not found      | `NotFoundException` thrown by ownership service    |
| Insufficient permissions | `ForbiddenException` thrown by ownership service   |
| No prompts configured    | Returns response DTO with all fields set to `null` |
| Prompt text too long     | Rejected at DTO validation layer (max 2,000 chars) |

## Usage Examples

```typescript
// Get current prompts
const prompts = await advancedPromptsService.getAdvancedPrompts(directoryId, userId);

// Set custom categorization rules
await advancedPromptsService.updateAdvancedPrompts(
	directoryId,
	{
		categorization:
			'Always prefer the most specific subcategory. If an item fits multiple categories, choose the one most relevant to developers.',
		searchQuery: 'Focus on open-source projects with active maintenance. Exclude archived repositories.'
	},
	userId
);

// Reset all prompts to defaults
await advancedPromptsService.deleteAdvancedPrompts(directoryId, userId);

// Internal: load prompts during generation (no auth)
const prompts = await advancedPromptsService.getPromptsForGeneration(directoryId);
if (prompts?.categorization) {
	// append to standard categorization prompt
}
```

## Configuration

| Setting             | Value            | Description                                     |
| ------------------- | ---------------- | ----------------------------------------------- |
| `MAX_PROMPT_LENGTH` | 2,000 characters | Maximum length for each individual prompt field |

## Related Services

- [Directory Ownership](/agent-services/directory-ownership-service) -- provides authorization for prompt management
- [Items Generator](/agent-services/items-generator) -- consumes prompts during the AI generation pipeline
- [Directory Generation](/agent-services/directory-generation) -- triggers the pipeline that uses these prompts
