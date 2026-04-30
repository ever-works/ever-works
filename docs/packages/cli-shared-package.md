---
id: cli-shared-package
title: CLI Shared Package
sidebar_label: CLI Shared Package
sidebar_position: 3
---

# CLI Shared Package

The `@ever-works/cli-shared` package provides shared utilities for both the public CLI (`apps/cli/`) and the internal CLI (`apps/internal-cli/`). It includes interactive prompt services built on Inquirer.js, input validation functions, slug generation utilities, and generation step tracking helpers.

## Package Overview

| Property | Value |
|---|---|
| **Package name** | `@ever-works/cli-shared` |
| **Location** | `platform/packages/cli-shared/` |
| **Dependencies** | inquirer, chalk |
| **Exports** | Prompt services, validation utilities, slug utilities, generator steps |

## Module Exports

```typescript
// Prompt services
export * from './prompts/base-prompt.service';
export * from './prompts/directory-prompt.service';

// Utilities
export * from './utils/config-check';
export * from './utils/slug-utils';
export * from './utils/validation-utils';
export * from './utils/generator-steps';
```

## BasePromptService

An abstract class providing reusable interactive prompt methods with chalk-styled output. All CLI prompt services extend this base class.

### Display Methods

| Method | Output Style |
|---|---|
| `displaySectionHeader(title)` | Cyan bold header |
| `displayInfo(message)` | Blue info icon |
| `displaySuccess(message)` | Green check mark |
| `displayWarning(message)` | Yellow warning icon |
| `displayError(message)` | Red X mark |

### Input Prompt Methods

| Method | Returns | Description |
|---|---|---|
| `promptRequiredText(message, default?, validator?)` | `string` | Required text input |
| `promptOptionalText(message, default?, validator?)` | `string \| undefined` | Optional text input |
| `promptPassword(message, validator?)` | `string` | Masked password input |
| `promptPasswordRequired(message, required?, default?)` | `string` | Password with optional requirement |
| `promptSelect<T>(message, choices, default?)` | `T` | Single selection list |
| `promptMultiSelect<T>(message, choices)` | `T[]` | Multiple selection checkboxes |
| `promptConfirm(message, default?)` | `boolean` | Yes/no confirmation |
| `promptNumber(message, default?, validator?)` | `number` | Number input |
| `promptNumberMinMax(message, default?, min?, max?)` | `number` | Number with range bounds |
| `promptFloat(message, default, min, max)` | `number` | Decimal number with range |

### Built-in Validators

| Validator | Rules |
|---|---|
| `validateUrl(url)` | Validates using `new URL()` constructor |
| `validateEmail(email)` | Regex pattern: `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `validateGitUsername(username)` | 1-39 chars, alphanumeric + hyphens |
| `validateApiKey(apiKey)` | 10-200 characters |
| `validateApiKeyWithProvider(apiKey, provider)` | Min 5 chars, no spaces |
| `validateModelName(modelName)` | 2-100 chars, `[a-zA-Z0-9\-_.\/]+` |
| `validateSlug(slug)` | 2-50 chars, lowercase + numbers + hyphens |
| `validateTemperature(temp)` | Range 0.0-2.0 |
| `validateMaxTokens(tokens)` | Integer range 1-200,000 |
| `validateGitName(name)` | 2-100 chars, letters + spaces + punctuation |

## DirectoryPromptService

Extends `BasePromptService` with directory-specific interactive prompts for creating, selecting, and configuring directories.

### Key Interfaces

```typescript
interface DirectoryInputData {
    slug: string;
    name: string;
    description: string;
    owner?: string;
}

interface SlugConflictResolution {
    action: 'use_suggested' | 'modify' | 'cancel';
    finalSlug?: string;
}

enum DirectoryMemberRole {
    OWNER = 'owner',
    MANAGER = 'manager',
    EDITOR = 'editor',
    VIEWER = 'viewer',
}
```

### Prompt Methods

| Method | Description |
|---|---|
| `promptDirectoryCreation(ownerDefault?, orgs?)` | Full directory creation wizard (name, slug, description, owner) |
| `promptSlugConflictResolution(original, suggested)` | Handles slug conflicts with 3 options |
| `promptDirectorySelection(directories?)` | Interactive directory picker with role labels |
| `promptGitProviderSelection(providers)` | Git provider selection with connection status |
| `promptDeployProviderSelection(providers)` | Deploy provider selection with "None" option |

### Directory Creation Flow

The `promptDirectoryCreation` method guides users through a multi-step wizard:

1. Prompts for a display name (2-100 characters)
2. Auto-generates a slug from the name via `slugifyName()`
3. Asks user to confirm or edit the slug
4. Prompts for a description (10-500 characters)
5. If organizations are available, prompts for repository owner

## Slug Utilities

Functions in `utils/slug-utils.ts` for URL-friendly slug operations:

```typescript
// Generate a slug from text
slugify('My Cool Directory') // => 'my-cool-directory'

