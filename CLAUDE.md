# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ever Works** is an open-source work builder platform with AI-powered content generation.

- **Repository**: https://github.com/ever-works/ever-works
- **Docs site**: https://docs.ever.works (built from `apps/docs/`, content in `docs/`)
- **Specs**: `docs/specs/` (internal architecture specs + GitHub Spec Kit format under `docs/specs/features/`)

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

**Package manager**: pnpm only (never npm/yarn). Node.js >=22 (matches the Docker `node:22-alpine` base image). Run `pnpm install` after adding dependencies.

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
  admin/            # Admin interface
  mcp/              # MCP (Model Context Protocol) server
  docs/             # Docusaurus 3 documentation site (renders ../../docs/)

docs/               # Markdown docs content rendered by apps/docs
  specs/            # Internal architecture specs + Spec Kit feature specs

.specify/           # GitHub Spec Kit infrastructure (constitution, templates, scripts)

packages/
  plugin/           # Plugin system contracts & utilities (ESM, tsup, MIT)
  contracts/        # Shared TypeScript types (ESM, tsup, MIT)
  agent/            # Core AI agent logic (NestJS+SWC, private)
  tasks/            # Trigger.dev background jobs
  monitoring/       # Sentry + PostHog integration
  cli-shared/       # Shared CLI utilities
  plugins/          # 39 plugin implementations (each ESM, tsup, Vitest)
