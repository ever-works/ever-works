# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ever Works** is an open-source directory builder platform with AI-powered content generation.

- **Repository**: https://github.com/ever-works/ever-works
- **Docs**: https://github.com/ever-works/ever-works-docs/tree/develop/website/docs

## Commands

```bash
# Development
pnpm dev                # All apps (watch mode)
pnpm dev:api            # API only (NestJS, port 3100)
pnpm dev:web            # Web only (Next.js, port 3000)
pnpm dev:trigger        # Trigger.dev dev server

# Building
pnpm build              # Build everything (Turborepo handles dependency order)
pnpm build:plugins      # Build plugin system + all plugins
turbo build --filter=ever-works-api        # Build single app
turbo build --filter=@ever-works/agent     # Build single package

# Testing
pnpm test               # All tests across monorepo

# Agent package (Jest) — 26 suites, 719 tests
cd packages/agent && pnpm test             # All agent tests
cd packages/agent && npx jest --testPathPattern='generators' # Single test file/pattern
cd packages/agent && pnpm test:watch       # Watch mode
cd packages/agent && pnpm test:cov         # Coverage

# Plugin packages (Vitest)
cd packages/plugin && pnpm test            # Plugin contracts tests
cd packages/plugins/openai && pnpm test    # Single plugin tests
cd packages/plugins/openai && npx vitest run src/openai.spec.ts  # Single file

# API tests (Jest)
cd apps/api && pnpm test

# Quality
pnpm lint               # ESLint all packages
pnpm type-check         # TypeScript check all packages
pnpm format             # Prettier format all files

# Database migrations (from apps/api/)
pnpm typeorm migration:generate -d typeorm.config.ts
pnpm typeorm migration:run -d typeorm.config.ts

# Trigger.dev deployment
pnpm deploy:trigger
```

**Package manager**: pnpm only (never npm/yarn). Node.js >=20. Run `pnpm install` after adding dependencies.

## Architecture

### Monorepo Layout

- **Turborepo** orchestrates builds with `^build` dependency ordering
- **pnpm workspaces**: `apps/*`, `packages/*`, `packages/plugins/*`

```
apps/
  api/              # NestJS 11 REST API (SWC compiler, TypeORM, JWT auth)
  web/              # Next.js 16 App Router (React 19, Tailwind CSS 4, next-intl)
  cli/              # Public CLI (esbuild, commander)
  internal-cli/     # Internal NestJS CLI (nest-commander)

packages/
  plugin/           # Plugin system contracts & utilities (ESM, tsup, MIT)
  contracts/        # Shared TypeScript types (ESM, tsup, MIT)
  agent/            # Core AI agent logic (NestJS+SWC, private)
  tasks/            # Trigger.dev background jobs
  monitoring/       # Sentry + PostHog integration
  cli-shared/       # Shared CLI utilities
  plugins/          # 21 plugin implementations (each ESM, tsup, Vitest)
```

### Plugin System

Plugins are standalone ESM packages in `packages/plugins/`. Each plugin:

- Declares metadata via `everworks.plugin` in its `package.json` (id, name, category, capabilities)
- Extends `BaseAiProvider` from `@ever-works/plugin/abstract` (for AI providers)
- Uses `AiOperations` from `@ever-works/plugin/ai` (wraps LangChain for all providers)
- Defines settings via JSON Schema with custom extensions (`x-widget`, `x-secret`, `x-envVar`)
- Builds with tsup, tests with Vitest

**Plugin categories**: ai-provider (openai, anthropic, google, groq, ollama, openrouter), search (exa, tavily, serpapi, brave), content-extraction (local-content-extractor, notion-extractor), screenshot (screenshotone, urlbox), git (github), infrastructure (vercel, apify), pipeline (agent-pipeline, standard-pipeline), ai-tools (claude-code, vercel-ai-gateway)

The `AiFacadeService` in `packages/agent/src/facades/` consumes AI provider plugins.

### Agent Package

`@ever-works/agent` is the core logic package with 18 sub-module exports (generators, database, dto, entities, git, facades, plugins, pipeline, etc.). It uses:

- NestJS + SWC for build, plus `tsc -p tsconfig.types.json` for declaration files
- BullMQ for job queues
- isomorphic-git for local git operations
- TypeORM for database abstractions
- Jest for testing (module name mappings resolve workspace packages to source)

### API Structure

`apps/api/src/` modules: auth (JWT + OAuth), directories (core domain), ai-conversation, mail, integrations, plugins, subscriptions, notifications, trigger, events, config. Uses `@Public()` decorator to skip auth, `@CurrentUser()` for user context.

### Web Structure

`apps/web/src/`: App Router pages in `app/`, React components in `components/`, API utilities in `lib/`, i18n via next-intl in `i18n/`. Server components by default; use `'use client'` only when interactivity is needed.

### Path Aliases

- `@/*` → `apps/web/src/*`
- `@src/*` → `apps/api/src/*`
- `@ever-works/*` → workspace packages

## Code Style

### Formatting (Prettier — root `package.json` config takes precedence)

- Print width: 120 (root) / 100 (`.prettierrc` in some packages)
- Indentation: tabs, width 4 (root); spaces in SCSS/YAML
- Single quotes, semicolons always, arrow parens always
- Trailing commas: none (root config)

### Naming

- Files: kebab-case (`auth.service.ts`, `user-profile.tsx`)
- Classes/Interfaces/Types: PascalCase
- Functions/Variables: camelCase
- Constants: UPPER_SNAKE_CASE

### Commits

Conventional commits enforced by commitlint: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## Key Dependencies

| Concern            | Package                                        | Version          |
| ------------------ | ---------------------------------------------- | ---------------- |
| Backend framework  | NestJS                                         | 11.1.13          |
| Frontend framework | Next.js                                        | 16.1.5           |
| React              | React                                          | 19.2.3           |
| ORM                | TypeORM                                        | 0.3.28           |
| AI                 | LangChain (@langchain/core, @langchain/openai) | ^0.3.80, ^0.6.17 |
| Validation         | class-validator / zod                          | 0.14.3 / ^3.25   |
| Background jobs    | BullMQ / Trigger.dev                           | ^5.66 / 4.3.3    |
| TypeScript         | TypeScript                                     | 5.9.3            |

## Known Gotchas

- **DTS build failure with conditional spreads**: `...value && { key: value }` produces `string | false` and breaks declaration emit. Use explicit `if` blocks to conditionally add properties instead.
- **Prettier config conflict**: Root `package.json` uses tabs + 120 width; `.prettierrc` file uses spaces + 100 width. The root `package.json` config takes precedence for most files. Be aware when formatting.
- **Jest module mappings**: Agent package tests map `@ever-works/plugin` and `@ever-works/contracts` to source directories via `moduleNameMapper`. If tests fail with import errors, check these mappings in `jest.config.js`.
- **Build before test**: Some packages require their workspace dependencies to be built first. Run `pnpm build` from root if you get resolution errors during testing.
