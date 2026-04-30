---
id: agent-dto-reference
title: 'Agent DTO Reference Deep Dive'
sidebar_label: 'DTO Reference'
sidebar_position: 20
---

# Agent DTO Reference Deep Dive

## Overview

The agent package's DTO (Data Transfer Object) layer defines the validated input and output shapes for all agent service operations. These DTOs use `class-validator` decorators for runtime validation, `class-transformer` decorators for input sanitization, and `@nestjs/swagger` decorators for API documentation generation. This reference covers all DTOs exported from `@ever-works/agent/dto`.

## Architecture

DTOs sit between the API controller layer and the service layer. NestJS pipes automatically validate incoming request bodies against DTO class definitions before they reach service methods.

```
HTTP Request Body
        |
        v
ValidationPipe (class-validator)
        |
        v
TransformPipe (class-transformer)
        |
        v
DTO instance (sanitized + validated)
        |
        v
Service method
```

## CreateDirectoryDto

Used when creating a new directory manually.

### Fields

| Field            | Type                      | Required | Validation                                                                   | Description                                 |
| ---------------- | ------------------------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| `slug`           | `string`                  | Yes      | Lowercase letters, numbers, hyphens only; regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` | URL-friendly identifier                     |
| `name`           | `string`                  | Yes      | Max 100 chars, sanitized via `sanitizeName`                                  | Display name                                |
| `description`    | `string`                  | Yes      | Max 500 chars, sanitized via `sanitizeDescription`                           | Brief description                           |
| `owner`          | `string`                  | No       | Trimmed                                                                      | Username or organization for repo ownership |
| `organization`   | `boolean`                 | Yes      | --                                                                           | Whether the owner is an organization        |
| `gitProvider`    | `string`                  | No       | Default: `'github'`, lowercased                                              | Git provider plugin ID                      |
| `deployProvider` | `string`                  | No       | Lowercased                                                                   | Deploy provider (e.g., `vercel`)            |
| `readmeConfig`   | `MarkdownReadmeConfigDto` | No       | Nested validation                                                            | Custom README configuration                 |

### MarkdownReadmeConfigDto

| Field                    | Type      | Required | Description                          |
| ------------------------ | --------- | -------- | ------------------------------------ |
| `header`                 | `string`  | No       | Custom header content for the README |
| `overwriteDefaultHeader` | `boolean` | No       | Replace the default header entirely  |
| `footer`                 | `string`  | No       | Custom footer content for the README |
| `overwriteDefaultFooter` | `boolean` | No       | Replace the default footer entirely  |

## UpdateDirectoryDto

Used when updating directory metadata.

### Fields

| Field                       | Type                      | Required | Description                        |
| --------------------------- | ------------------------- | -------- | ---------------------------------- |
| `name`                      | `string`                  | No       | Max 100 chars                      |
| `description`               | `string`                  | No       | Max 500 chars                      |
| `owner`                     | `string`                  | No       | Repository owner override          |
| `organization`              | `boolean`                 | No       | Organization flag                  |
| `deployProvider`            | `string`                  | No       | Deploy provider                    |
| `readmeConfig`              | `MarkdownReadmeConfigDto` | No       | README configuration               |
| `websiteTemplateAutoUpdate` | `boolean`                 | No       | Auto-update website template       |
| `websiteTemplateUseBeta`    | `boolean`                 | No       | Use beta website template          |
| `communityPrEnabled`        | `boolean`                 | No       | Enable community PR processing     |
| `communityPrAutoClose`      | `boolean`                 | No       | Auto-close processed community PRs |

## GenerateDataDto

Used to trigger data generation for a directory.

### Fields

| Field    | Type     | Required | Description               |
| -------- | -------- | -------- | ------------------------- |
| `slug`   | `string` | Yes      | Directory slug identifier |
| `prompt` | `string` | Yes      | Generation prompt         |

## ImportDirectoryDto

Used when importing a directory from an external source.

### Fields

| Field                | Type                   | Required | Description                                            |
| -------------------- | ---------------------- | -------- | ------------------------------------------------------ |
| `sourceUrl`          | `string`               | Yes      | Valid URL to the source repository                     |
| `sourceType`         | `ImportSourceTypeEnum` | Yes      | One of: `data_repo`, `awesome_readme`, `link_existing` |
| `name`               | `string`               | Yes      | Max 100 chars, sanitized                               |
| `owner`              | `string`               | No       | Repository owner                                       |
| `organization`       | `boolean`              | No       | Organization flag                                      |
| `createMissingRepos` | `boolean`              | No       | Create missing markdown/website repos when linking     |
| `sync`               | `boolean`              | No       | Enable sync schedule after import                      |
| `gitProvider`        | `string`               | Yes      | Git provider plugin ID                                 |
| `deployProvider`     | `string`               | No       | Deploy provider                                        |
| `providers`          | `ImportProvidersDto`   | No       | Provider overrides (e.g., `{ ai: 'anthropic' }`)       |

### ImportSourceTypeEnum

```typescript
enum ImportSourceTypeEnum {
	DATA_REPO = 'data_repo',
	AWESOME_README = 'awesome_readme',
	LINK_EXISTING = 'link_existing'
}
```

### Response DTOs

**AnalyzeRepositoryResponseDto** -- returned by repository analysis:

| Field          | Type                       | Description                                                                                  |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `sourceUrl`    | `string`                   | The analyzed URL                                                                             |
| `owner`        | `string`                   | Repository owner                                                                             |
| `repo`         | `string`                   | Repository name                                                                              |
| `detectedType` | `ImportSourceType \| null` | Detected repository type                                                                     |
| `isPublic`     | `boolean`                  | Whether the repo is public                                                                   |
| `requiresAuth` | `boolean`                  | Whether authentication is needed                                                             |
| `structure`    | `object`                   | Repository structure details (hasConfig, hasDataFolder, hasReadme, itemCount, categoryCount) |
| `slugConflict` | `object`                   | Slug conflict details if applicable                                                          |
| `error`        | `string`                   | Error message if analysis failed                                                             |

**ImportDirectoryResponseDto** -- returned by import initiation:

| Field         | Type                                | Description                 |
| ------------- | ----------------------------------- | --------------------------- |
| `status`      | `'pending' \| 'success' \| 'error'` | Operation status            |
| `directoryId` | `string`                            | Created directory ID        |
| `historyId`   | `string`                            | Generation history entry ID |
| `message`     | `string`                            | Status message              |

## UpdateDirectoryAdvancedPromptsDto

Used to set custom AI prompts per directory.

### Fields

All fields are optional. `null` or empty strings reset the field to use the platform default.

| Field                 | Type             | Max Length | Pipeline Stage          |
| --------------------- | ---------------- | ---------- | ----------------------- |
| `relevanceAssessment` | `string \| null` | 2,000      | Item relevance scoring  |
| `itemGeneration`      | `string \| null` | 2,000      | Item creation           |
| `itemExtraction`      | `string \| null` | 2,000      | Content extraction      |
| `searchQuery`         | `string \| null` | 2,000      | Search query generation |
| `categorization`      | `string \| null` | 2,000      | Category assignment     |
| `deduplication`       | `string \| null` | 2,000      | Duplicate detection     |
| `sourceValidation`    | `string \| null` | 2,000      | Source URL validation   |

### Response DTO

**DirectoryAdvancedPromptsResponseDto** -- all fields plus `directoryId` and `updatedAt` (ISO string or null).

## UpdateDirectoryScheduleDto

Used to configure scheduled directory updates.

### Fields

| Field                     | Type                           | Required | Description                                       |
| ------------------------- | ------------------------------ | -------- | ------------------------------------------------- |
| `enable`                  | `boolean`                      | No       | Enable or disable the schedule                    |
| `cadence`                 | `DirectoryScheduleCadence`     | No       | Update frequency                                  |
| `billingMode`             | `DirectoryScheduleBillingMode` | No       | Billing mode for scheduled runs                   |
| `maxFailureBeforePause`   | `number`                       | No       | Max consecutive failures before auto-pause (1-10) |
| `alwaysCreatePullRequest` | `boolean`                      | No       | Always create PRs instead of direct commits       |
| `providerOverrides`       | `ProvidersDto \| null`         | No       | AI/search provider overrides for scheduled runs   |

## DirectoryGenerationHistoryDto

Read-only DTO for generation history entries.

### Fields

| Field               | Type                          | Description                  |
| ------------------- | ----------------------------- | ---------------------------- |
| `id`                | `string`                      | History entry ID             |
| `status`            | `GenerateStatusType`          | Generation status            |
| `generationMethod`  | `GenerationMethod \| null`    | How generation was triggered |
| `startedAt`         | `string \| null`              | ISO start timestamp          |
| `finishedAt`        | `string \| null`              | ISO finish timestamp         |
| `durationInSeconds` | `number \| null`              | Total duration               |
| `newItemsCount`     | `number`                      | Items created                |
| `updatedItemsCount` | `number`                      | Items updated                |
| `totalItemsCount`   | `number`                      | Total items after generation |
| `metrics`           | `GenerationMetrics \| null`   | Token usage and cost metrics |
| `errorMessage`      | `string \| null`              | Error details if failed      |
| `parameters`        | `Record<string, any> \| null` | Generation parameters        |
| `triggerRunId`      | `string`                      | Trigger.dev run ID           |

## Taxonomy DTOs

### CreateCategoryDto / UpdateCategoryDto

| Field         | Type     | Required (Create) | Max Length | Description                     |
| ------------- | -------- | ----------------- | ---------- | ------------------------------- |
| `name`        | `string` | Yes               | 100        | Category name, sanitized        |
| `description` | `string` | No                | 500        | Category description, sanitized |
| `icon_url`    | `string` | No                | 500        | Icon URL                        |
| `priority`    | `number` | No                | Min: 0     | Sort priority                   |

### CreateCollectionDto / UpdateCollectionDto

Same fields as category DTOs.

### CreateTagDto / UpdateTagDto

| Field  | Type     | Required (Create) | Max Length | Description         |
| ------ | -------- | ----------------- | ---------- | ------------------- |
| `name` | `string` | Yes               | 50         | Tag name, sanitized |

## UpdateWebsiteSettingsDto

Configures the directory website appearance and features.

### Fields

| Field                 | Type                  | Description                                       |
| --------------------- | --------------------- | ------------------------------------------------- |
| `company_name`        | `string`              | Max 100 chars                                     |
| `company_website`     | `string`              | Max 200 chars                                     |
| `categories_enabled`  | `boolean`             | Show categories section                           |
| `collections_enabled` | `boolean`             | Show collections section                          |
| `companies_enabled`   | `boolean`             | Show companies section                            |
| `tags_enabled`        | `boolean`             | Show tags section                                 |
| `surveys_enabled`     | `boolean`             | Enable surveys                                    |
| `comparisons_enabled` | `boolean`             | Enable comparisons                                |
| `header`              | `SettingsHeaderDto`   | Header configuration                              |
| `homepage`            | `SettingsHomepageDto` | Homepage configuration                            |
| `footer`              | `SettingsFooterDto`   | Footer configuration                              |
| `custom_menu`         | `CustomMenuDto`       | Custom menu items (max 10 each for header/footer) |

### Nested Settings DTOs

**SettingsHeaderDto:** `submit_enabled`, `pricing_enabled`, `layout_enabled`, `language_enabled`, `theme_enabled`, `layout_default`, `pagination_default`, `theme_default` (light/dark/system)

**SettingsHomepageDto:** `hero_enabled`, `search_enabled`, `default_view`, `default_sort`

**SettingsFooterDto:** `subscribe_enabled`, `version_enabled`, `theme_selector_enabled`

**CustomMenuItemDto:** `label` (max 50), `path` (max 200), `target` (\_self/\_blank), `icon` (max 50)

## Implementation Details

### Sanitization Strategy

All DTOs use `class-transformer` `@Transform` decorators to sanitize input before validation:

- **`sanitizeName(value, maxLength)`** -- strips control characters, collapses whitespace, trims, truncates
- **`sanitizeDescription(value, maxLength)`** -- same as name but preserves sentence structure
- **`sanitizePrompt(value, maxLength)`** -- strips dangerous characters while preserving prompt formatting
- **`sanitizeText(value, options)`** -- configurable sanitization (optionally preserve newlines, spaces)

### Validation Pipeline

1. `class-transformer` applies `@Transform` decorators (sanitization)
2. `class-validator` checks `@Is*` decorators (validation)
3. Invalid requests receive a 400 Bad Request with detailed field-level error messages

## Related Services

- [Directory Detail Service](/agent-services/directory-detail-service) -- uses `DirectoryDetails` interface (not a class DTO)
- [Directory Import Service](/agent-services/directory-import-service) -- consumes `ImportDirectoryDto` and related DTOs
- [Directory Taxonomy](/agent-services/directory-taxonomy-service) -- consumes taxonomy DTOs
- [Advanced Prompts](/agent-services/directory-advanced-prompts) -- consumes `UpdateDirectoryAdvancedPromptsDto`
