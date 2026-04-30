---
id: agent-directory-module
title: Directory Management Module
sidebar_label: Directory Management
sidebar_position: 21
---

# Directory Management Module

## Overview

The Directory Management module is the central domain module of the `@ever-works/agent` package. It coordinates all operations around directory lifecycle -- creation, updates, querying, deletion, and synchronization. A "directory" in Ever Works represents a curated listing project backed by three Git repositories (data, markdown, and website) and a deployment target.

This module ties together the generation pipeline, taxonomy, scheduling, deployment, membership, and import sub-systems into a unified service layer consumed by the API application.

## Module Structure

```
packages/agent/src/
  entities/
    directory.entity.ts           # Core Directory TypeORM entity
    directory-member.entity.ts    # Team membership entity
    directory-schedule.entity.ts  # Scheduling entity
    directory-custom-domain.entity.ts
    directory-generation-history.entity.ts
  services/
    directory.module.ts           # NestJS module definition
    directory-lifecycle.service.ts    # CRUD lifecycle operations
    directory-query.service.ts       # Read/query operations
    directory-generation.service.ts  # Generation orchestration
    directory-schedule.service.ts    # Scheduling management
    directory-taxonomy.service.ts    # Categories, tags, collections
    directory-ownership.service.ts   # Role-based access control
  dto/
    create-directory.dto.ts       # Creation validation
    update-directory.dto.ts       # Update validation
  database/
    repositories/
      directory.repository.ts     # TypeORM repository
```

## Key Classes and Services

### `Directory` Entity

The core TypeORM entity mapped to the `directories` table. Key fields include:

| Field | Type | Purpose |
|---|---|---|
| `id` | UUID | Primary key |
| `name` / `slug` | string | Display name and URL-safe identifier |
| `userId` | string | Creator reference (FK to `users`) |
| `owner` | string | Git repository owner (user or org) |
| `gitProvider` | string | Git provider identifier (`github`, `gitlab`) |
| `deployProvider` | string | Deployment provider (`vercel`, `netlify`) |
| `generateStatus` | JSON | Current generation state per phase |
| `generationStartedAt` / `generationFinishedAt` | Date | Generation timing |
| `domainType` | string | Content domain classification (`software`, `ecommerce`, `services`, `general`) |
| `scheduledUpdatesEnabled` | boolean | Whether automated updates are active |
| `scheduledCadence` | string | Update frequency (`hourly`, `daily`, `weekly`, `monthly`) |
| `communityPrEnabled` | boolean | Whether community PR processing is active |
| `comparisonsEnabled` | boolean | Whether comparison generation is active |
| `websiteTemplateAutoUpdate` | boolean | Auto-update the website template |
| `repoVisibility` | JSON | Privacy settings per repo (data, website, directory) |
| `sourceRepository` | JSON | Import source metadata |

Helper methods on the entity:

- `getDataRepo()` / `getWebsiteRepo()` / `getMainRepo()` -- derive repository names from slug
- `getRepoOwner()` -- resolve owner from `owner` field or user username
- `isCreator(userId)` -- check if a user is the original creator
- `hasAccess(userId)` -- check creator or member access
- `getUserRole(userId)` -- return role (`owner`, `editor`, `viewer`)

### `DirectoryLifecycleService`

Handles CRUD lifecycle operations:

- **`createDirectory(dto, user)`** -- validates slug uniqueness, creates entity, initializes data/markdown/website repositories via generators, sets up the deployment project
- **`updateDirectory(id, dto, user)`** -- partial update with ownership verification
- **`syncFromDataRepository(directory, user)`** -- re-reads items from the data repo and regenerates markdown
- **`deleteDirectory(id, user)`** -- cascading delete across data, markdown, and website repositories, deployment project cleanup, and database removal

Dependencies: `DirectoryRepository`, `DataGeneratorService`, `MarkdownGeneratorService`, `WebsiteGeneratorService`, `DirectoryOwnershipService`, `DeployFacadeService`.

### `DirectoryQueryService`

Read-only query operations:

- **`getDirectories(userId, options)`** -- paginated listing with search, sorting, and role enrichment. Returns `DirectoryWithRole` objects that include the user's role for each directory.
- **`getDirectory(id, userId)`** -- single directory with access check
- **`directoryExists(slug, owner)`** -- uniqueness check
- **`directoryItems(directory)`** -- fetch items from the data repository
- **`directoryConfig(directory)`** -- fetch config.yml from the data repository
- **`getWebsiteSettings(directory)` / `updateWebsiteSettings(...)`** -- read/write website configuration
- **`directoryGenerationHistory(directoryId)`** -- fetch generation run history

