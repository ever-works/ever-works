---
name: ever-works
description: >-
    Repo-specific guide to the Ever Works monorepo (ever-works/ever-works) — its
    pnpm + Turborepo layout, the per-workspace test runners (Jest vs Vitest vs
    Playwright), file-naming and import-alias conventions, the commit/branch
    model, and the real build/lint/type-check commands. Use this whenever working
    anywhere in this repository so changes match the codebase's actual conventions
    and pass CI.
---

# Ever Works monorepo

**Ever Works** is an open-source, AI-powered work/content builder platform — an
open agentic runtime that researches, ships, and maintains content-rich websites
and Git repositories.

**Read the repo's own instructions first.** `AGENTS.md` (repo root) routes agents
to `CLAUDE.md` (repo root), which is the **canonical, authoritative** rule set.
This skill is a concise summary of those files plus conventions verified from the
code. If anything here ever diverges from `CLAUDE.md`, **`CLAUDE.md` wins** — do
not treat this skill as a replacement for it.

## Monorepo layout (Turborepo + pnpm workspaces)

Workspaces are `apps/*`, `packages/*`, and `packages/plugins/*`; Turborepo orders
builds via `^build`.

- `apps/api` — NestJS 11 REST API (SWC compiler, TypeORM, JWT + OAuth). Dev port 3100.
- `apps/web` — Next.js 16 App Router (React 19, Tailwind CSS 4, next-intl). Dev port 3000.
- `apps/cli` — public CLI (esbuild + commander); `apps/internal-cli` — internal NestJS CLI (nest-commander).
- `apps/admin` — admin interface; `apps/mcp` — Model Context Protocol server; `apps/docs` — Docusaurus 3 site (renders the root `docs/`).
- `packages/plugin` — plugin-system contracts & utilities (ESM, tsup); `packages/contracts` — shared TypeScript types (ESM, tsup).
- `packages/agent` — `@ever-works/agent`, the core AI agent logic (NestJS + SWC), 21 sub-module exports; consumed by the API.
- `packages/plugins/*` — 39 provider plugins (ai-provider, ai-gateway, search, content-extractor, screenshot, git-provider, deployment, pipeline, …). Each is ESM, built with tsup, tested with Vitest.
- `packages/tasks` — Trigger.dev background jobs; `packages/monitoring` — Sentry + PostHog; `packages/cli-shared` — shared CLI utilities.
- `docs/` — markdown docs content; `.specify/` — GitHub Spec Kit (feature specs live under `docs/specs/features/`).

## Commands (pnpm only — never npm/yarn; Node >= 22)

```bash
pnpm install
pnpm dev:web            # Next.js app on :3000 (next dev --turbopack)
pnpm dev:api            # NestJS API on :3100
pnpm build              # Turborepo build (excludes apps/docs)
pnpm build:web          # single target; also build:api, build:plugins, build:packages
pnpm type-check         # tsc --noEmit across all workspaces
pnpm lint               # ESLint (flat config, eslint.config.mjs — ESLint 9)
pnpm format             # Prettier (format:check to verify only)
pnpm test               # All unit tests (turbo fans out to each workspace's runner)
pnpm test:e2e           # Web Playwright e2e
```

Package manager is pinned: `pnpm@10.33.3`. Run `pnpm install` after adding deps.

## Testing (three runners — use the one the package uses)

Ever Works uses Jest **and** Vitest, split by build tooling (see the repo's own
`docs/testing/overview.md`), plus Playwright for web e2e:

- **Jest** — `packages/agent` (~26 suites / ~719 tests, `packages/agent/jest.config.js`) and `apps/api` (`apps/api/jest.config.js`). These are the SWC/NestJS packages. Test files are `*.spec.ts`.
    - `cd packages/agent && pnpm test` · `pnpm test:cov` · `npx jest --testPathPattern='generators'`
    - `cd apps/api && pnpm test`
- **Vitest** — `packages/plugin`, every `packages/plugins/*`, and `apps/web` unit tests. Test files are `*.spec.ts`.
    - `cd packages/plugins/openai && pnpm test` · `npx vitest run src/openai.spec.ts`
    - `cd apps/web && pnpm test` (web unit)
- **Playwright** — `apps/web` end-to-end. Specs in `apps/web/e2e/*.spec.ts`, config `apps/web/playwright.config.ts`.
    - `cd apps/web && pnpm test:e2e` (or `pnpm test:e2e` from the repo root)
- Root `pnpm test` runs `turbo run test`, delegating to each workspace's own runner.

## File & symbol naming

