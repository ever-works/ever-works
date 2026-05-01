---
id: agent-package-overview
title: Agent Package Overview
sidebar_label: Agent Package
sidebar_position: 11
---

# Agent Package Overview

The `@ever-works/agent` package is the core logic layer of the Ever Works platform. It encapsulates all AI-powered content generation, database access, plugin runtime, git operations, pipeline orchestration, and entity definitions used by the API and background job systems. It is a private NestJS library package that is never published to npm.

## Overview

| Property         | Value                        |
| ---------------- | ---------------------------- |
| **Package name** | `@ever-works/agent`          |
| **Location**     | `platform/packages/agent/`   |
| **Framework**    | NestJS 11 (SWC compiler)     |
| **ORM**          | TypeORM 0.3                  |
| **Test runner**  | Jest (26 suites, 719+ tests) |
| **License**      | UNLICENSED (private)         |
| **Node.js**      | >=20                         |

## Module Structure

The package is organized into 20 sub-module directories, each published as a separate export path:

```
packages/agent/src/
├── cache/                    # Persistent caching layer (TypeORM-backed Keyv adapter)
├── community-pr/             # Community pull request processing
├── comparison-generator/     # Item comparison page generation
├── config/                   # Configuration management
├── constants/                # Shared constants
├── database/                 # TypeORM database module and repositories
├── directory-operations/     # Directory lifecycle state management
├── dto/                      # Data transfer objects and validation schemas
├── entities/                 # TypeORM entity definitions
├── events/                   # Domain event classes
├── facades/                  # AI facade service (plugin consumer)
├── generators/               # AI content generation engine
├── import/                   # Directory import from external sources
├── items-generator/          # Item-level content generation
├── notifications/            # Notification system
├── pipeline/                 # Generation pipeline orchestration
├── plugins/                  # Plugin runtime (discovery, loading, lifecycle)
├── services/                 # Shared business services
├── subscriptions/            # Subscription and usage management
├── tasks/                    # Background task definitions and types
└── utils/                    # Shared utility functions
```

## Package Exports

Each sub-module is exposed as a dedicated export path in `package.json`, enabling consumers to import only what they need:

```typescript
// Import specific sub-modules
import { DataGeneratorService } from '@ever-works/agent/generators';
import { DirectoryRepository } from '@ever-works/agent/database';
import { Directory } from '@ever-works/agent/entities';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { PluginsModule } from '@ever-works/agent/plugins';
import { AiFacadeService } from '@ever-works/agent/facades';
import { PipelineModule } from '@ever-works/agent/pipeline';
```

The full list of export paths:

| Export Path                              | Description                                              |
| ---------------------------------------- | -------------------------------------------------------- |
| `@ever-works/agent/generators`           | AI content generation engine and data generators         |
| `@ever-works/agent/database`             | TypeORM module, repositories, and database configuration |
| `@ever-works/agent/dto`                  | Data transfer objects with class-validator decorators    |
| `@ever-works/agent/entities`             | TypeORM entity definitions for all domain models         |
| `@ever-works/agent/git`                  | Git operations (isomorphic-git based)                    |
| `@ever-works/agent/directory-operations` | Directory generation state management                    |
| `@ever-works/agent/items-generator`      | Item-level content generation                            |
| `@ever-works/agent/tasks`                | Background task type definitions                         |
| `@ever-works/agent/events`               | Domain event classes                                     |
| `@ever-works/agent/services`             | Shared business services                                 |
| `@ever-works/agent/subscriptions`        | Subscription and usage tracking                          |
| `@ever-works/agent/config`               | Configuration management                                 |
| `@ever-works/agent/cache`                | Persistent caching layer                                 |
| `@ever-works/agent/notifications`        | Notification delivery                                    |
| `@ever-works/agent/import`               | Directory import system                                  |
| `@ever-works/agent/facades`              | AI facade (consumes AI provider plugins)                 |
| `@ever-works/agent/plugins`              | Plugin runtime infrastructure                            |
| `@ever-works/agent/pipeline`             | Generation pipeline orchestration                        |
| `@ever-works/agent/utils`                | Shared utility functions                                 |
| `@ever-works/agent/community-pr`         | Community pull request processing                        |
| `@ever-works/agent/comparison-generator` | Comparison page generation                               |

## Key Services

### Database Layer

The `database/` sub-module provides the `DatabaseModule` and a comprehensive set of TypeORM repositories:

- `DirectoryRepository` -- CRUD for directories
- `DirectoryGenerationHistoryRepository` -- Generation run history
- `DirectoryMemberRepository` -- Directory team membership
- `UserRepository` -- User records
- `ApiKeyRepository` -- API key management
- `SubscriptionPlanRepository` and `UserSubscriptionRepository` -- Subscription data
- `DirectoryScheduleRepository` -- Scheduled generation configuration
- `UsageLedgerRepository` -- Usage and quota tracking
- `NotificationRepository` -- User notifications

### Plugin Runtime

The `plugins/` sub-module provides the `PluginsModule`, a global NestJS dynamic module that manages the full plugin lifecycle:

- **PluginRegistryService** -- In-memory registry of loaded plugin instances
- **PluginLoaderService** -- Discovers and loads plugins from file system or built-in sources
- **PluginLifecycleManagerService** -- State machine for plugin load/unload transitions
- **PluginSettingsService** -- Multi-layer settings resolution (directory > user > admin > env > default)
- **PluginBootstrapService** -- Application-level bootstrap and shutdown coordination
- **PluginContextFactoryService** -- Creates isolated `PluginContext` for each plugin
- **CustomCapabilityRegistryService** -- Registry for plugin-defined capabilities

### AI Facades