### `DirectoryOwnershipService`

Enforces role-based access control:

- Roles: `owner` (full control), `editor` (content modifications), `viewer` (read-only)
- Creator always has implicit `owner` role
- Members can be assigned roles via `DirectoryMember` entity

### `DirectoryModule`

The NestJS module definition imports:

- `DatabaseModule`, `DataGeneratorModule`, `ItemsGeneratorModule`, `FacadesModule`
- `MarkdownGeneratorModule`, `WebsiteGeneratorModule`, `ImportModule`
- `SubscriptionsModule`, `NotificationsModule`
- `CommunityPrModule`, `ComparisonGeneratorModule`

Provides 15+ services including all lifecycle, query, generation, scheduling, taxonomy, and ownership services.

## API Reference

### DirectoryLifecycleService

```typescript
createDirectory(dto: CreateDirectoryDto, user: User): Promise<Directory>
updateDirectory(id: string, dto: UpdateDirectoryDto, user: User): Promise<Directory>
syncFromDataRepository(directory: Directory, user: User): Promise<void>
deleteDirectory(id: string, user: User): Promise<void>
```

### DirectoryQueryService

```typescript
getDirectories(userId: string, options?: {
    page?: number;
    limit?: number;
    search?: string;
    sort?: string;
}): Promise<{ directories: DirectoryWithRole[]; total: number }>

getDirectory(id: string, userId: string): Promise<Directory>
directoryExists(slug: string, owner: string): Promise<boolean>
directoryItems(directory: Directory): Promise<ItemData[]>
directoryConfig(directory: Directory): Promise<Record<string, unknown>>
getWebsiteSettings(directory: Directory): Promise<WebsiteSettings>
updateWebsiteSettings(directory: Directory, user: User, settings: WebsiteSettings): Promise<void>
directoryGenerationHistory(directoryId: string): Promise<DirectoryGenerationHistory[]>
```

## Configuration

### CreateDirectoryDto

Validated with `class-validator` decorators:

| Field | Validation | Required |
|---|---|---|
| `slug` | Regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 100 chars | Yes |
| `name` | Max 100 characters, sanitized | Yes |
| `description` | Max 500 characters, sanitized | Yes |
| `owner` | Optional string | No |
| `organization` | Boolean | No |
| `gitProvider` | Default `github` | No |
| `deployProvider` | Default `vercel` | No |
| `readmeConfig` | `MarkdownReadmeConfigDto` (header/footer) | No |

Input sanitization is applied via `sanitizeName`, `sanitizeDescription`, and `sanitizeText` transforms that strip HTML tags, trim whitespace, and normalize unicode.

### UpdateDirectoryDto

Optional fields: `name`, `description`, `owner`, `organization`, `deployProvider`, `readmeConfig`, `websiteTemplateAutoUpdate`, `websiteTemplateUseBeta`, `communityPrEnabled`, `communityPrAutoClose`.

## Dependencies

| Dependency | Purpose |
|---|---|
| `TypeORM` | Entity mapping, repository queries |
| `class-validator` / `class-transformer` | DTO validation and sanitization |
| `@ever-works/agent/database` | `DirectoryRepository` and related repositories |
| `@ever-works/agent/generators` | Data, Markdown, and Website generator services |
| `@ever-works/agent/facades` | `DeployFacadeService`, `GitFacadeService` |
| `@ever-works/agent/subscriptions` | Subscription plan enforcement |
| `@ever-works/agent/notifications` | Email/push notification dispatch |

## Usage Examples

### Creating a Directory

```typescript
import { DirectoryLifecycleService } from '@ever-works/agent/services';

const directory = await lifecycleService.createDirectory(
    {
        slug: 'ai-tools',
        name: 'AI Tools Directory',
        description: 'A curated list of AI-powered developer tools',
        gitProvider: 'github',
        deployProvider: 'vercel',
    },
    currentUser,
);
```

### Querying Directories with Role Enrichment

```typescript
import { DirectoryQueryService } from '@ever-works/agent/services';

const { directories, total } = await queryService.getDirectories(userId, {
    page: 1,
    limit: 20,
    search: 'tools',
});

// Each directory includes userRole: 'owner' | 'editor' | 'viewer'
directories.forEach((dir) => {
    console.log(`${dir.name} - Role: ${dir.userRole}`);
});
```

### Checking Access

```typescript
const directory = await queryService.getDirectory(directoryId, userId);

if (directory.hasAccess(userId)) {
    const role = directory.getUserRole(userId);
    // 'owner' can delete, 'editor' can modify, 'viewer' can read
}
```