Follow the "Code Style → Naming" section of `CLAUDE.md` as authoritative. Verified
across the tree, the working rules are:

- **kebab-case** for all non-component TypeScript files: NestJS `*.service.ts`, `*.controller.ts`, `*.module.ts`, `*.dto.ts`, entities, guards, and shared/agent modules (e.g. `tenant-job-runtime.service.ts`, `account-import.service.ts`); web hooks are `use-*.ts` (e.g. `use-local-storage.ts`); `lib/` and utility files are kebab-case too.
- **PascalCase** for React component files under `apps/web/src/components/**` and `apps/docs/src/theme/**` (e.g. `ActivityTable.tsx`, `AgentActivityClient.tsx`). This is the dominant convention for components (~340 files).
- **lowercase reserved names** for Next.js App Router files — `page.tsx`, `layout.tsx`, `loading.tsx`, `route.ts`, etc. (framework-required).
- **Symbols:** PascalCase for classes / interfaces / types, camelCase for functions / variables, UPPER_SNAKE_CASE for constants.
- A few legacy files deviate (a camelCase hook, a kebab-case component). When unsure, match the sibling files in the directory you are editing and defer to `CLAUDE.md`.

## Imports & path aliases

- `@/*` → `apps/web/src/*` (web). e.g. `import { APP_NAME } from '@/lib/constants'`.
- `@src/*` → `apps/api/src/*` (api).
- `@ever-works/*` → workspace packages. e.g. `import { BasePlugin } from '@ever-works/plugin'`; plugins also import sub-paths such as `@ever-works/plugin/abstract` and `@ever-works/plugin/ai`.
- Use relative imports within the same feature folder. There is **no** import-renaming convention (`import { X as Y }`) — do not introduce one.

## Code style

- **Prettier** formats the repo. The root `package.json` config (tabs, print width 120, single quotes, semicolons, no trailing commas) takes precedence over the per-package `.prettierrc` (spaces, width 100). Run `pnpm format`; don't hand-fight it.
- **TypeScript strict**, ESLint 9 flat config (`eslint.config.mjs`).

## Commits & branches

- **Conventional Commits**, enforced by commitlint (`@commitlint/config-conventional`, run via husky): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:` (plus the standard `build`, `ci`, `perf`, `style`, `revert`). Scopes are welcome, e.g. `feat(api): …`.
- **Branches:** `develop` (default / integration) → `stage` → `main` (production). Promote changes **forward through the cascade** — open a PR from `develop` → `stage`, then `stage` → `main`; the repo uses dedicated `cascade/*` branches for these promotions. Merge the whole branch forward rather than cherry-picking individual commits.

## Deployment (do not run ad-hoc deploy commands)

Apps ship as containers (`node:22-alpine`) to Kubernetes via GitOps. The API
self-applies pending TypeORM migrations on boot (`migrationsRun`, gated by the
`RUN_MIGRATIONS` env). Trigger.dev tasks deploy via `pnpm deploy:trigger`. Do not
invent or run other deploy / `kubectl` commands from this repository.

## Gotchas

- **Web build uses Webpack, not Turbopack.** `apps/web` builds with `next build --webpack` (dev uses `--turbopack`). Keep the `--webpack` flag on the build script.
- **Build shared packages before type-checking / testing.** `@ever-works/contracts` and `@ever-works/plugin` must be built (`pnpm build` / `pnpm build:plugins`) before `apps/web` type-check or agent tests can resolve them. The agent Jest config also maps those packages to source via `moduleNameMapper` — if test imports fail, build first.
- **TypeORM migrations ship with entity changes.** Any entity/schema change needs a migration in the **same PR** (`apps/api/src/migrations/`). See `docs/specs/architecture/database-migrations.md`.
- **DTS build failure with conditional spreads.** `...cond && { key: value }` yields `string | false` and breaks declaration emit — use explicit `if` blocks to add properties conditionally.
- **No stray docs in the repo root.** Working/plan/summary/tracker markdown goes under `docs/internal/` (or `docs/specs/<feature>/`), never the root — see `AGENTS.md` / `CLAUDE.md`.

## UI & design patterns

Canonical CTA rules (light vs dark mode) and KPI / stat-card rules live in
[`references/ui-patterns.md`](references/ui-patterns.md). Follow them for
`apps/web` UI work.

## Authoritative source

`AGENTS.md` → `CLAUDE.md` (repo root) are the source of truth; `AUGMENT.md` and
`.github/copilot-instructions.md` add tool-specific notes. Prefer updating
`CLAUDE.md` over duplicating rules here.
