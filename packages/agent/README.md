# @ever-works/agent

Core AI agent logic for the Ever Works platform. This package contains the domain logic that powers work generation, item enrichment, pipelines, scheduling, git operations, plugin orchestration, and the supporting services consumed by the API and background workers.

> **Private package.** `@ever-works/agent` is consumed internally by `apps/api` and `@ever-works/trigger-tasks`. It is not published to npm.

## Overview

`@ever-works/agent` is a NestJS-based library compiled with SWC. It is the heart of the Ever Works backend — every module that performs meaningful business work (creating a work, generating items, deploying, importing, scheduling, etc.) lives here as a self-contained, importable sub-module.

It is consumed by:

- [`apps/api`](../../apps/api) — the public REST API (NestJS)
- [`@ever-works/trigger-tasks`](../tasks) — Trigger.dev background workers
- [`apps/internal-cli`](../../apps/internal-cli) — internal operational CLI

## Sub-module exports

The package exposes 25+ sub-paths so consumers only import what they need. Each sub-path maps to a folder under `src/` with its own NestJS module, services, DTOs and entities.

| Subpath                                | Purpose                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `@ever-works/agent/generators`         | Prompt and output generators used by AI providers and pipelines                |
| `@ever-works/agent/items-generator`    | Item enrichment, screenshotting, content extraction orchestration              |
| `@ever-works/agent/pipeline`           | Pipeline registry, executor, and built-in step contracts                       |
| `@ever-works/agent/database`           | TypeORM data source, migrations, and repository helpers                        |
| `@ever-works/agent/entities`           | TypeORM entities (Work, Item, Category, Tag, User, etc.)                       |
| `@ever-works/agent/dto`                | Shared DTOs used between the API and the agent                                 |
| `@ever-works/agent/git`                | `isomorphic-git` wrappers shared by all git provider plugins                   |
| `@ever-works/agent/work-operations`    | Work lifecycle: create, generate, regenerate, cancel, delete                   |
| `@ever-works/agent/import`             | Importers for existing data sources (CSV, Notion, etc.)                        |
| `@ever-works/agent/subscriptions`      | Plan limits, billing-aware feature gating                                      |
| `@ever-works/agent/notifications`      | Multi-channel notification dispatching                                         |
| `@ever-works/agent/events`             | Event bus, event types, and listeners                                          |
| `@ever-works/agent/tasks`              | BullMQ queue definitions and processors                                        |
| `@ever-works/agent/cache`              | Cache module wrapper with TTL helpers                                          |
| `@ever-works/agent/config`             | NestJS `ConfigModule` setup, validation, and typed accessors                   |
| `@ever-works/agent/constants`          | Shared constants                                                               |
| `@ever-works/agent/services`           | Cross-cutting domain services                                                  |
| `@ever-works/agent/plugins`            | Plugin registry, loader, and sandboxed execution                               |
| `@ever-works/agent/facades`            | Capability facades (AI, Search, Deploy, Screenshot, Content-Extractor, …)     |
| `@ever-works/agent/community-pr`       | Community pull request workflow                                                |
| `@ever-works/agent/comparison-generator` | Generates comparison pages between items                                     |
| `@ever-works/agent/account-transfer`   | Account ownership transfer flow                                                |
| `@ever-works/agent/activity-log`       | Audit/activity log domain                                                      |
| `@ever-works/agent/works-config`       | Works configuration and templates                                              |
| `@ever-works/agent/onboarding`         | Onboarding flow logic                                                          |
| `@ever-works/agent/utils`              | General utilities                                                              |

## Installation

`@ever-works/agent` is a workspace package. From within the monorepo:

```jsonc
// apps/api/package.json
"dependencies": {
    "@ever-works/agent": "workspace:*"
}
```

## Usage

```typescript
import { Module } from '@nestjs/common';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { PipelineModule } from '@ever-works/agent/pipeline';
import { FacadesModule } from '@ever-works/agent/facades';

@Module({
    imports: [WorkOperationsModule, PipelineModule, FacadesModule]
})
export class AppModule {}
```

## Capability facades

The package exposes a set of facades under `@ever-works/agent/facades` that wrap loaded plugins behind a stable interface — the API never imports plugins directly.

- `AiFacadeService` — chat completions, embeddings, model listing
- `SearchFacadeService` — web search across providers
- `ScreenshotFacadeService` — page screenshot generation
- `ContentExtractorFacadeService` — extract structured content from URLs
- `DeploymentFacadeService` — deploy generated sites
- `GitProviderFacadeService` — git provider operations (auth, repo CRUD, PRs)

Plugins are loaded by category and one is marked as the active default. See [`packages/plugin/README.md`](../plugin/README.md) for the plugin contracts.

## Database

Uses TypeORM with peer-dependency-driven driver selection (`pg`, `mysql2`, or `better-sqlite3`). Migrations live under `apps/api/src/migrations/` and are run from `apps/api`.

> Never set `synchronize: true` in production — always run migrations.

## Build & test

```bash
# Build (NestJS + SWC, plus tsc for declaration files)
pnpm --filter @ever-works/agent build

# Tests (Jest, 26 suites, 700+ tests)
pnpm --filter @ever-works/agent test
pnpm --filter @ever-works/agent test:watch
pnpm --filter @ever-works/agent test:cov
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [Plugin system contracts](../plugin/README.md)
- [Shared types](../contracts/README.md)

## License

UNLICENSED — internal package, not for external distribution.
