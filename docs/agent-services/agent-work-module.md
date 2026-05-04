---
id: agent-work-module
title: Work Management Module
sidebar_label: Work Management
sidebar_position: 21
---

# Work Management Module

## Overview

The Work Management module is the central domain module of the `@ever-works/agent` package. It coordinates all operations around work lifecycle -- creation, updates, querying, deletion, and synchronization. A "work" in Ever Works represents a curated listing project backed by three Git repositories (data, markdown, and website) and a deployment target.

This module ties together the generation pipeline, taxonomy, scheduling, deployment, membership, and import sub-systems into a unified service layer consumed by the API application.

## Module Structure

```
packages/agent/src/
  entities/
    work.entity.ts           # Core Work TypeORM entity
    work-member.entity.ts    # Team membership entity
    work-schedule.entity.ts  # Scheduling entity
    work-custom-domain.entity.ts
    work-generation-history.entity.ts
  services/
    work.module.ts           # NestJS module definition
    work-lifecycle.service.ts    # CRUD lifecycle operations
    work-query.service.ts       # Read/query operations
    work-generation.service.ts  # Generation orchestration
    work-schedule.service.ts    # Scheduling management
    work-taxonomy.service.ts    # Categories, tags, collections
    work-ownership.service.ts   # Role-based access control
  dto/
    create-work.dto.ts       # Creation validation
    update-work.dto.ts       # Update validation
  database/
    repositories/
      work.repository.ts     # TypeORM repository
```

## Key Classes and Services

### `Work` Entity

The core TypeORM entity mapped to the `works` table. Key fields include:

| Field                                          | Type    | Purpose                                                                        |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `id`                                           | UUID    | Primary key                                                                    |
| `name` / `slug`                                | string  | Display name and URL-safe identifier                                           |
| `userId`                                       | string  | Creator reference (FK to `users`)                                              |
| `owner`                                        | string  | Git repository owner (user or org)                                             |
| `gitProvider`                                  | string  | Git provider identifier (`github`, `gitlab`)                                   |
| `deployProvider`                               | string  | Deployment provider (`vercel`, `netlify`)                                      |
| `generateStatus`                               | JSON    | Current generation state per phase                                             |
| `generationStartedAt` / `generationFinishedAt` | Date    | Generation timing                                                              |
| `domainType`                                   | string  | Content domain classification (`software`, `ecommerce`, `services`, `general`) |
| `scheduledUpdatesEnabled`                      | boolean | Whether automated updates are active                                           |
| `scheduledCadence`                             | string  | Update frequency (`hourly`, `daily`, `weekly`, `monthly`)                      |
| `communityPrEnabled`                           | boolean | Whether community PR processing is active                                      |
| `comparisonsEnabled`                           | boolean | Whether comparison generation is active                                        |
| `websiteTemplateAutoUpdate`                    | boolean | Auto-update the website template                                               |
| `repoVisibility`                               | JSON    | Privacy settings per repo (data, website, work)                                |
| `sourceRepository`                             | JSON    | Import source metadata                                                         |

Helper methods on the entity:

- `getDataRepo()` / `getWebsiteRepo()` / `getMainRepo()` -- derive repository names from slug
- `getRepoOwner()` -- resolve owner from `owner` field or user username
- `isCreator(userId)` -- check if a user is the original creator
- `hasAccess(userId)` -- check creator or member access
- `getUserRole(userId)` -- return role (`owner`, `editor`, `viewer`)

### `WorkLifecycleService`

Handles CRUD lifecycle operations:

- **`createWork(dto, user)`** -- validates slug uniqueness, creates entity, initializes data/markdown/website repositories via generators, sets up the deployment project
- **`updateWork(id, dto, user)`** -- partial update with ownership verification
- **`syncFromDataRepository(work, user)`** -- re-reads items from the data repo and regenerates markdown
- **`deleteWork(id, user)`** -- cascading delete across data, markdown, and website repositories, deployment project cleanup, and database removal

Dependencies: `WorkRepository`, `DataGeneratorService`, `MarkdownGeneratorService`, `WebsiteGeneratorService`, `WorkOwnershipService`, `DeployFacadeService`.

### `WorkQueryService`

Read-only query operations:

- **`getWorks(userId, options)`** -- paginated listing with search, sorting, and role enrichment. Returns `WorkWithRole` objects that include the user's role for each work.
- **`getWork(id, userId)`** -- single work with access check
- **`workExists(slug, owner)`** -- uniqueness check
- **`workItems(work)`** -- fetch items from the data repository
- **`workConfig(work)`** -- fetch config.yml from the data repository
- **`getWebsiteSettings(work)` / `updateWebsiteSettings(...)`** -- read/write website configuration
- **`workGenerationHistory(workId)`** -- fetch generation run history

