---
id: agent-taxonomy-module
title: Taxonomy Module
sidebar_label: Taxonomy
sidebar_position: 24
---

# Taxonomy Module

## Overview

The Taxonomy module in `@ever-works/agent` manages the classification and organizational structures within a directory -- categories, tags, and collections. These taxonomy elements are stored as YAML files in the data repository and provide the organizational backbone for directory items.

Categories represent hierarchical groupings, tags provide flat labeling, and collections offer curated item groupings. The taxonomy service handles full CRUD operations with slug generation, duplicate detection, and persistence through the data generator layer.

## Module Structure

```
packages/agent/src/
  services/
    directory-taxonomy.service.ts    # Full CRUD for categories, tags, collections
  generators/
    data-generator/
      data-repository.ts             # File I/O for taxonomy YAML files
      data-generator.service.ts      # Persistence layer (saveCategories, saveTags, etc.)
  entities/
    types.ts                         # Shared type definitions
```

Taxonomy types are defined in `@ever-works/contracts`:

```
packages/contracts/src/
  types/
    category.ts                      # Category interface
    tag.ts                           # Tag interface
    collection.ts                    # Collection interface
```

## Key Classes and Services

### `DirectoryTaxonomyService`

The primary service managing all taxonomy operations. It coordinates between the data repository (for reading current state) and the data generator service (for persisting changes).

**Category operations:**

- **`getCategories(directory, user)`** -- retrieve all categories from the data repository
- **`createCategory(directory, user, data)`** -- create a new category with auto-generated slug, duplicate name detection
- **`updateCategory(directory, user, categoryId, data)`** -- update category name/description with rename conflict checking
- **`deleteCategory(directory, user, categoryId)`** -- remove a category from the taxonomy

**Tag operations:**

- **`getTags(directory, user)`** -- retrieve all tags
- **`createTag(directory, user, data)`** -- create a new tag with slug generation
- **`updateTag(directory, user, tagId, data)`** -- update tag properties
- **`deleteTag(directory, user, tagId)`** -- remove a tag

**Collection operations:**

- **`getCollections(directory, user)`** -- retrieve all collections
- **`createCollection(directory, user, data)`** -- create a new collection
- **`updateCollection(directory, user, collectionId, data)`** -- update collection properties
- **`deleteCollection(directory, user, collectionId)`** -- remove a collection

**Slug generation:**

All taxonomy elements use `slugifyText()` from `@ever-works/agent/utils` to generate URL-safe identifiers from names. The function handles unicode normalization, special character removal, and whitespace-to-hyphen conversion.

**Duplicate detection:**

On both create and update operations, the service checks for existing elements with the same name (case-insensitive comparison). If a duplicate is found, an error is thrown before any persistence occurs.

### `DataRepository` (Taxonomy Methods)

The `DataRepository` class provides file-level I/O for taxonomy data stored in the Git-backed data repository:

- `getCategories()` -- reads `categories.yml` from the repository root
- `getTags()` -- reads `tags.yml` from the repository root
- `getCollections()` -- reads `collections.yml` from the repository root

### `DataGeneratorService` (Persistence)

The `DataGeneratorService` provides the persistence layer that writes taxonomy changes back to the data repository and commits them via Git:

- `saveCategories(directory, user, categories)` -- writes `categories.yml` and commits
- `saveTags(directory, user, tags)` -- writes `tags.yml` and commits
- `saveCollections(directory, user, collections)` -- writes `collections.yml` and commits

## API Reference

### DirectoryTaxonomyService

```typescript
// Categories
getCategories(directory: Directory, user: User): Promise<Category[]>
createCategory(directory: Directory, user: User, data: CreateCategoryDto): Promise<Category>
updateCategory(directory: Directory, user: User, categoryId: string, data: UpdateCategoryDto): Promise<Category>
deleteCategory(directory: Directory, user: User, categoryId: string): Promise<void>

// Tags
getTags(directory: Directory, user: User): Promise<Tag[]>
createTag(directory: Directory, user: User, data: CreateTagDto): Promise<Tag>
updateTag(directory: Directory, user: User, tagId: string, data: UpdateTagDto): Promise<Tag>
deleteTag(directory: Directory, user: User, tagId: string): Promise<void>

// Collections
getCollections(directory: Directory, user: User): Promise<Collection[]>
createCollection(directory: Directory, user: User, data: CreateCollectionDto): Promise<Collection>
updateCollection(directory: Directory, user: User, collectionId: string, data: UpdateCollectionDto): Promise<Collection>
deleteCollection(directory: Directory, user: User, collectionId: string): Promise<void>
```

## Configuration

### Category Interface

```typescript
interface Category {
    id: string;           // Auto-generated slug from name
    name: string;         // Display name
    description?: string; // Optional description
    icon?: string;        // Optional icon identifier
    order?: number;       // Sort order
}
```

### Tag Interface

```typescript
interface Tag {
    id: string;           // Auto-generated slug from name
    name: string;         // Display name
    description?: string;
}
```

### Collection Interface

```typescript
interface Collection {
    id: string;
    name: string;
    description?: string;
    items: string[];      // Array of item slugs
}
```

### Data Repository Format

Taxonomy data is stored as YAML files in the data repository root:

```yaml
# categories.yml
- id: developer-tools
  name: Developer Tools
  description: Tools for software development
  order: 1

- id: ai-platforms
  name: AI Platforms
  description: AI and machine learning platforms
  order: 2
```

```yaml
# tags.yml
- id: open-source
  name: Open Source

- id: freemium
  name: Freemium
```

## Dependencies

| Dependency | Purpose |
|---|---|
| `@ever-works/contracts` | `Category`, `Tag`, `Collection` type definitions |
| `@ever-works/agent/generators` | `DataGeneratorService` for Git-backed persistence |
| `@ever-works/agent/utils` | `slugifyText` for ID generation |
| `@ever-works/agent/facades` | `GitFacadeService` (via DataGeneratorService) for repository operations |

## Usage Examples

### Managing Categories

```typescript
import { DirectoryTaxonomyService } from '@ever-works/agent/services';

// Create a category
const category = await taxonomyService.createCategory(directory, user, {
    name: 'Developer Tools',
    description: 'Tools for software developers',
});
// category.id === 'developer-tools' (auto-generated slug)

// List all categories
const categories = await taxonomyService.getCategories(directory, user);

// Update a category
await taxonomyService.updateCategory(directory, user, 'developer-tools', {
    name: 'Dev Tools',
    description: 'Updated description',
});

// Delete a category
await taxonomyService.deleteCategory(directory, user, 'developer-tools');
```

### Managing Tags

```typescript
const tag = await taxonomyService.createTag(directory, user, {
    name: 'Open Source',
});
// tag.id === 'open-source'

const tags = await taxonomyService.getTags(directory, user);
```

### Managing Collections

```typescript
const collection = await taxonomyService.createCollection(directory, user, {
    name: 'Top Picks',
    description: 'Our recommended tools',
    items: ['vscode', 'github-copilot', 'cursor'],
});
```