```

### Plugin System

Plugins are standalone ESM packages in `packages/plugins/`. Each plugin:

- Declares metadata via `everworks.plugin` in its `package.json` (id, name, category, capabilities)
- Extends `BaseAiProvider` from `@ever-works/plugin/abstract` (for AI providers)
- Uses `AiOperations` from `@ever-works/plugin/ai` (wraps LangChain for all providers)
- Defines settings via JSON Schema with custom extensions (`x-widget`, `x-secret`, `x-envVar`)
- Builds with tsup, tests with Vitest

**Plugin categories** (39 plugins on `develop`):

- **ai-provider**: openai, anthropic, google, groq, ollama, mistral
- **ai-gateway**: openrouter (default), vercel-ai-gateway
- **search**: tavily (default), brave, exa, serpapi, perplexity, brightdata, firecrawl, jina, valyu, linkup
- **content-extractor**: local-content-extractor (default), notion-extractor, pdf-extractor, scrapfly
- **screenshot**: screenshotone, urlbox, scrapfly
- **git-provider**: github (default + OAuth)
- **deployment**: vercel (default)
- **data-source**: apify
- **pipeline**: standard-pipeline (default 15-step), agent-pipeline (Vercel AI SDK), claude-code, claude-managed-agent, codex, gemini (CLI — distinct from `google` AI provider), opencode, make, sim-ai, zapier
- **prompt-provider**: langfuse
- **utility**: comparison-generator

The `AiFacadeService` in `packages/agent/src/facades/` consumes AI provider plugins.

### Agent Package

`@ever-works/agent` is the core logic package with 21 sub-module exports (generators, items-generator, pipeline, database, entities, dto, git, work-operations, import, subscriptions, notifications, events, tasks, cache, config, services, plugins, community-pr, comparison-generator, facades, utils, works-config). It uses:

- NestJS + SWC for build, plus `tsc -p tsconfig.types.json` for declaration files
- BullMQ for job queues
- isomorphic-git for local git operations
- TypeORM for database abstractions
- Jest for testing (module name mappings resolve workspace packages to source)

### API Structure

`apps/api/src/` modules: account, activity-log, ai-conversation, auth (JWT + OAuth GitHub/Google), config, works (core domain — CRUD, generation, items, categories, tags, collections, import, scheduled updates, community PR, cancellation), events, integrations, mail, notifications, plugins, plugins-capabilities (AI/Search/Deploy/Screenshot/Content-Extractor facades), subscriptions, templates, trigger. Uses `@Public()` decorator to skip auth, `@CurrentUser()` for user context.

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
- **Jest module mappings**: Agent package tests map `@ever-works/plugin` and `@ever-works/contracts` to source works via `moduleNameMapper`. If tests fail with import errors, check these mappings in `jest.config.js`.
- **Build before test**: Some packages require their workspace dependencies to be built first. Run `pnpm build` from root if you get resolution errors during testing.

<!-- autoskills:start -->

Summary generated by `autoskills`. Check the full files inside `.claude/skills`.

## Accessibility (a11y)

Audit and improve web accessibility following WCAG 2.2 guidelines. Use when asked to "improve accessibility", "a11y audit", "WCAG compliance", "screen reader support", "keyboard navigation", or "make accessible".

- `.claude/skills/accessibility/SKILL.md`
- `.claude/skills/accessibility/references/A11Y-PATTERNS.md`: Practical, copy-paste-ready patterns for common accessibility requirements. Each pattern is self-contained and linked from the main [SKILL.md](../SKILL.md).
- `.claude/skills/accessibility/references/WCAG.md`

## Prerequisites

Answer questions about the AI SDK and help build AI-powered features. Use when developers: (1) Ask about AI SDK functions like generateText, streamText, ToolLoopAgent, embed, or tools, (2) Want to build AI agents, chatbots, RAG systems, or text generation features, (3) Have questions about AI pro...

- `.claude/skills/ai-sdk/SKILL.md`
- `.claude/skills/ai-sdk/references/ai-gateway.md`: Reference for using Vercel AI Gateway with the AI SDK.
- `.claude/skills/ai-sdk/references/common-errors.md`: Reference for common AI SDK errors and how to resolve them.
- `.claude/skills/ai-sdk/references/devtools.md`: Debug AI SDK calls by inspecting captured runs and steps.
- `.claude/skills/ai-sdk/references/type-safe-agents.md`: Build end-to-end type-safe agents by inferring UIMessage types from your agent definition.

## Better Auth Integration Guide

Configure Better Auth server and client, set up database adapters, manage sessions, add plugins, and handle environment variables. Use when users mention Better Auth, betterauth, auth.ts, or need to set up TypeScript authentication with email/password, OAuth, or plugin configuration.

- `.claude/skills/better-auth-best-practices/SKILL.md`

## Deploy to Vercel

Deploy applications and websites to Vercel. Use when the user requests deployment actions like "deploy my app", "deploy and give me the link", "push this live", or "create a preview deployment".

- `.claude/skills/deploy-to-vercel/SKILL.md`

## Quick Start

Configure email verification, implement password reset flows, set password policies, and customise hashing algorithms for Better Auth email/password authentication. Use when users need to set up login, sign-in, sign-up, credential authentication, or password security with Better Auth.

- `.claude/skills/email-and-password-best-practices/SKILL.md`

## Design Thinking

Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beaut...

- `.claude/skills/frontend-design/SKILL.md`

## NestJS Best Practices

NestJS best practices and architecture patterns for building production-ready applications. This skill should be used when writing, reviewing, or refactoring NestJS code to ensure proper patterns for modules, dependency injection, security, and performance.

- `.claude/skills/nestjs-best-practices/SKILL.md`
- `.claude/skills/nestjs-best-practices/AGENTS.md`: **Version 1.1.0** NestJS Best Practices January 2026
- `.claude/skills/nestjs-best-practices/README.md`: 📖 [For Humans <3](https://kadajett.github.io/agent-nestjs-skills/)
- `.claude/skills/nestjs-best-practices/rules/_sections.md`: This file defines all sections, their ordering, impact levels, and descriptions. The section ID (in parentheses) is the filename prefix used to group rules.
- `.claude/skills/nestjs-best-practices/rules/_template.md`: **Impact: MEDIUM (optional impact description)**
- `.claude/skills/nestjs-best-practices/rules/api-use-dto-serialization.md`: Never return entity objects directly from controllers. Use response DTOs with class-transformer's `@Exclude()` and `@Expose()` decorators to control exactly what data is sent to clients. This prevents accidental exposure of sensitive fields and provides a stable API contract.
- `.claude/skills/nestjs-best-practices/rules/api-use-interceptors.md`: Interceptors can transform responses, add logging, handle caching, and measure performance without polluting your business logic. They wrap the route handler execution, giving you access to both the request and response streams.
- `.claude/skills/nestjs-best-practices/rules/api-use-pipes.md`: Use built-in pipes like `ParseIntPipe`, `ParseUUIDPipe`, and `DefaultValuePipe` for common transformations. Create custom pipes for business-specific transformations. Pipes separate validation/transformation logic from controllers.
- `.claude/skills/nestjs-best-practices/rules/api-versioning.md`: Use NestJS built-in versioning when making breaking changes to your API. Choose a versioning strategy (URI, header, or media type) and apply it consistently. This allows old clients to continue working while new clients use updated endpoints.
- `.claude/skills/nestjs-best-practices/rules/arch-avoid-circular-deps.md`: Circular dependencies occur when Module A imports Module B, and Module B imports Module A (directly or transitively). NestJS can sometimes resolve these through forward references, but they indicate architectural problems and should be avoided. This is the #1 cause of runtime crashes in NestJS ap...
- `.claude/skills/nestjs-best-practices/rules/arch-feature-modules.md`: Organize your application into feature modules that encapsulate related functionality. Each feature module should be self-contained with its own controllers, services, entities, and DTOs. Avoid organizing by technical layer (all controllers together, all services together). This enables 3-5x fast...
- `.claude/skills/nestjs-best-practices/rules/arch-module-sharing.md`: NestJS modules are singletons by default. When a service is properly exported from a module and that module is imported elsewhere, the same instance is shared. However, providing a service in multiple modules creates separate instances, leading to memory waste, state inconsistency, and confusing...
- `.claude/skills/nestjs-best-practices/rules/arch-single-responsibility.md`: Each service should have a single, well-defined responsibility. Avoid "god services" that handle multiple unrelated concerns. If a service name includes "And" or handles more than one domain concept, it likely violates single responsibility. This reduces complexity and improves testability by 40%+.
- `.claude/skills/nestjs-best-practices/rules/arch-use-events.md`: Use `@nestjs/event-emitter` for intra-service events and message brokers for inter-service communication. Events allow modules to react to changes without direct dependencies, improving modularity and enabling async processing.
- `.claude/skills/nestjs-best-practices/rules/arch-use-repository-pattern.md`: Create custom repositories to encapsulate complex queries and database logic. This keeps services focused on business logic, makes testing easier with mock repositories, and allows changing database implementations without affecting business code.
- `.claude/skills/nestjs-best-practices/rules/db-avoid-n-plus-one.md`: N+1 queries occur when you fetch a list of entities, then make an additional query for each entity to load related data. Use eager loading with `relations`, query builder joins, or DataLoader to batch queries efficiently.
- `.claude/skills/nestjs-best-practices/rules/db-use-migrations.md`: Never use `synchronize: true` in production. Use migrations for all schema changes. Migrations provide version control for your database, enable safe rollbacks, and ensure consistency across all environments.
- `.claude/skills/nestjs-best-practices/rules/db-use-transactions.md`: When multiple database operations must succeed or fail together, wrap them in a transaction. This prevents partial updates that leave your data in an inconsistent state. Use TypeORM's transaction APIs or the DataSource query runner for complex scenarios.
- `.claude/skills/nestjs-best-practices/rules/devops-graceful-shutdown.md`: Handle SIGTERM and SIGINT signals to gracefully shutdown your NestJS application. Stop accepting new requests, wait for in-flight requests to complete, close database connections, and clean up resources. This prevents data loss and connection errors during deployments.
- `.claude/skills/nestjs-best-practices/rules/devops-use-config-module.md`: Use `@nestjs/config` for environment-based configuration. Validate configuration at startup to fail fast on misconfigurations. Use namespaced configuration for organization and type safety.
- `.claude/skills/nestjs-best-practices/rules/devops-use-logging.md`: Use NestJS Logger with structured JSON output in production. Include contextual information (request ID, user ID, operation) to trace requests across services. Avoid console.log and implement proper log levels.
- `.claude/skills/nestjs-best-practices/rules/di-avoid-service-locator.md`: Avoid using `ModuleRef.get()` or global containers to resolve dependencies at runtime. This hides dependencies, makes code harder to test, and breaks the benefits of dependency injection. Use constructor injection instead.
- `.claude/skills/nestjs-best-practices/rules/di-interface-segregation.md`: Clients should not be forced to depend on interfaces they don't use. In NestJS, this means keeping interfaces small and focused on specific capabilities rather than creating "fat" interfaces that bundle unrelated methods. When a service only needs to send emails, it shouldn't depend on an interfa...
- `.claude/skills/nestjs-best-practices/rules/di-liskov-substitution.md`: Subtypes must be substitutable for their base types without altering program correctness. In NestJS with dependency injection, this means any implementation of an interface or abstract class must honor the contract completely. A mock payment service used in tests must behave like a real payment s...
- `.claude/skills/nestjs-best-practices/rules/di-prefer-constructor-injection.md`: Always use constructor injection over property injection. Constructor injection makes dependencies explicit, enables TypeScript type checking, ensures dependencies are available when the class is instantiated, and improves testability. This is required for proper DI, testing, and TypeScript support.
- `.claude/skills/nestjs-best-practices/rules/di-scope-awareness.md`: NestJS has three provider scopes: DEFAULT (singleton), REQUEST (per-request instance), and TRANSIENT (new instance for each injection). Most providers should be singletons. Request-scoped providers have performance implications as they bubble up through the dependency tree. Understanding scopes p...
- `.claude/skills/nestjs-best-practices/rules/di-use-interfaces-tokens.md`: TypeScript interfaces are erased at compile time and can't be used as injection tokens. Use string tokens, symbols, or abstract classes when you want to inject implementations of interfaces. This enables swapping implementations for testing or different environments.
- `.claude/skills/nestjs-best-practices/rules/error-handle-async-errors.md`: NestJS automatically catches errors from async route handlers, but errors from background tasks, event handlers, and manually created promises can crash your application. Always handle async errors explicitly and use global handlers as a safety net.
- `.claude/skills/nestjs-best-practices/rules/error-throw-http-exceptions.md`: It's acceptable (and often preferable) to throw `HttpException` subclasses from services in HTTP applications. This keeps controllers thin and allows services to communicate appropriate error states. For truly layer-agnostic services, use domain exceptions that map to HTTP status codes.
- `.claude/skills/nestjs-best-practices/rules/error-use-exception-filters.md`: Never catch exceptions and manually format error responses in controllers. Use NestJS exception filters to handle errors consistently across your application. Create custom exception filters for specific error types and a global filter for unhandled exceptions.
- `.claude/skills/nestjs-best-practices/rules/micro-use-health-checks.md`: Implement liveness and readiness probes using `@nestjs/terminus`. Liveness checks determine if the service should be restarted. Readiness checks determine if the service can accept traffic. Proper health checks enable Kubernetes and load balancers to route traffic correctly.
- `.claude/skills/nestjs-best-practices/rules/micro-use-patterns.md`: NestJS microservices support two communication patterns: request-response (MessagePattern) and event-based (EventPattern). Use MessagePattern when you need a response, and EventPattern for fire-and-forget notifications. Understanding the difference prevents communication bugs.
- `.claude/skills/nestjs-best-practices/rules/micro-use-queues.md`: Use `@nestjs/bullmq` for background job processing. Queues decouple long-running tasks from HTTP requests, enable retry logic, and distribute workload across workers. Use them for emails, file processing, notifications, and any task that shouldn't block user requests.
- `.claude/skills/nestjs-best-practices/rules/perf-async-hooks.md`: NestJS lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, etc.) support async operations. However, misusing them can block application startup or cause race conditions. Understand the lifecycle order and use hooks appropriately.
- `.claude/skills/nestjs-best-practices/rules/perf-lazy-loading.md`: NestJS supports lazy-loading modules, which defers initialization until first use. This is valuable for large applications where some features are rarely used, serverless deployments where cold start time matters, or when certain modules have heavy initialization costs.
- `.claude/skills/nestjs-best-practices/rules/perf-optimize-database.md`: Select only needed columns, use proper indexes, avoid over-fetching relations, and consider query performance when designing your data access. Most API slowness traces back to inefficient database queries.
- `.claude/skills/nestjs-best-practices/rules/perf-use-caching.md`: Implement caching for expensive operations, frequently accessed data, and external API calls. Use NestJS CacheModule with appropriate TTLs and cache invalidation strategies. Don't cache everything - focus on high-impact areas.
- `.claude/skills/nestjs-best-practices/rules/security-auth-jwt.md`: Use `@nestjs/jwt` with `@nestjs/passport` for authentication. Store secrets securely, use appropriate token lifetimes, implement refresh tokens, and validate tokens properly. Never expose sensitive data in JWT payloads.
- `.claude/skills/nestjs-best-practices/rules/security-rate-limiting.md`: Use `@nestjs/throttler` to limit request rates per client. Apply different limits for different endpoints - stricter for auth endpoints, more relaxed for read operations. Consider using Redis for distributed rate limiting in clustered deployments.
- `.claude/skills/nestjs-best-practices/rules/security-sanitize-output.md`: While NestJS APIs typically return JSON (which browsers don't execute), XSS risks exist when rendering HTML, storing user content, or when frontend frameworks improperly handle API responses. Sanitize user-generated content before storage and use proper Content-Type headers.
- `.claude/skills/nestjs-best-practices/rules/security-use-guards.md`: Guards determine whether a request should be handled based on authentication state, roles, permissions, or other conditions. They run after middleware but before pipes and interceptors, making them ideal for access control. Use guards instead of manual checks in controllers.
- `.claude/skills/nestjs-best-practices/rules/security-validate-all-input.md`: Always validate incoming data using class-validator decorators on DTOs and the global ValidationPipe. Never trust user input. Validate all request bodies, query parameters, and route parameters before processing.
- `.claude/skills/nestjs-best-practices/rules/test-e2e-supertest.md`: End-to-end tests use Supertest to make real HTTP requests against your NestJS application. They test the full stack including middleware, guards, pipes, and interceptors. E2E tests catch integration issues that unit tests miss.
- `.claude/skills/nestjs-best-practices/rules/test-mock-external-services.md`: Never call real external services (APIs, databases, message queues) in unit tests. Mock them to ensure tests are fast, deterministic, and don't incur costs. Use realistic mock data and test edge cases like timeouts and errors.
- `.claude/skills/nestjs-best-practices/rules/test-use-testing-module.md`: Use `@nestjs/testing` module to create isolated test environments with mocked dependencies. This ensures your tests run fast, don't depend on external services, and properly test your business logic in isolation.

## Next.js Best Practices

Next.js best practices - file conventions, RSC boundaries, data patterns, async APIs, metadata, error handling, route handlers, image/font optimization, bundling

- `.claude/skills/next-best-practices/SKILL.md`
- `.claude/skills/next-best-practices/async-patterns.md`: In Next.js 15+, `params`, `searchParams`, `cookies()`, and `headers()` are asynchronous.
- `.claude/skills/next-best-practices/bundling.md`: Fix common bundling issues with third-party packages.
- `.claude/skills/next-best-practices/data-patterns.md`: Choose the right data fetching pattern for each use case.
- `.claude/skills/next-best-practices/debug-tricks.md`: Tricks to speed up debugging Next.js applications.
- `.claude/skills/next-best-practices/directives.md`: These are React directives, not Next.js specific.
- `.claude/skills/next-best-practices/error-handling.md`: Handle errors gracefully in Next.js applications.
- `.claude/skills/next-best-practices/file-conventions.md`: Next.js App Router uses file-based routing with special file conventions.
- `.claude/skills/next-best-practices/font.md`: Use `next/font` for automatic font optimization with zero layout shift.
- `.claude/skills/next-best-practices/functions.md`: Next.js function APIs.
- `.claude/skills/next-best-practices/hydration-error.md`: Diagnose and fix React hydration mismatch errors.
- `.claude/skills/next-best-practices/image.md`: Use `next/image` for automatic image optimization.
- `.claude/skills/next-best-practices/metadata.md`: Add SEO metadata to Next.js pages using the Metadata API.
- `.claude/skills/next-best-practices/parallel-routes.md`: Parallel routes render multiple pages in the same layout. Intercepting routes show a different UI when navigating from within your app vs direct URL access. Together they enable modal patterns.
- `.claude/skills/next-best-practices/route-handlers.md`: Create API endpoints with `route.ts` files.
- `.claude/skills/next-best-practices/rsc-boundaries.md`: Detect and prevent invalid patterns when crossing Server/Client component boundaries.
- `.claude/skills/next-best-practices/runtime-selection.md`: Use the default Node.js runtime for new routes and pages. Only use Edge runtime if the project already uses it or there's a specific requirement.
- `.claude/skills/next-best-practices/scripts.md`: Loading third-party scripts in Next.js.
- `.claude/skills/next-best-practices/self-hosting.md`: Deploy Next.js outside of Vercel with confidence.
- `.claude/skills/next-best-practices/suspense-boundaries.md`: Client hooks that cause CSR bailout without Suspense boundaries.

## Cache Components (Next.js 16+)

Next.js 16 Cache Components - PPR, use cache directive, cacheLife, cacheTag, updateTag

- `.claude/skills/next-cache-components/SKILL.md`

## Upgrade Next.js

Upgrade Next.js to the latest version following official migration guides and codemods

- `.claude/skills/next-upgrade/SKILL.md`

## Node.js Backend Patterns

Build production-ready Node.js backend services with Express/Fastify, implementing middleware patterns, error handling, authentication, database integration, and API design best practices. Use when creating Node.js servers, REST APIs, GraphQL backends, or microservices architectures.

- `.claude/skills/nodejs-backend-patterns/SKILL.md`
- `.claude/skills/nodejs-backend-patterns/references/advanced-patterns.md`: Advanced patterns for dependency injection, database integration, authentication, caching, and API response formatting.

## Node.js Best Practices

Node.js development principles and decision-making. Framework selection, async patterns, security, and architecture. Teaches thinking, not copying.

- `.claude/skills/nodejs-best-practices/SKILL.md`

## Node.js Express Server

>

- `.claude/skills/nodejs-express-server/SKILL.md`
- `.claude/skills/nodejs-express-server/references/authentication-with-jwt.md`
- `.claude/skills/nodejs-express-server/references/basic-express-setup.md`
- `.claude/skills/nodejs-express-server/references/database-integration-postgresql-with-sequelize.md`
- `.claude/skills/nodejs-express-server/references/environment-configuration.md`
- `.claude/skills/nodejs-express-server/references/error-handling-middleware.md`
- `.claude/skills/nodejs-express-server/references/middleware-chain-implementation.md`
- `.claude/skills/nodejs-express-server/references/restful-routes-with-crud-operations.md`

## Setup

Configure multi-tenant organizations, manage members and invitations, define custom roles and permissions, set up teams, and implement RBAC using Better Auth's organization plugin. Use when users need org setup, team management, member roles, access control, or the Better Auth organization plugin.

- `.claude/skills/organization-best-practices/SKILL.md`

## Playwright Best Practices

Use when writing Playwright tests, fixing flaky tests, debugging failures, implementing Page Object Model, configuring CI/CD, optimizing performance, mocking APIs, handling authentication or OAuth, testing accessibility (axe-core), file uploads/downloads, date/time mocking, WebSockets, geolocatio...

- `.claude/skills/playwright-best-practices/SKILL.md`
- `.claude/skills/playwright-best-practices/advanced/authentication-flows.md`: Intercept API responses to capture verification tokens for testing:
- `.claude/skills/playwright-best-practices/advanced/authentication.md`: **Use when**: You need authenticated tests and want to avoid logging in before every test. **Avoid when**: Tests require completely fresh sessions, or you are testing the login flow itself.
- `.claude/skills/playwright-best-practices/advanced/clock-mocking.md`
- `.claude/skills/playwright-best-practices/advanced/mobile-testing.md`
- `.claude/skills/playwright-best-practices/advanced/multi-context.md`: This file covers **single-user scenarios** with multiple browser tabs, windows, and popups. For **multi-user collaboration testing** (multiple users interacting simultaneously), see [multi-user.md](multi-user.md).
- `.claude/skills/playwright-best-practices/advanced/multi-user.md`
- `.claude/skills/playwright-best-practices/advanced/network-advanced.md`: Use `context.setOffline(true/false)` to simulate network connectivity changes.
- `.claude/skills/playwright-best-practices/advanced/third-party.md`
- `.claude/skills/playwright-best-practices/architecture/pom-vs-fixtures.md`: Use all three patterns together. Most projects benefit from a hybrid approach:
- `.claude/skills/playwright-best-practices/architecture/test-architecture.md`: **Ideal for**:
- `.claude/skills/playwright-best-practices/architecture/when-to-mock.md`: **Mock at the boundary, test your stack end-to-end.** Mock third-party services you don't own (payment gateways, email providers, OAuth). Never mock your own frontend-to-backend communication. Tests should prove YOUR code works, not that third-party APIs are available.
- `.claude/skills/playwright-best-practices/browser-apis/browser-apis.md`
- `.claude/skills/playwright-best-practices/browser-apis/iframes.md`
- `.claude/skills/playwright-best-practices/browser-apis/service-workers.md`: This section covers **offline-first apps (PWAs)** that are designed to work offline using service workers, caching, and background sync. For testing **unexpected network failures** (error recovery, graceful degradation), see [error-testing.md](error-testing.md#offline-testing).
- `.claude/skills/playwright-best-practices/browser-apis/websockets.md`
- `.claude/skills/playwright-best-practices/core/annotations.md`
- `.claude/skills/playwright-best-practices/core/assertions-waiting.md`: Auto-retry until condition is met or timeout. Always prefer these over generic assertions.
- `.claude/skills/playwright-best-practices/core/configuration.md`: **Use when**: Tests run against dev, staging, and production environments.
- `.claude/skills/playwright-best-practices/core/fixtures-hooks.md`: Created fresh for each test:
- `.claude/skills/playwright-best-practices/core/global-setup.md`: This section covers **one-time database setup** (migrations, snapshots, per-worker databases). For related topics:
- `.claude/skills/playwright-best-practices/core/locators.md`: Use locators in this order of preference:
- `.claude/skills/playwright-best-practices/core/page-object-model.md`: Page Object Model encapsulates page structure and interactions, providing:
- `.claude/skills/playwright-best-practices/core/projects-dependencies.md`: Setup projects are the recommended way to handle authentication. They run before your main test projects and can use Playwright fixtures.
- `.claude/skills/playwright-best-practices/core/test-data.md`: This file covers **reusable test data builders** (factories, Faker, data generators). For related topics:
- `.claude/skills/playwright-best-practices/core/test-suite-structure.md`: Full user journey tests through the browser.
- `.claude/skills/playwright-best-practices/core/test-tags.md`
- `.claude/skills/playwright-best-practices/debugging/console-errors.md`
- `.claude/skills/playwright-best-practices/debugging/debugging.md`: Features:
- `.claude/skills/playwright-best-practices/debugging/error-testing.md`: This section covers **unexpected network failures** and error recovery. For **offline-first apps (PWAs)** with service workers, caching, and background sync, see [service-workers.md](service-workers.md#offline-testing).
- `.claude/skills/playwright-best-practices/debugging/flaky-tests.md`: Most flaky tests fall into distinct categories requiring different remediation:
- `.claude/skills/playwright-best-practices/frameworks/angular.md`: Angular generates internal attributes (`_ngcontent-*`, `_nghost-*`, `ng-reflect-*`) that change every build. Always use semantic locators.
- `.claude/skills/playwright-best-practices/frameworks/nextjs.md`: Next.js loads `.env.test` when `NODE_ENV=test`:
- `.claude/skills/playwright-best-practices/frameworks/react.md`: **Use when**: Verifying React context (theme, auth, locale) and state management (Redux, Zustand) produce correct UI changes. **Avoid when**: You want to assert on raw state objects—test the UI, not internal state.
- `.claude/skills/playwright-best-practices/frameworks/vue.md`: Nuxt uses port 3000 and requires a build step before testing.
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/ci-cd.md`
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/docker.md`: Run tests without building a custom image:
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/github-actions.md`: **Use when**: Starting a new project or running a small test suite.
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/gitlab.md`: **Use when**: Any GitLab project with Playwright tests.
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/other-providers.md`: All platforms benefit from JUnit output for native test result display:
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/parallel-sharding.md`: **Use when**: Controlling concurrent test execution on a single machine.
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/performance.md`: Tests are distributed evenly by file. For optimal sharding:
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/reporting.md`: Build custom reporters for Slack notifications, database logging, or dashboards.
- `.claude/skills/playwright-best-practices/infrastructure-ci-cd/test-coverage.md`
- `.claude/skills/playwright-best-practices/LICENSE.md`: Copyright © 2026 Currents Software Inc.
- `.claude/skills/playwright-best-practices/README.md`: <img src="https://currents.dev/favicon-96x96.png" width="24" height="24" align="left" />by [currents.dev](https://currents.dev?utm_source=ai-skill) - The all-in-one Dashboard for Playwright Testing.
- `.claude/skills/playwright-best-practices/testing-patterns/accessibility.md`
- `.claude/skills/playwright-best-practices/testing-patterns/api-testing.md`: **Use when**: Multiple tests need an authenticated API client with shared configuration. **Avoid when**: A single test makes one-off API calls — use the built-in `request` fixture directly.
- `.claude/skills/playwright-best-practices/testing-patterns/browser-extensions.md`
- `.claude/skills/playwright-best-practices/testing-patterns/canvas-webgl.md`
- `.claude/skills/playwright-best-practices/testing-patterns/component-testing.md`
- `.claude/skills/playwright-best-practices/testing-patterns/drag-drop.md`: Some drag libraries (react-beautiful-dnd, dnd-kit) require incremental mouse movements:
- `.claude/skills/playwright-best-practices/testing-patterns/electron.md`
- `.claude/skills/playwright-best-practices/testing-patterns/file-operations.md`
- `.claude/skills/playwright-best-practices/testing-patterns/file-upload-download.md`: Drop zones always have an underlying `input[type="file"]`—target it directly instead of simulating OS-level drag events.
- `.claude/skills/playwright-best-practices/testing-patterns/forms-validation.md`: **Use when**: Testing search fields, address lookups, mention pickers, or any input that shows suggestions as the user types.
- `.claude/skills/playwright-best-practices/testing-patterns/graphql-testing.md`: All GraphQL requests go through `POST` to a single endpoint. Send `query`, `variables`, and optionally `operationName` in the JSON body.
- `.claude/skills/playwright-best-practices/testing-patterns/i18n.md`
- `.claude/skills/playwright-best-practices/testing-patterns/performance-testing.md`
- `.claude/skills/playwright-best-practices/testing-patterns/security-testing.md`
- `.claude/skills/playwright-best-practices/testing-patterns/visual-regression.md`: **Use when**: Page contains timestamps, avatars, ad slots, relative dates, random images, or A/B variants.

## SEO optimization

Optimize for search engine visibility and ranking. Use when asked to "improve SEO", "optimize for search", "fix meta tags", "add structured data", "sitemap optimization", or "search engine optimization".

- `.claude/skills/seo/SKILL.md`

## shadcn/ui

Manages shadcn components and projects — adding, searching, fixing, debugging, styling, and composing UI. Provides project context, component docs, and usage examples. Applies when working with shadcn/ui, component registries, presets, --preset codes, or any project with a components.json file. A...

- `.claude/skills/shadcn/SKILL.md`
- `.claude/skills/shadcn/cli.md`: Configuration is read from `components.json`.
- `.claude/skills/shadcn/customization.md`: Components reference semantic CSS variable tokens. Change the variables to change every component.
- `.claude/skills/shadcn/mcp.md`: The CLI includes an MCP server that lets AI assistants search, browse, view, and install components from registries.
- `.claude/skills/shadcn/rules/base-vs-radix.md`: API differences between `base` and `radix`. Check the `base` field from `npx shadcn@latest info`.
- `.claude/skills/shadcn/rules/composition.md`: Never render items directly inside the content container.
- `.claude/skills/shadcn/rules/forms.md`: Always use `FieldGroup` + `Field` — never raw `div` with `space-y-*`:
- `.claude/skills/shadcn/rules/icons.md`: **Always use the project's configured `iconLibrary` for imports.** Check the `iconLibrary` field from project context: `lucide` → `lucide-react`, `tabler` → `@tabler/icons-react`, etc. Never assume `lucide-react`.
- `.claude/skills/shadcn/rules/styling.md`: See [customization.md](../customization.md) for theming, CSS variables, and adding custom colors.

## Tailwind CSS Development Patterns

Provides comprehensive Tailwind CSS utility-first styling patterns including responsive design, layout utilities, flexbox, grid, spacing, typography, colors, and modern CSS best practices. Use when styling React/Vue/Svelte components, building responsive layouts, implementing design systems, or o...

- `.claude/skills/tailwind-css-patterns/SKILL.md`
- `.claude/skills/tailwind-css-patterns/references/accessibility.md`
- `.claude/skills/tailwind-css-patterns/references/animations.md`: Usage:
- `.claude/skills/tailwind-css-patterns/references/component-patterns.md`
- `.claude/skills/tailwind-css-patterns/references/configuration.md`: Use the `@theme` directive for CSS-based configuration:
- `.claude/skills/tailwind-css-patterns/references/layout-patterns.md`: Basic flex container:
- `.claude/skills/tailwind-css-patterns/references/performance.md`: Configure content sources for optimal purging:
- `.claude/skills/tailwind-css-patterns/references/reference.md`: Tailwind CSS is a utility-first CSS framework that generates styles by scanning HTML, JavaScript, and template files for class names. It provides a comprehensive design system through CSS utility classes, enabling rapid UI development without writing custom CSS. The framework operates at build-ti...
- `.claude/skills/tailwind-css-patterns/references/responsive-design.md`: Enable dark mode in tailwind.config.js:

## Tailwind v4 + shadcn/ui Production Stack

|

- `.claude/skills/tailwind-v4-shadcn/SKILL.md`
- `.claude/skills/tailwind-v4-shadcn/references/advanced-usage.md`: **Purpose**: Advanced customization and component patterns for experienced Tailwind v4 + shadcn/ui developers **When to Load**: User asks for custom colors beyond defaults, advanced component patterns, composition best practices, or component customization
- `.claude/skills/tailwind-v4-shadcn/references/common-gotchas.md`: ❌ **WRONG:**
- `.claude/skills/tailwind-v4-shadcn/references/dark-mode.md`: Tailwind v4 + shadcn/ui dark mode requires: 1. `ThemeProvider` component to manage state 2. `.dark` class toggling on `<html>` element 3. localStorage persistence 4. System theme detection
- `.claude/skills/tailwind-v4-shadcn/references/migration-guide.md`: This guide helps you migrate from hardcoded Tailwind colors (`bg-blue-600`) to semantic CSS variables (`bg-primary`).
- `.claude/skills/tailwind-v4-shadcn/references/plugins-reference.md`: **Purpose**: Complete guide to Tailwind v4 official plugins (Typography, Forms) **When to Load**: User mentions prose class, Typography plugin, Forms plugin, @plugin directive, or plugin installation errors

## Turborepo Skill

|

- `.claude/skills/turborepo/SKILL.md`
- `.claude/skills/turborepo/command/turborepo.md`: Load Turborepo skill for creating workflows, tasks, and pipelines in monorepos. Use when users ask to "create a workflow", "make a task", "generate a pipeline", or set up build orchestration.
- `.claude/skills/turborepo/references/best-practices/dependencies.md`: Best practices for managing dependencies in a Turborepo monorepo.
- `.claude/skills/turborepo/references/best-practices/packages.md`: How to create and structure internal packages in your monorepo.
- `.claude/skills/turborepo/references/best-practices/RULE.md`: Essential patterns for structuring and maintaining a healthy Turborepo monorepo.
- `.claude/skills/turborepo/references/best-practices/structure.md`: Detailed guidance on structuring a Turborepo monorepo.
- `.claude/skills/turborepo/references/boundaries/RULE.md`: **Experimental feature** - See [RFC](https://github.com/vercel/turborepo/discussions/9435)
- `.claude/skills/turborepo/references/caching/gotchas.md`: Generates a JSON file with all hash inputs. Compare two runs to find differences.
- `.claude/skills/turborepo/references/caching/remote-cache.md`: Share cache artifacts across your team and CI pipelines.
- `.claude/skills/turborepo/references/caching/RULE.md`: Turborepo's core principle: **never do the same work twice**.
- `.claude/skills/turborepo/references/ci/github-actions.md`: Complete setup guide for Turborepo with GitHub Actions.
- `.claude/skills/turborepo/references/ci/patterns.md`: Strategies for efficient CI/CD with Turborepo.
- `.claude/skills/turborepo/references/ci/RULE.md`: General principles for running Turborepo in continuous integration environments.
- `.claude/skills/turborepo/references/ci/vercel.md`: Turborepo integrates seamlessly with Vercel for monorepo deployments.
- `.claude/skills/turborepo/references/cli/commands.md`: Full docs: https://turborepo.dev/docs/reference/run
- `.claude/skills/turborepo/references/cli/RULE.md`: The primary command for executing tasks across your monorepo.
- `.claude/skills/turborepo/references/configuration/global-options.md`: Options that affect all tasks. Full docs: https://turborepo.dev/docs/reference/configuration
- `.claude/skills/turborepo/references/configuration/gotchas.md`: Common mistakes and how to fix them.
- `.claude/skills/turborepo/references/configuration/RULE.md`: Configuration reference for Turborepo. Full docs: https://turborepo.dev/docs/reference/configuration
- `.claude/skills/turborepo/references/configuration/tasks.md`: Full docs: https://turborepo.dev/docs/reference/configuration#tasks
- `.claude/skills/turborepo/references/environment/gotchas.md`: Common mistakes and how to fix them.
- `.claude/skills/turborepo/references/environment/modes.md`: Turborepo supports different modes for handling environment variables during task execution.
- `.claude/skills/turborepo/references/environment/RULE.md`: Turborepo provides fine-grained control over which environment variables affect task hashing and runtime availability.
- `.claude/skills/turborepo/references/filtering/patterns.md`: Practical examples for typical monorepo scenarios.
- `.claude/skills/turborepo/references/filtering/RULE.md`: **The primary way to run only changed packages is `--affected`:**
- `.claude/skills/turborepo/references/watch/RULE.md`: Full docs: https://turborepo.dev/docs/reference/watch

## Setup

Configure TOTP authenticator apps, send OTP codes via email/SMS, manage backup codes, handle trusted devices, and implement 2FA sign-in flows using Better Auth's twoFactor plugin. Use when users need MFA, multi-factor authentication, authenticator setup, or login security with Better Auth.

- `.claude/skills/two-factor-authentication-best-practices/SKILL.md`

## TypeScript Advanced Types

Master TypeScript's advanced type system including generics, conditional types, mapped types, template literals, and utility types for building type-safe applications. Use when implementing complex type logic, creating reusable type utilities, or ensuring compile-time type safety in TypeScript pr...

- `.claude/skills/typescript-advanced-types/SKILL.md`

## React Composition Patterns

Composition patterns for building flexible, maintainable React components. Avoid boolean prop proliferation by using compound components, lifting state, and composing internals. These patterns make codebases easier for both humans and AI agents to work with as they scale.

- `.claude/skills/vercel-composition-patterns/SKILL.md`
- `.claude/skills/vercel-composition-patterns/AGENTS.md`: **Version 1.0.0** Engineering January 2026
- `.claude/skills/vercel-composition-patterns/README.md`: A structured repository for React composition patterns that scale. These patterns help avoid boolean prop proliferation by using compound components, lifting state, and composing internals.
- `.claude/skills/vercel-composition-patterns/rules/_sections.md`: This file defines all sections, their ordering, impact levels, and descriptions. The section ID (in parentheses) is the filename prefix used to group rules.
- `.claude/skills/vercel-composition-patterns/rules/_template.md`: Brief explanation of the rule and why it matters.
- `.claude/skills/vercel-composition-patterns/rules/architecture-avoid-boolean-props.md`: Don't add boolean props like `isThread`, `isEditing`, `isDMThread` to customize component behavior. Each boolean doubles possible states and creates unmaintainable conditional logic. Use composition instead.
- `.claude/skills/vercel-composition-patterns/rules/architecture-compound-components.md`: Structure complex components as compound components with a shared context. Each subcomponent accesses shared state via context, not props. Consumers compose the pieces they need.
- `.claude/skills/vercel-composition-patterns/rules/patterns-children-over-render-props.md`: Use `children` for composition instead of `renderX` props. Children are more readable, compose naturally, and don't require understanding callback signatures.
- `.claude/skills/vercel-composition-patterns/rules/patterns-explicit-variants.md`: Instead of one component with many boolean props, create explicit variant components. Each variant composes the pieces it needs. The code documents itself.
- `.claude/skills/vercel-composition-patterns/rules/react19-no-forwardref.md`: In React 19, `ref` is now a regular prop (no `forwardRef` wrapper needed), and `use()` replaces `useContext()`.
- `.claude/skills/vercel-composition-patterns/rules/state-context-interface.md`: Define a **generic interface** for your component context with three parts: can implement—enabling the same UI components to work with completely different state implementations.
- `.claude/skills/vercel-composition-patterns/rules/state-decouple-implementation.md`: The provider component should be the only place that knows how state is managed. UI components consume the context interface—they don't know if state comes from useState, Zustand, or a server sync.
- `.claude/skills/vercel-composition-patterns/rules/state-lift-state.md`: Move state management into dedicated provider components. This allows sibling components outside the main UI to access and modify state without prop drilling or awkward refs.

## Vercel React Best Practices

React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimizati...

- `.claude/skills/vercel-react-best-practices/SKILL.md`
- `.claude/skills/vercel-react-best-practices/AGENTS.md`: **Version 1.0.0** Vercel Engineering January 2026
- `.claude/skills/vercel-react-best-practices/README.md`: A structured repository for creating and maintaining React Best Practices optimized for agents and LLMs.
- `.claude/skills/vercel-react-best-practices/rules/_sections.md`: This file defines all sections, their ordering, impact levels, and descriptions. The section ID (in parentheses) is the filename prefix used to group rules.
- `.claude/skills/vercel-react-best-practices/rules/_template.md`: **Impact: MEDIUM (optional impact description)**
- `.claude/skills/vercel-react-best-practices/rules/advanced-effect-event-deps.md`: Effect Event functions do not have a stable identity. Their identity intentionally changes on every render. Do not include the function returned by `useEffectEvent` in a `useEffect` dependency array. Keep the actual reactive values as dependencies and call the Effect Event from inside the effect...
- `.claude/skills/vercel-react-best-practices/rules/advanced-event-handler-refs.md`: Store callbacks in refs when used in effects that shouldn't re-subscribe on callback changes.
- `.claude/skills/vercel-react-best-practices/rules/advanced-init-once.md`: Do not put app-wide initialization that must run once per app load inside `useEffect([])` of a component. Components can remount and effects will re-run. Use a module-level guard or top-level init in the entry module instead.
- `.claude/skills/vercel-react-best-practices/rules/advanced-use-latest.md`: Access latest values in callbacks without adding them to dependency arrays. Prevents effect re-runs while avoiding stale closures.
- `.claude/skills/vercel-react-best-practices/rules/async-api-routes.md`: In API routes and Server Actions, start independent operations immediately, even if you don't await them yet.
- `.claude/skills/vercel-react-best-practices/rules/async-cheap-condition-before-await.md`: When a branch uses `await` for a flag or remote value and also requires a **cheap synchronous** condition (local props, request metadata, already-loaded state), evaluate the cheap condition **first**. Otherwise you pay for the async call even when the compound condition can never be true.
- `.claude/skills/vercel-react-best-practices/rules/async-defer-await.md`: Move `await` operations into the branches where they're actually used to avoid blocking code paths that don't need them.
- `.claude/skills/vercel-react-best-practices/rules/async-dependencies.md`: For operations with partial dependencies, use `better-all` to maximize parallelism. It automatically starts each task at the earliest possible moment.
- `.claude/skills/vercel-react-best-practices/rules/async-parallel.md`: When async operations have no interdependencies, execute them concurrently using `Promise.all()`.
- `.claude/skills/vercel-react-best-practices/rules/async-suspense-boundaries.md`: Instead of awaiting data in async components before returning JSX, use Suspense boundaries to show the wrapper UI faster while data loads.
- `.claude/skills/vercel-react-best-practices/rules/bundle-barrel-imports.md`: Import directly from source files instead of barrel files to avoid loading thousands of unused modules. **Barrel files** are entry points that re-export multiple modules (e.g., `index.js` that does `export * from './module'`).
- `.claude/skills/vercel-react-best-practices/rules/bundle-conditional.md`: Load large data or modules only when a feature is activated.
- `.claude/skills/vercel-react-best-practices/rules/bundle-defer-third-party.md`: Analytics, logging, and error tracking don't block user interaction. Load them after hydration.
- `.claude/skills/vercel-react-best-practices/rules/bundle-dynamic-imports.md`: Use `next/dynamic` to lazy-load large components not needed on initial render.
- `.claude/skills/vercel-react-best-practices/rules/bundle-preload.md`: Preload heavy bundles before they're needed to reduce perceived latency.
- `.claude/skills/vercel-react-best-practices/rules/client-event-listeners.md`: Use `useSWRSubscription()` to share global event listeners across component instances.
- `.claude/skills/vercel-react-best-practices/rules/client-localstorage-schema.md`: Add version prefix to keys and store only needed fields. Prevents schema conflicts and accidental storage of sensitive data.
- `.claude/skills/vercel-react-best-practices/rules/client-passive-event-listeners.md`: Add `{ passive: true }` to touch and wheel event listeners to enable immediate scrolling. Browsers normally wait for listeners to finish to check if `preventDefault()` is called, causing scroll delay.
- `.claude/skills/vercel-react-best-practices/rules/client-swr-dedup.md`: SWR enables request deduplication, caching, and revalidation across component instances.
- `.claude/skills/vercel-react-best-practices/rules/js-batch-dom-css.md`: Avoid interleaving style writes with layout reads. When you read a layout property (like `offsetWidth`, `getBoundingClientRect()`, or `getComputedStyle()`) between style changes, the browser is forced to trigger a synchronous reflow.
- `.claude/skills/vercel-react-best-practices/rules/js-cache-function-results.md`: Use a module-level Map to cache function results when the same function is called repeatedly with the same inputs during render.
- `.claude/skills/vercel-react-best-practices/rules/js-cache-property-access.md`: Cache object property lookups in hot paths.
- `.claude/skills/vercel-react-best-practices/rules/js-cache-storage.md`: **Incorrect (reads storage on every call):**
- `.claude/skills/vercel-react-best-practices/rules/js-combine-iterations.md`: Multiple `.filter()` or `.map()` calls iterate the array multiple times. Combine into one loop.
- `.claude/skills/vercel-react-best-practices/rules/js-early-exit.md`: Return early when result is determined to skip unnecessary processing.
- `.claude/skills/vercel-react-best-practices/rules/js-flatmap-filter.md`: **Impact: LOW-MEDIUM (eliminates intermediate array)**
- `.claude/skills/vercel-react-best-practices/rules/js-hoist-regexp.md`: Don't create RegExp inside render. Hoist to module scope or memoize with `useMemo()`.
- `.claude/skills/vercel-react-best-practices/rules/js-index-maps.md`: Multiple `.find()` calls by the same key should use a Map.
- `.claude/skills/vercel-react-best-practices/rules/js-length-check-first.md`: When comparing arrays with expensive operations (sorting, deep equality, serialization), check lengths first. If lengths differ, the arrays cannot be equal.
- `.claude/skills/vercel-react-best-practices/rules/js-min-max-loop.md`: Finding the smallest or largest element only requires a single pass through the array. Sorting is wasteful and slower.
- `.claude/skills/vercel-react-best-practices/rules/js-request-idle-callback.md`: **Impact: MEDIUM (keeps UI responsive during background tasks)**
- `.claude/skills/vercel-react-best-practices/rules/js-set-map-lookups.md`: Convert arrays to Set/Map for repeated membership checks.
- `.claude/skills/vercel-react-best-practices/rules/js-tosorted-immutable.md`: **Incorrect (mutates original array):**
- `.claude/skills/vercel-react-best-practices/rules/rendering-activity.md`: Use React's `<Activity>` to preserve state/DOM for expensive components that frequently toggle visibility.
- `.claude/skills/vercel-react-best-practices/rules/rendering-animate-svg-wrapper.md`: Many browsers don't have hardware acceleration for CSS3 animations on SVG elements. Wrap SVG in a `<div>` and animate the wrapper instead.
- `.claude/skills/vercel-react-best-practices/rules/rendering-conditional-render.md`: Use explicit ternary operators (`? :`) instead of `&&` for conditional rendering when the condition can be `0`, `NaN`, or other falsy values that render.
- `.claude/skills/vercel-react-best-practices/rules/rendering-content-visibility.md`: Apply `content-visibility: auto` to defer off-screen rendering.
- `.claude/skills/vercel-react-best-practices/rules/rendering-hoist-jsx.md`: Extract static JSX outside components to avoid re-creation.
- `.claude/skills/vercel-react-best-practices/rules/rendering-hydration-no-flicker.md`: When rendering content that depends on client-side storage (localStorage, cookies), avoid both SSR breakage and post-hydration flickering by injecting a synchronous script that updates the DOM before React hydrates.
- `.claude/skills/vercel-react-best-practices/rules/rendering-hydration-suppress-warning.md`: In SSR frameworks (e.g., Next.js), some values are intentionally different on server vs client (random IDs, dates, locale/timezone formatting). For these _expected_ mismatches, wrap the dynamic text in an element with `suppressHydrationWarning` to prevent noisy warnings. Do not use this to hide r...
- `.claude/skills/vercel-react-best-practices/rules/rendering-resource-hints.md`: **Impact: HIGH (reduces load time for critical resources)**
- `.claude/skills/vercel-react-best-practices/rules/rendering-script-defer-async.md`: **Impact: HIGH (eliminates render-blocking)**
- `.claude/skills/vercel-react-best-practices/rules/rendering-svg-precision.md`: Reduce SVG coordinate precision to decrease file size. The optimal precision depends on the viewBox size, but in general reducing precision should be considered.
- `.claude/skills/vercel-react-best-practices/rules/rendering-usetransition-loading.md`: Use `useTransition` instead of manual `useState` for loading states. This provides built-in `isPending` state and automatically manages transitions.
- `.claude/skills/vercel-react-best-practices/rules/rerender-defer-reads.md`: Don't subscribe to dynamic state (searchParams, localStorage) if you only read it inside callbacks.
- `.claude/skills/vercel-react-best-practices/rules/rerender-dependencies.md`: Specify primitive dependencies instead of objects to minimize effect re-runs.
- `.claude/skills/vercel-react-best-practices/rules/rerender-derived-state-no-effect.md`: If a value can be computed from current props/state, do not store it in state or update it in an effect. Derive it during render to avoid extra renders and state drift. Do not set state in effects solely in response to prop changes; prefer derived values or keyed resets instead.
- `.claude/skills/vercel-react-best-practices/rules/rerender-derived-state.md`: Subscribe to derived boolean state instead of continuous values to reduce re-render frequency.
- `.claude/skills/vercel-react-best-practices/rules/rerender-functional-setstate.md`: When updating state based on the current state value, use the functional update form of setState instead of directly referencing the state variable. This prevents stale closures, eliminates unnecessary dependencies, and creates stable callback references.
- `.claude/skills/vercel-react-best-practices/rules/rerender-lazy-state-init.md`: Pass a function to `useState` for expensive initial values. Without the function form, the initializer runs on every render even though the value is only used once.
- `.claude/skills/vercel-react-best-practices/rules/rerender-memo-with-default-value.md`: When memoized component has a default value for some non-primitive optional parameter, such as an array, function, or object, calling the component without that parameter results in broken memoization. This is because new value instances are created on every rerender, and they do not pass strict...
- `.claude/skills/vercel-react-best-practices/rules/rerender-memo.md`: Extract expensive work into memoized components to enable early returns before computation.
- `.claude/skills/vercel-react-best-practices/rules/rerender-move-effect-to-event.md`: If a side effect is triggered by a specific user action (submit, click, drag), run it in that event handler. Do not model the action as state + effect; it makes effects re-run on unrelated changes and can duplicate the action.
- `.claude/skills/vercel-react-best-practices/rules/rerender-no-inline-components.md`: **Impact: HIGH (prevents remount on every render)**
- `.claude/skills/vercel-react-best-practices/rules/rerender-simple-expression-in-memo.md`: When an expression is simple (few logical or arithmetical operators) and has a primitive result type (boolean, number, string), do not wrap it in `useMemo`. Calling `useMemo` and comparing hook dependencies may consume more resources than the expression itself.
- `.claude/skills/vercel-react-best-practices/rules/rerender-split-combined-hooks.md`: When a hook contains multiple independent tasks with different dependencies, split them into separate hooks. A combined hook reruns all tasks when any dependency changes, even if some tasks don't use the changed value.
- `.claude/skills/vercel-react-best-practices/rules/rerender-transitions.md`: Mark frequent, non-urgent state updates as transitions to maintain UI responsiveness.
- `.claude/skills/vercel-react-best-practices/rules/rerender-use-deferred-value.md`: When user input triggers expensive computations or renders, use `useDeferredValue` to keep the input responsive. The deferred value lags behind, allowing React to prioritize the input update and render the expensive result when idle.
- `.claude/skills/vercel-react-best-practices/rules/rerender-use-ref-transient-values.md`: When a value changes frequently and you don't want a re-render on every update (e.g., mouse trackers, intervals, transient flags), store it in `useRef` instead of `useState`. Keep component state for UI; use refs for temporary DOM-adjacent values. Updating a ref does not trigger a re-render.
- `.claude/skills/vercel-react-best-practices/rules/server-after-nonblocking.md`: Use Next.js's `after()` to schedule work that should execute after a response is sent. This prevents logging, analytics, and other side effects from blocking the response.
- `.claude/skills/vercel-react-best-practices/rules/server-auth-actions.md`: **Impact: CRITICAL (prevents unauthorized access to server mutations)**
- `.claude/skills/vercel-react-best-practices/rules/server-cache-lru.md`: **Implementation:**
- `.claude/skills/vercel-react-best-practices/rules/server-cache-react.md`: Use `React.cache()` for server-side request deduplication. Authentication and database queries benefit most.
- `.claude/skills/vercel-react-best-practices/rules/server-dedup-props.md`: **Impact: LOW (reduces network payload by avoiding duplicate serialization)**
- `.claude/skills/vercel-react-best-practices/rules/server-hoist-static-io.md`: **Impact: HIGH (avoids repeated file/network I/O per request)**
- `.claude/skills/vercel-react-best-practices/rules/server-no-shared-module-state.md`: For React Server Components and client components rendered during SSR, avoid using mutable module-level variables to share request-scoped data. Server renders can run concurrently in the same process. If one render writes to shared module state and another render reads it, you can get race condit...
- `.claude/skills/vercel-react-best-practices/rules/server-parallel-fetching.md`: React Server Components execute sequentially within a tree. Restructure with composition to parallelize data fetching.
- `.claude/skills/vercel-react-best-practices/rules/server-parallel-nested-fetching.md`: When fetching nested data in parallel, chain dependent fetches within each item's promise so a slow item doesn't block the rest.
- `.claude/skills/vercel-react-best-practices/rules/server-serialization.md`: The React Server/Client boundary serializes all object properties into strings and embeds them in the HTML response and subsequent RSC requests. This serialized data directly impacts page weight and load time, so **size matters a lot**. Only pass fields that the client actually uses.

## Core

Vitest fast unit testing framework powered by Vite with Jest-compatible API. Use when writing tests, mocking, configuring coverage, or working with test filtering and fixtures.

- `.claude/skills/vitest/SKILL.md`
- `.claude/skills/vitest/GENERATION.md`
- `.claude/skills/vitest/references/advanced-environments.md`: Configure environments like jsdom, happy-dom for browser APIs
- `.claude/skills/vitest/references/advanced-projects.md`: Multi-project configuration for monorepos and different test types
- `.claude/skills/vitest/references/advanced-type-testing.md`: Test TypeScript types with expectTypeOf and assertType
- `.claude/skills/vitest/references/advanced-vi.md`: vi helper for mocking, timers, utilities
- `.claude/skills/vitest/references/core-cli.md`: Command line interface commands and options
- `.claude/skills/vitest/references/core-config.md`: Configure Vitest with vite.config.ts or vitest.config.ts
- `.claude/skills/vitest/references/core-describe.md`: describe/suite for grouping tests into logical blocks
- `.claude/skills/vitest/references/core-expect.md`: Assertions with matchers, asymmetric matchers, and custom matchers
- `.claude/skills/vitest/references/core-hooks.md`: beforeEach, afterEach, beforeAll, afterAll, and around hooks
- `.claude/skills/vitest/references/core-test-api.md`: test/it function for defining tests with modifiers
- `.claude/skills/vitest/references/features-concurrency.md`: Concurrent tests, parallel execution, and sharding
- `.claude/skills/vitest/references/features-context.md`: Test context, custom fixtures with test.extend
- `.claude/skills/vitest/references/features-coverage.md`: Code coverage with V8 or Istanbul providers
- `.claude/skills/vitest/references/features-filtering.md`: Filter tests by name, file patterns, and tags
- `.claude/skills/vitest/references/features-mocking.md`: Mock functions, modules, timers, and dates with vi utilities
- `.claude/skills/vitest/references/features-snapshots.md`: Snapshot testing with file, inline, and file snapshots

<!-- autoskills:end -->