### `WorkOwnershipService`

Enforces role-based access control:

- Roles: `owner` (full control), `editor` (content modifications), `viewer` (read-only)
- Creator always has implicit `owner` role
- Members can be assigned roles via `WorkMember` entity

### `WorkModule`

The NestJS module definition imports:

- `DatabaseModule`, `DataGeneratorModule`, `ItemsGeneratorModule`, `FacadesModule`
- `MarkdownGeneratorModule`, `WebsiteGeneratorModule`, `ImportModule`
- `SubscriptionsModule`, `NotificationsModule`
- `CommunityPrModule`, `ComparisonGeneratorModule`

Provides 15+ services including all lifecycle, query, generation, scheduling, taxonomy, and ownership services.

## API Reference

### WorkLifecycleService

```typescript
createWork(dto: CreateWorkDto, user: User): Promise<Work>
updateWork(id: string, dto: UpdateWorkDto, user: User): Promise<Work>
syncFromDataRepository(work: Work, user: User): Promise<void>
deleteWork(id: string, user: User): Promise<void>
```

### WorkQueryService

```typescript
getWorks(userId: string, options?: {
    page?: number;
    limit?: number;
    search?: string;
    sort?: string;
}): Promise<{ works: WorkWithRole[]; total: number }>

getWork(id: string, userId: string): Promise<Work>
workExists(slug: string, owner: string): Promise<boolean>
workItems(work: Work): Promise<ItemData[]>
workConfig(work: Work): Promise<Record<string, unknown>>
getWebsiteSettings(work: Work): Promise<WebsiteSettings>
updateWebsiteSettings(work: Work, user: User, settings: WebsiteSettings): Promise<void>
workGenerationHistory(workId: string): Promise<WorkGenerationHistory[]>
```

## Configuration

### CreateWorkDto

Validated with `class-validator` decorators:

| Field            | Validation                                        | Required |
| ---------------- | ------------------------------------------------- | -------- |
| `slug`           | Regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 100 chars | Yes      |
| `name`           | Max 100 characters, sanitized                     | Yes      |
| `description`    | Max 500 characters, sanitized                     | Yes      |
| `owner`          | Optional string                                   | No       |
| `organization`   | Boolean                                           | No       |
| `gitProvider`    | Default `github`                                  | No       |
| `deployProvider` | Default `vercel`                                  | No       |
| `readmeConfig`   | `MarkdownReadmeConfigDto` (header/footer)         | No       |

Input sanitization is applied via `sanitizeName`, `sanitizeDescription`, and `sanitizeText` transforms that strip HTML tags, trim whitespace, and normalize unicode.

### UpdateWorkDto

Optional fields: `name`, `description`, `owner`, `organization`, `deployProvider`, `readmeConfig`, `websiteTemplateAutoUpdate`, `websiteTemplateUseBeta`, `communityPrEnabled`, `communityPrAutoClose`.

## Dependencies

| Dependency                              | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `TypeORM`                               | Entity mapping, repository queries             |
| `class-validator` / `class-transformer` | DTO validation and sanitization                |
| `@ever-works/agent/database`            | `WorkRepository` and related repositories      |
| `@ever-works/agent/generators`          | Data, Markdown, and Website generator services |
| `@ever-works/agent/facades`             | `DeployFacadeService`, `GitFacadeService`      |
| `@ever-works/agent/subscriptions`       | Subscription plan enforcement                  |
| `@ever-works/agent/notifications`       | Email/push notification dispatch               |

## Usage Examples

### Creating a Work

```typescript
import { WorkLifecycleService } from '@ever-works/agent/services';

const work = await lifecycleService.createWork(
	{
		slug: 'ai-tools',
		name: 'AI Tools Work',
		description: 'A curated list of AI-powered developer tools',
		gitProvider: 'github',
		deployProvider: 'vercel'
	},
	currentUser
);
```

### Querying Works with Role Enrichment

```typescript
import { WorkQueryService } from '@ever-works/agent/services';

const { works, total } = await queryService.getWorks(userId, {
	page: 1,
	limit: 20,
	search: 'tools'
});

// Each work includes userRole: 'owner' | 'editor' | 'viewer'
works.forEach((dir) => {
	console.log(`${dir.name} - Role: ${dir.userRole}`);
});
```

### Checking Access

```typescript
const work = await queryService.getWork(workId, userId);

if (work.hasAccess(userId)) {
	const role = work.getUserRole(userId);
	// 'owner' can delete, 'editor' can modify, 'viewer' can read
}
```
