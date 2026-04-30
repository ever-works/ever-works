---
id: taxonomy-system
title: Taxonomy System
sidebar_label: Taxonomy System
sidebar_position: 10
---

# Taxonomy System

The taxonomy system manages the organizational structure of directory items through three entity types: **categories**, **tags**, and **collections**. These are stored in the data repository as YAML files and managed through the `DirectoryTaxonomyService`.

## Overview

Every directory can organize its items using:

| Entity          | Purpose                        | Example                                  |
| --------------- | ------------------------------ | ---------------------------------------- |
| **Categories**  | Primary classification buckets | "Frontend Frameworks", "DevOps Tools"    |
| **Tags**        | Cross-cutting labels           | "open-source", "typescript", "free-tier" |
| **Collections** | Curated item groupings         | "Editor's Picks", "Getting Started"      |

Categories and tags are the primary taxonomy mechanisms used during AI generation. Collections provide an additional manual curation layer.

## Architecture

The taxonomy service is located at `packages/agent/src/services/directory-taxonomy.service.ts` and depends on:

- **`DataGeneratorService`** -- reads and writes taxonomy data to the Git data repository.
- **`DirectoryOwnershipService`** -- enforces access control (viewer for reads, editor for writes).
- **`UserRepository`** -- resolves user entities for Git commit authorship.

## Categories

Categories are the primary organizational axis. Each item belongs to exactly one category.

### Data Model

```typescript
interface Category {
	id: string; // URL-friendly slug (e.g., "frontend-frameworks")
	name: string; // Display name (e.g., "Frontend Frameworks")
	description?: string; // Optional description
	icon_url?: string; // Optional category icon URL
	priority?: number; // Optional sort priority
}
```

### CRUD Operations

#### List Categories

```typescript
async getCategories(directoryId: string, userId: string): Promise<Category[]>
```

Reads categories from the data repository. Requires viewer access.

#### Create Category

```typescript
async createCategory(directoryId: string, dto: CreateCategoryDto, userId: string)
```

1. Validates that no duplicate name exists (case-insensitive comparison).
2. Auto-generates the `id` by slugifying the name (e.g., "My Category" becomes "my-category").
3. Appends the new category to the existing list.
4. Saves all categories back to the data repository.

Requires editor access.

#### Update Category

```typescript
async updateCategory(directoryId: string, categoryId: string, dto: UpdateCategoryDto, userId: string)
```

Updates name, description, icon URL, or priority. Validates uniqueness if the name is being changed. Requires editor access.

#### Delete Category

```typescript
async deleteCategory(directoryId: string, categoryId: string, userId: string)
```

Removes the category from the list. Note: items referencing this category are not automatically reassigned. Requires editor access.

## Tags

Tags provide a flexible labeling system. Each item can have zero or more tags.

### Data Model

```typescript
interface Tag {
	id: string; // URL-friendly slug (e.g., "open-source")
	name: string; // Display name (e.g., "Open Source")
}
```

### CRUD Operations

#### List Tags

```typescript
async getTags(directoryId: string, userId: string): Promise<Tag[]>
```

#### Create Tag

```typescript
async createTag(directoryId: string, dto: CreateTagDto, userId: string)
```

Validates name uniqueness (case-insensitive) and auto-generates the slug ID.

#### Update Tag

```typescript
async updateTag(directoryId: string, tagId: string, dto: UpdateTagDto, userId: string)
```

#### Delete Tag

```typescript
async deleteTag(directoryId: string, tagId: string, userId: string)
```

## Collections

Collections are curated groups of items, independent of the category/tag taxonomy. They enable editorial groupings like "Best of 2025" or "Getting Started Essentials".

### Data Model

```typescript
interface Collection {
	id: string; // URL-friendly slug
	name: string; // Display name
	description?: string; // Optional description
	icon_url?: string; // Optional collection icon
	priority?: number; // Sort priority
}
```

### CRUD Operations

Collections follow the same CRUD pattern as categories:

```typescript
async getCollections(directoryId: string, userId: string): Promise<Collection[]>
async createCollection(directoryId: string, dto: CreateCollectionDto, userId: string)
async updateCollection(directoryId: string, collectionId: string, dto: UpdateCollectionDto, userId: string)
async deleteCollection(directoryId: string, collectionId: string, userId: string)
```

All operations include duplicate name validation and auto-generated slug IDs.

## Storage Format

Taxonomy data is stored in the data repository as YAML files:

```
{directory-slug}-data/
  categories.yml        # Array of category objects
  tags.yml              # Array of tag objects
  collections.yml       # Array of collection objects
  config.yml            # Directory configuration
  data/
    item-slug/
      item.yml          # References category and tags by ID
```

### categories.yml Example

```yaml
- id: frontend-frameworks
  name: Frontend Frameworks
  description: JavaScript frameworks for building user interfaces
  priority: 1

- id: devops-tools
  name: DevOps Tools
  description: Tools for deployment, CI/CD, and infrastructure
  priority: 2
```

### Item Reference

Items reference categories and tags by their slug IDs:

```yaml
# data/react/item.yml
name: React
slug: react
category: frontend-frameworks
tags:
    - open-source
    - typescript
    - meta
```

## Slug Generation

All taxonomy entity IDs are auto-generated using `slugifyText()`:

```typescript
const newCategory: Category = {
	id: slugifyText(dto.name.trim()), // "My Category" -> "my-category"
	name: dto.name.trim()
};
```

This ensures IDs are URL-friendly and consistent with item references.

## Access Control

| Operation                            | Required Role |
| ------------------------------------ | ------------- |
| List (categories, tags, collections) | Viewer        |
| Create                               | Editor        |
| Update                               | Editor        |
| Delete                               | Editor        |

Access is checked via `DirectoryOwnershipService`:

- `ensureAccess(directoryId, userId)` for read operations.
- `ensureCanEdit(directoryId, userId)` for write operations.

## AI Integration

During AI-powered generation, the pipeline:

1. Loads existing categories via the taxonomy service.
2. Passes category names to the AI as context for item categorization.
3. Uses the advanced prompts `categorization` field (if set) to guide category assignment.
4. New categories may be suggested by the AI and created through the taxonomy service.

Tags are typically extracted by the AI from item descriptions and source content. The deduplication phase normalizes and merges tag values across items.
