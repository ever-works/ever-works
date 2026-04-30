---
id: directory-taxonomy-service
title: "DirectoryTaxonomyService Deep Dive"
sidebar_label: "Directory Taxonomy"
sidebar_position: 14
---

# DirectoryTaxonomyService Deep Dive

## Overview

The `DirectoryTaxonomyService` manages the full lifecycle of directory taxonomy entities: categories, tags, and collections. It provides CRUD operations that read from and write to the git-backed data repository, enforcing ownership permissions, duplicate detection, and slug-based ID generation for all taxonomy entities.

## Architecture

This service bridges the API layer with the git-backed data storage. Every operation loads the current taxonomy state from the data repository (via `DataGeneratorService`), performs the mutation in memory, then persists the result back to git.

```
API Controller
       |
       v
DirectoryTaxonomyService
       |
       +-- DirectoryOwnershipService.ensureAccess/ensureCanEdit()
       |
       +-- UserRepository.findById()
       |
       +-- DataGeneratorService.getCategoriesTags()  <-- read from git
       |
       +-- [in-memory mutation: create/update/delete]
       |
       +-- DataGeneratorService.saveCategories/saveTags/saveCollections()  --> write to git
       |
       v
Response DTO
```

## API Reference

### Category Methods

#### `getCategories(directoryId, userId)`

Returns all categories for a directory. Requires viewer access.

**Returns:** `Promise<Category[]>`

#### `createCategory(directoryId, dto, userId)`

Creates a new category. Requires editor access. Enforces unique names (case-insensitive).

| Parameter | Type | Description |
|-----------|------|-------------|
| `dto` | `CreateCategoryDto` | `{ name, description?, icon_url?, priority? }` |

**Returns:** `Promise<{ status: string; category: Category }>`

#### `updateCategory(directoryId, categoryId, dto, userId)`

Updates an existing category by ID. Requires editor access.

| Parameter | Type | Description |
|-----------|------|-------------|
| `categoryId` | `string` | The slugified category ID |
| `dto` | `UpdateCategoryDto` | Partial update fields |

**Returns:** `Promise<{ status: string; category: Category }>`

#### `deleteCategory(directoryId, categoryId, userId)`

Removes a category by ID. Requires editor access.

**Returns:** `Promise<{ status: string; message: string }>`

### Tag Methods

#### `getTags(directoryId, userId)`

Returns all tags. Requires viewer access.

**Returns:** `Promise<Tag[]>`

#### `createTag(directoryId, dto, userId)` / `updateTag(...)` / `deleteTag(...)`

Same CRUD pattern as categories. Tags have only `name` as a mutable field.

### Collection Methods

#### `getCollections(directoryId, userId)` / `createCollection(...)` / `updateCollection(...)` / `deleteCollection(...)`

Same CRUD pattern as categories. Collections support `name`, `description`, `icon_url`, and `priority`.

## Implementation Details

### ID Generation

All taxonomy entities use slugified names as their IDs via `slugifyText(name)`. This ensures IDs are URL-friendly and match item references (items reference categories/tags by slugified ID).

### Duplicate Detection

Before creating any entity, the service normalizes the name to lowercase and checks for existing entries with the same normalized name. During updates, it also checks for conflicts while excluding the entity being updated.

### Partial Updates

Update methods use conditional spreading to apply only provided fields:

```typescript
const updatedCategory: Category = {
    ...existingCategory,
    ...(dto.name && { name: dto.name.trim() }),
    ...(dto.description !== undefined && { description: dto.description?.trim() }),
};
```

This pattern allows setting fields to `undefined` (by passing `undefined`) or removing them while preserving unmentioned fields.

### Input Sanitization

All string inputs are trimmed. Names and descriptions pass through the `sanitizeName` and `sanitizeDescription` transform decorators in their respective DTOs before reaching the service.

## Database Interactions

| Repository / Service | Method | Purpose |
|---------------------|--------|---------|
| `DirectoryOwnershipService` | `ensureAccess`, `ensureCanEdit` | Authorization checks |
| `UserRepository` | `findById` | Load the User entity for git operations |
| `DataGeneratorService` | `getCategoriesTags` | Read current taxonomy from git data repo |
| `DataGeneratorService` | `saveCategories`, `saveTags`, `saveCollections` | Write updated taxonomy to git data repo |

## Event System

This service does not directly emit events. Changes to taxonomy are persisted through `DataGeneratorService`, which handles git commits.

## Error Handling

| Scenario | Exception | HTTP Status |
|----------|-----------|-------------|
| User not found | `NotFoundException` | 404 |
| Duplicate name on create | `BadRequestException` | 400 |
| Duplicate name on update | `BadRequestException` | 400 |
| Entity not found on update/delete | `NotFoundException` | 404 |
| Insufficient permissions | `ForbiddenException` (via ownership service) | 403 |

## Usage Examples

```typescript
// List all categories
const categories = await taxonomyService.getCategories(directoryId, userId);

// Create a new category
const result = await taxonomyService.createCategory(
    directoryId,
    { name: 'Machine Learning', description: 'ML tools and frameworks', priority: 1 },
    userId,
);
// result.category.id === 'machine-learning'

// Create a tag
const tagResult = await taxonomyService.createTag(
    directoryId,
    { name: 'Open Source' },
    userId,
);
// tagResult.tag.id === 'open-source'

// Update a category
await taxonomyService.updateCategory(
    directoryId,
    'machine-learning',
    { description: 'Updated description for ML tools' },
    userId,
);

// Delete a tag
await taxonomyService.deleteTag(directoryId, 'deprecated-tag', userId);
```

## Configuration

No external configuration is required. Taxonomy entity constraints (max lengths, allowed characters) are enforced at the DTO validation layer.

## Related Services

- [Directory Ownership](/agent-services/directory-ownership-service) -- provides authorization for all taxonomy operations
- [Directory Generation](/agent-services/directory-generation) -- uses taxonomy during content generation
- [Import System](/agent-services/import-system) -- creates initial taxonomy during directory imports
