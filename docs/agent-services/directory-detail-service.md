---
id: directory-detail-service
title: "DirectoryDetailService Deep Dive"
sidebar_label: "Directory Detail"
sidebar_position: 11
---

# DirectoryDetailService Deep Dive

## Overview

The `DirectoryDetailService` is responsible for extracting structured metadata from a directory name and user prompt using AI. It generates descriptions, keywords, categories, and unique slugs for new directories, providing the foundational metadata that drives the rest of the directory creation pipeline.

## Architecture

This service sits at the beginning of the directory creation flow. When a user creates a new directory by providing a name and prompt, the `DirectoryDetailService` calls the AI facade to extract semantically meaningful details and then ensures the resulting slug is unique per user. It acts as a pure extraction service with no side effects beyond slug uniqueness checks.

```mermaid
flowchart TD
    A["User Input (name + prompt)"] --> B["DirectoryDetailService.generateDirectoryDetails()"]
    B --> C["AiFacadeService.askJson()"]
    C --> D["AI extracts description,<br/>keywords, categories"]
    B --> E["generateUniqueSlug()"]
    E --> F["DirectoryRepository.existsByUserAndSlug()"]
    D --> G["DirectoryDetails<br/>(name, slug, description,<br/>keywords, categories)"]
    F --> G
```

## API Reference

### Methods

#### `generateDirectoryDetails(name, prompt, user, aiProvider?)`

Extracts directory details from a name and prompt using AI, then generates a unique slug.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | The directory name provided by the user |
| `prompt` | `string` | The user prompt describing the directory's purpose |
| `user` | `User` | The user entity creating the directory |
| `aiProvider` | `string` (optional) | Override for the AI provider to use |

**Returns:** `Promise<DirectoryDetails>`

```typescript
interface DirectoryDetails {
    name: string;
    slug: string;
    description: string;
    keywords: string[];
    categories: string[];
}
```

## Implementation Details

### AI Prompt Design

The service uses a carefully crafted prompt (`DIRECTORY_DETAIL_PROMPT`) that instructs the AI to:

- Generate a clear 1-2 sentence description without filler phrases like "This directory is about..."
- Extract relevant, specific keywords
- Identify high-level category names
- Avoid marketing language in favor of factual descriptions

### Zod Schema Validation

The AI output is validated against `directoryDetailSchema`, a Zod schema ensuring:

- `description` is a string
- `keywords` is an array of strings
- `categories` is a nullable array of strings

### Slug Generation

The `generateUniqueSlug` method ensures no two directories for the same user share a slug:

1. Slugifies the directory name using `slugifyText()`
2. Checks `DirectoryRepository.existsByUserAndSlug()`
3. If a conflict exists, appends incrementing numbers (`-1`, `-2`, etc.) until a unique slug is found

### Output Sanitization

All AI-generated content passes through sanitization utilities (`sanitizeDescription`, `sanitizeStringArray`) to strip newlines and control characters. This is critical for downstream GitHub API compatibility where multiline strings in metadata fields can cause failures.

## Database Interactions

| Repository | Method | Purpose |
|------------|--------|---------|
| `DirectoryRepository` | `existsByUserAndSlug(userId, slug)` | Check for slug conflicts during unique slug generation |

## Event System

This service does not emit or consume any events. It is a stateless extraction service.

## Error Handling

The service implements a **graceful fallback strategy**:

- If the AI extraction call fails for any reason, the service falls back to basic details:
  - Description: `"Directory for {name}"`
  - Keywords: the directory name lowercased
  - Categories: empty array
- All errors are logged with full stack traces via the NestJS `Logger`
- The slug generation still runs normally even in fallback mode

## Usage Examples

```typescript
// Inject the service
constructor(private readonly detailService: DirectoryDetailService) {}

// Extract details for a new directory
const details = await this.detailService.generateDirectoryDetails(
    'AI Developer Tools',
    'A curated collection of AI-powered tools for software developers',
    currentUser,
);

// Result:
// {
//     name: 'AI Developer Tools',
//     slug: 'ai-developer-tools',
//     description: 'AI-powered tools designed for software developers...',
//     keywords: ['ai', 'developer-tools', 'coding', 'automation'],
//     categories: ['Developer Tools', 'Artificial Intelligence'],
// }

// With AI provider override
const details = await this.detailService.generateDirectoryDetails(
    'Best CRMs',
    'Top CRM platforms for small businesses',
    currentUser,
    'anthropic',
);
```

## Configuration

| Setting | Description |
|---------|-------------|
| AI Provider | Configured via `AiFacadeService`; can be overridden per call with the `aiProvider` parameter |
| Temperature | Hardcoded to `0` for deterministic, consistent output |
| Routing Complexity | Set to `'simple'` to use cost-efficient models for this straightforward extraction task |

## Related Services

- [Directory Lifecycle](/agent-services/directory-lifecycle) -- consumes `DirectoryDetails` during directory creation
- [Directory Import Service](/agent-services/directory-import-service) -- alternative path that bypasses detail extraction for imported directories
- [Generator Form Schema](/agent-services/generator-form-schema) -- validates AI provider configuration before generation
