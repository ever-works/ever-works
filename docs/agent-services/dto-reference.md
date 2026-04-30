---
id: dto-reference
title: DTO Reference
sidebar_label: DTO Reference
sidebar_position: 9
---

# DTO Reference

This page documents all Data Transfer Objects (DTOs) in the agent package. DTOs define the shape of data exchanged between the API layer and the agent services. They use `class-validator` for validation and `class-transformer` for input sanitization.

**Source:** `packages/agent/src/dto/`

## Directory DTOs

### CreateDirectoryDto

Used when creating a new directory.

**Source:** `dto/create-directory.dto.ts`

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| `slug` | `string` | Yes | Lowercase alphanumeric + hyphens, regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` | URL-friendly identifier |
| `name` | `string` | Yes | Max 100 chars, sanitized via `sanitizeName()` | Display name |
| `description` | `string` | Yes | Max 500 chars, sanitized via `sanitizeDescription()` | Brief description |
| `owner` | `string` | No | Trimmed | Username or organization for repo ownership |
| `organization` | `boolean` | Yes | -- | Whether the owner is an organization |
| `gitProvider` | `string` | No | Trimmed, lowercased, default: `'github'` | Git provider plugin ID |
| `deployProvider` | `string` | No | Trimmed, lowercased | Deploy provider (e.g., `'vercel'`) |
| `readmeConfig` | `MarkdownReadmeConfigDto` | No | Nested validation | Custom README header/footer |

### MarkdownReadmeConfigDto

Nested configuration for README customization.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `header` | `string` | No | Custom header content (preserves newlines) |
| `overwriteDefaultHeader` | `boolean` | No | Replace default header entirely (default: false) |
| `footer` | `string` | No | Custom footer content (preserves newlines) |
| `overwriteDefaultFooter` | `boolean` | No | Replace default footer entirely (default: false) |

### UpdateDirectoryDto

Used when updating an existing directory.

**Source:** `dto/update-directory.dto.ts`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | No | Updated display name (max 100 chars) |
| `description` | `string` | No | Updated description (max 500 chars) |
| `owner` | `string` | No | Updated repo owner |
| `organization` | `boolean` | No | Updated organization flag |
| `deployProvider` | `string` | No | Updated deploy provider |
| `readmeConfig` | `MarkdownReadmeConfigDto` | No | Updated README configuration |
| `websiteTemplateAutoUpdate` | `boolean` | No | Toggle auto-update for website template |
| `websiteTemplateUseBeta` | `boolean` | No | Toggle beta branch for website template |
| `communityPrEnabled` | `boolean` | No | Enable community PR processing |
| `communityPrAutoClose` | `boolean` | No | Auto-close community PRs |

## Import DTOs

### ImportDirectoryDto

Used when importing a directory from an external repository.

**Source:** `dto/import-directory.dto.ts`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceUrl` | `string` | Yes | Repository URL to import from |
| `sourceType` | `ImportSourceTypeEnum` | Yes | `data_repo`, `awesome_readme`, or `link_existing` |
| `name` | `string` | Yes | Directory name (max 100 chars) |
| `owner` | `string` | No | Repo owner override |
| `organization` | `boolean` | No | Organization flag |
| `createMissingRepos` | `boolean` | No | Create repos that do not exist |
| `sync` | `boolean` | No | Enable ongoing sync from source |
| `gitProvider` | `string` | Yes | Git provider plugin ID |
| `deployProvider` | `string` | No | Deploy provider |
| `providers` | `ImportProvidersDto` | No | AI provider override for import |

### AnalyzeRepositoryDto