The `facades/` sub-module contains `AiFacadeService`, which provides a unified interface for all AI operations. It consumes AI provider plugins (OpenAI, Anthropic, Google, etc.) and routes requests to the currently configured provider with resolved settings.

### Generation Pipeline

The `pipeline/` sub-module orchestrates multi-step content generation workflows. It coordinates the generators, git operations, deployment triggers, and status updates into a coherent pipeline.

## Entity Model

Core TypeORM entities defined in `entities/`:

| Entity                       | Table                          | Description                                            |
| ---------------------------- | ------------------------------ | ------------------------------------------------------ |
| `Directory`                  | `directories`                  | Central domain entity representing a directory project |
| `DirectoryGenerationHistory` | `directory_generation_history` | Audit log of every generation run                      |
| `DirectorySchedule`          | `directory_schedules`          | Scheduled update configuration                         |
| `DirectoryMember`            | `directory_members`            | Team membership and roles                              |
| `DirectoryCustomDomain`      | `directory_custom_domains`     | Custom domain mappings                                 |
| `User`                       | `users`                        | Platform user accounts                                 |

## Configuration

The package uses NestJS `@nestjs/config` for configuration management. Database connection settings are resolved through the `DatabaseConfigFactory`:

```typescript
import { DatabaseModule } from '@ever-works/agent/database';

@Module({
	imports: [
		DatabaseModule.forRoot({
			type: 'postgres',
			host: process.env.DB_HOST,
			port: parseInt(process.env.DB_PORT, 10),
			database: process.env.DB_NAME,
			username: process.env.DB_USER,
			password: process.env.DB_PASSWORD
		})
	]
})
export class AppModule {}
```

The package supports PostgreSQL, MySQL, and SQLite (via optional peer dependencies).

## Dependencies

### Runtime Dependencies

| Package                                 | Purpose                                           |
| --------------------------------------- | ------------------------------------------------- |
| `@ever-works/contracts`                 | Shared TypeScript types (workspace)               |
| `@ever-works/plugin`                    | Plugin system contracts and utilities (workspace) |
| `typeorm`                               | Database ORM                                      |
| `@nestjs/typeorm`                       | NestJS TypeORM integration                        |
| `@nestjs/config`                        | Configuration management                          |
| `@nestjs/swagger`                       | API documentation decorators                      |
| `@nestjs/cache-manager`                 | Cache abstraction                                 |
| `@langchain/textsplitters`              | Text chunking for AI operations                   |
| `zod` / `ajv`                           | Schema validation                                 |
| `class-transformer` / `class-validator` | DTO transformation and validation                 |
| `lodash`                                | Utility functions                                 |
| `p-map`                                 | Concurrent async mapping                          |
| `yaml`                                  | YAML parsing                                      |
| `superjson`                             | Extended JSON serialization                       |
| `github-slugger`                        | URL-safe slug generation                          |
| `semver`                                | Semantic version comparison                       |
| `date-fns`                              | Date utility functions                            |

### Peer Dependencies

| Package                    | Version | Notes                          |
| -------------------------- | ------- | ------------------------------ |
| `@nestjs/common`           | ^11.1   | Required                       |
| `@nestjs/core`             | ^11.1   | Required                       |
| `@nestjs/event-emitter`    | ^3.0    | Required                       |
| `@nestjs/platform-express` | ^11.1   | Required                       |
| `reflect-metadata`         | ^0.2    | Required                       |
| `rxjs`                     | ^7.8    | Required                       |
| `better-sqlite3`           | ^12.2   | Optional -- SQLite support     |
| `pg`                       | ^8.16   | Optional -- PostgreSQL support |
| `mysql2`                   | ^3.14   | Optional -- MySQL support      |

## Build and Test

### Build

The package uses a dual build: SWC for fast JavaScript compilation and `tsc` for declaration file generation:

```bash
# Full build
cd packages/agent && pnpm build

# Watch mode (development)
cd packages/agent && pnpm dev
```

The `build` script runs `nest build -b swc` followed by `tsc -p tsconfig.types.json` to produce both JavaScript output and `.d.ts` type declarations under `dist/`.

### Test

```bash
# Run all tests
cd packages/agent && pnpm test

# Run tests matching a pattern
cd packages/agent && npx jest --testPathPattern='directory-operations'

# Watch mode
cd packages/agent && pnpm test:watch

# Coverage report
cd packages/agent && pnpm test:cov
```

Jest is configured with `moduleNameMapper` entries that resolve `@ever-works/plugin` and `@ever-works/contracts` to their source directories, avoiding the need to build workspace dependencies before running tests.

## Usage Examples

### Importing the Package in an API Module

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { DirectoryOperationsModule } from '@ever-works/agent/directory-operations';
import { PluginsModule } from '@ever-works/agent/plugins';

@Module({
	imports: [
		DatabaseModule.forRoot(/* config */),
		DirectoryOperationsModule,
		PluginsModule.forRoot({
			autoLoadBuiltIn: true,
			environment: 'production'
		})
	]
})
export class ApiModule {}
```

### Working with Entities

```typescript
import { Directory } from '@ever-works/agent/entities';
import { DirectoryRepository } from '@ever-works/agent/database';

@Injectable()
export class DirectoryService {
	constructor(private readonly directoryRepo: DirectoryRepository) {}

	async findBySlug(slug: string): Promise<Directory | null> {
		return this.directoryRepo.findOne({ where: { slug } });
	}
}
```

### Using the AI Facade

```typescript
import { AiFacadeService } from '@ever-works/agent/facades';

@Injectable()
export class ContentService {
	constructor(private readonly aiFacade: AiFacadeService) {}

	async generateDescription(prompt: string): Promise<string> {
		const response = await this.aiFacade.createChatCompletion({
			messages: [{ role: 'user', content: prompt }]
		});
		return response.content;
	}
}
```