// Validate slug format
validateSlug('my-dir')       // => true
validateSlug('MY-DIR')       // => 'Slug can only contain lowercase...'
validateSlug('a')            // => 'Slug must be at least 2 characters...'

// Generate incremented slug for conflicts
generateIncrementedSlug('my-dir', 2) // => 'my-dir-2'
```

### Slug Validation Rules

| Rule | Constraint |
|---|---|
| Length | 2-50 characters |
| Characters | Lowercase letters, numbers, hyphens |
| Start/end | Cannot start or end with hyphen |
| Consecutive hyphens | Not allowed (`--`) |

## Validation Utilities

Standalone validation functions in `utils/validation-utils.ts` that return `{ isValid, error? }` objects:

```typescript
validateUrl('https://example.com')  // { isValid: true }
validateUrl('not-a-url')            // { isValid: false, error: 'Please enter...' }

validateEmail('user@test.com')      // { isValid: true }
validateGitUsername('my-user')      // { isValid: true }
validateApiKey('sk-1234567890')     // { isValid: true }
validateModelName('gpt-4')         // { isValid: true }
```

The `GIT_USERNAME_REGEX` pattern supports both GitHub-style usernames (alphanumeric + hyphens) and GitLab-style usernames (alphanumeric + hyphens + underscores).

## Configuration Check Utilities

Functions in `utils/config-check.ts` for CLI configuration validation:

```typescript
interface ConfigValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

interface ConfigChecker {
    checkConfiguration(): Promise<boolean>;
    requireConfiguration(): Promise<void>;
}
```

| Function | Description |
|---|---|
| `displayConfigurationError(message, errors?)` | Shows error with setup instructions |
| `displayConfigurationWarnings(warnings)` | Shows warning list |
| `maskSecret(secret)` | Masks secrets showing first/last 4 chars |

```typescript
maskSecret('sk-1234567890abcdef')
// => 'sk-1********cdef'
```

## Generator Steps

The `utils/generator-steps.ts` module defines the generation pipeline steps and provides progress tracking utilities used by both CLIs and the web frontend.

### Step Definitions

```typescript
enum ItemsGeneratorStep {
    PROMPT_COMPARISON = 'prompt-comparison',
    PROMPT_PROCESSING = 'prompt-processing',
    DOMAIN_DETECTION = 'domain-detection',
    AI_FIRST_ITEMS_GENERATION = 'ai-first-items-generation',
    SEARCH_QUERIES_GENERATION = 'search-queries-generation',
    WEB_SEARCH = 'web-search',
    CONTENT_RETRIEVAL = 'content-retrieval',
    CONTENT_FILTERING = 'content-filtering',
    ITEMS_EXTRACTION = 'items-extraction',
    DEDUPLICATION_AND_DATA_AGGREGATION = 'deduplication-and-data-aggregation',
    CATEGORIES_TAGS_PROCESSING = 'categories-tags-processing',
    SOURCES_VALIDATION = 'sources-validation',
    BADGES_PROCESSING = 'badges-processing',
    MARKDOWN_GENERATION = 'markdown-generation',
}
```

### Progress Functions

| Function | Description |
|---|---|
| `getStepText(step)` | Returns human-readable step description |
| `getStepProgress(step)` | Returns percentage based on step position |
| `getDynamicStepText(status)` | Resolves step name from dynamic pipeline status |
| `getDynamicStepProgress(status)` | Resolves progress from dynamic pipeline status |
| `getItemsProcessedText(status)` | Returns items count text (e.g., "27 items") |

The dynamic functions support both legacy enum-based steps and the newer dynamic pipeline system that provides `stepName`, `stepIndex`, `totalSteps`, and `progress` fields.

## File Structure

```
cli-shared/src/
  index.ts                           # Public exports
  prompts/
    base-prompt.service.ts           # Abstract base with common prompts
    directory-prompt.service.ts      # Directory-specific prompts
  utils/
    config-check.ts                  # Configuration validation helpers
    slug-utils.ts                    # Slug generation and validation
    validation-utils.ts              # Input validation functions
    generator-steps.ts               # Generation pipeline step tracking
```