Used to analyze a repository before importing.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceUrl` | `string` | Yes | Repository URL to analyze |
| `gitProvider` | `string` | No | Git provider plugin ID |

### AnalyzeRepositoryResponseDto

Response from repository analysis.

| Field | Type | Description |
|-------|------|-------------|
| `sourceUrl` | `string` | Analyzed URL |
| `owner` | `string` | Repository owner |
| `repo` | `string` | Repository name |
| `detectedType` | `ImportSourceType` | Detected import type |
| `isPublic` | `boolean` | Repository visibility |
| `requiresAuth` | `boolean` | Whether auth is needed |
| `structure` | `object` | Repository structure analysis |
| `slugConflict` | `object` | Slug conflict information |

### GetUserRepositoriesDto

Used to list repositories from a Git provider.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `gitProvider` | `string` | Yes | Git provider plugin ID |
| `page` | `number` | No | Page number (min: 1) |
| `perPage` | `number` | No | Results per page (min: 1) |
| `search` | `string` | No | Search filter |
| `owner` | `string` | No | Filter by owner |
| `type` | `'user' \| 'org'` | No | Filter by owner type |

## Schedule DTOs

### UpdateDirectoryScheduleDto

Used to create or update a directory schedule.

**Source:** `dto/directory-schedule.dto.ts`

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| `enable` | `boolean` | No | -- | Activate or deactivate the schedule |
| `cadence` | `DirectoryScheduleCadence` | No | Enum: `hourly`, `daily`, `weekly`, `monthly` | Update frequency |
| `billingMode` | `DirectoryScheduleBillingMode` | No | Enum: `subscription`, `usage` | How runs are billed |
| `maxFailureBeforePause` | `number` | No | Integer, min: 1, max: 10 | Consecutive failures before auto-pause |
| `alwaysCreatePullRequest` | `boolean` | No | -- | Force PR creation on scheduled runs |
| `providerOverrides` | `ProvidersDto \| null` | No | Nested validation | Override providers for scheduled runs |

## Generation History DTOs

### DirectoryGenerationHistoryDto

**Source:** `dto/directory-generation-history.dto.ts`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Record UUID |
| `status` | `GenerateStatusType` | `GENERATING`, `GENERATED`, or `ERROR` |
| `generationMethod` | `GenerationMethod \| null` | `CREATE_UPDATE` or `RECREATE` |
| `startedAt` | `string \| null` | ISO 8601 start time |
| `finishedAt` | `string \| null` | ISO 8601 end time |
| `durationInSeconds` | `number \| null` | Elapsed wall-clock time |
| `newItemsCount` | `number` | Items created in this run |
| `updatedItemsCount` | `number` | Items updated in this run |
| `totalItemsCount` | `number` | Total items after this run |
| `metrics` | `GenerationMetrics \| null` | Detailed pipeline metrics |
| `errorMessage` | `string \| null` | Error message if failed |
| `parameters` | `Record<string, any> \| null` | Generation parameters |
| `createdAt` | `string` | Record creation time |
| `updatedAt` | `string` | Last update time |
| `triggerRunId` | `string` | Background task run ID |

### DirectoryGenerationHistoryListDto

```typescript
interface DirectoryGenerationHistoryListDto {
    history: DirectoryGenerationHistoryDto[];
    total: number;
    limit: number;
    offset: number;
}
```

## Taxonomy DTOs

### Category DTOs

**Source:** `dto/taxonomy.dto.ts`

| DTO | Fields | Description |
|-----|--------|-------------|
| `CreateCategoryDto` | `name` (required, max 100), `description` (max 500), `icon_url` (max 500), `priority` (min 0) | Create a category |
| `UpdateCategoryDto` | Same fields as create, all optional | Update a category |

### Collection DTOs

| DTO | Fields | Description |
|-----|--------|-------------|
| `CreateCollectionDto` | `name` (required, max 100), `description` (max 500), `icon_url` (max 500), `priority` (min 0) | Create a collection |
| `UpdateCollectionDto` | Same fields as create, all optional | Update a collection |

### Tag DTOs

| DTO | Fields | Description |
|-----|--------|-------------|
| `CreateTagDto` | `name` (required, max 50) | Create a tag |
| `UpdateTagDto` | `name` (optional, max 50) | Update a tag |

## Website Settings DTOs

**Source:** `dto/website-settings.dto.ts`

### UpdateWebsiteSettingsDto

| Field | Type | Description |
|-------|------|-------------|
| `company_name` | `string` | Brand name (max 100) |
| `company_website` | `string` | Company URL (max 200) |
| `categories_enabled` | `boolean` | Show categories section |
| `collections_enabled` | `boolean` | Show collections section |
| `companies_enabled` | `boolean` | Show companies section |
| `tags_enabled` | `boolean` | Show tags section |
| `surveys_enabled` | `boolean` | Show surveys section |
| `comparisons_enabled` | `boolean` | Show comparisons section |
| `header` | `SettingsHeaderDto` | Header configuration |
| `homepage` | `SettingsHomepageDto` | Homepage configuration |
| `footer` | `SettingsFooterDto` | Footer configuration |
| `custom_menu` | `CustomMenuDto` | Custom navigation links |

### SettingsHeaderDto

| Field | Type | Description |
|-------|------|-------------|
| `submit_enabled` | `boolean` | Show submit button |
| `pricing_enabled` | `boolean` | Show pricing link |
| `layout_enabled` | `boolean` | Show layout toggle |
| `language_enabled` | `boolean` | Show language selector |
| `theme_enabled` | `boolean` | Show theme toggle |
| `layout_default` | `string` | Default layout (max 20) |
| `pagination_default` | `string` | Default pagination (max 20) |
| `theme_default` | `string` | Default theme: `light`, `dark`, or `system` |

### SettingsHomepageDto

| Field | Type | Description |
|-------|------|-------------|
| `hero_enabled` | `boolean` | Show hero section |
| `search_enabled` | `boolean` | Show search bar |
| `default_view` | `string` | Default view mode (max 20) |
| `default_sort` | `string` | Default sort order (max 20) |

### CustomMenuItemDto

| Field | Type | Validation | Description |
|-------|------|------------|-------------|
| `label` | `string` | Max 50 chars | Display text |
| `path` | `string` | Max 200 chars | Link path or URL |
| `target` | `string` | `_self` or `_blank` | Link target |
| `icon` | `string` | Max 50 chars | Icon identifier |

Custom menus support up to 10 items each for header and footer.
