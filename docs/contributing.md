---
id: contributing
title: Contributing Guide
sidebar_label: Contributing
sidebar_position: 14
---

# Contributing Guide

Thank you for your interest in contributing to Ever Works. This guide covers everything you need to know to make meaningful contributions to the project, whether you are fixing a bug, adding a feature, improving documentation, or building a new plugin.

## Repositories

Ever Works is split across multiple repositories under the [ever-works](https://github.com/ever-works) GitHub organization:

| Repository                                                                               | Description                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [ever-works](https://github.com/ever-works/ever-works)                                   | Platform monorepo (API, Web Dashboard, CLI, AI agents, plugins) |
| [ever-works-website-template](https://github.com/ever-works/ever-works-website-template) | Standalone Next.js work website template                        |
| [ever-works/docs](https://github.com/ever-works/ever-works/tree/main/docs)               | Documentation source for this site (inside the monorepo)        |

Each repository has its own issue tracker. File issues in the repository most relevant to your contribution.

:::note The documentation is not a separate repository

Every page on **docs.ever.works** is a Markdown file under `docs/` in the `ever-works` monorepo, rendered by the Docusaurus app in `apps/docs/`. `apps/docs/docusaurus.config.ts` sets `path: '../../docs/'` and `routeBasePath: '/'`, and points `editUrl` at `https://github.com/ever-works/ever-works/tree/main/` — which is why the **Edit this page** link at the bottom of any page opens the exact source file in `ever-works`. Run the site locally with `pnpm dev:docs`, and open documentation issues and PRs against `ever-works`.

:::

## Prerequisites

Before you begin, make sure you have the following installed:

- **Node.js** >= 22 (LTS recommended; matches the `node:22-alpine` Docker base image and the root `package.json` engines field)
- **pnpm** >= 10.x (strictly enforced; do not use npm or yarn)
- **Git** >= 2.30
- **Docker** (optional, for running the Platform locally with containers)
- **PostgreSQL** (optional, for Template development with a real database; SQLite works for local dev)

### Installing pnpm

If you do not already have pnpm installed:

```bash
# Using corepack (recommended, ships with Node.js 20+)
corepack enable
corepack prepare pnpm@latest --activate

# Or via npm (one-time bootstrap)
npm install -g pnpm
```

**Important:** The repositories use `packageManager` fields and lockfiles that are specific to pnpm. Running `npm install` or `yarn install` will fail or produce incorrect dependency trees.

## Development Setup

### Platform (Monorepo)

```bash
git clone https://github.com/ever-works/ever-works.git
cd ever-works
pnpm install

# Start every app in watch mode (docs and the desktop apps are excluded)
pnpm dev:apps

# Or start individual apps
pnpm dev:api     # NestJS API on port 3100
pnpm dev:web     # Next.js Web Dashboard on port 3000
pnpm dev:docs    # Docusaurus documentation site (this site)
```

The `dev:*` scripts in the root `package.json` are thin wrappers over Turborepo filters — `pnpm dev:docs` runs `turbo run dev --filter=ever-works-docs`, which runs `docusaurus start` in `apps/docs/`.

### Template (Standalone)

```bash
git clone https://github.com/ever-works/ever-works-website-template.git
cd ever-works-website-template
pnpm install

# Copy environment file and configure
cp .env.example .env.local
# Edit .env.local with your values (see README for details)

pnpm dev        # Next.js dev server on port 3000
```

## Code Standards

### TypeScript

Both repositories use TypeScript everywhere. Do not introduce plain `.js` files. Follow strict TypeScript practices:

- Enable and respect `strict` mode settings in `tsconfig.json`
- Prefer explicit return types on exported functions
- Use `unknown` over `any` where possible
- Validate input with **Zod** (Template) or **class-validator** (Platform)

### Formatting (Prettier)

Formatting is enforced via Prettier. The configuration lives in the root `package.json` of each repository:

```json
{
	"printWidth": 120,
	"singleQuote": true,
	"semi": true,
	"useTabs": true,
	"tabWidth": 4,
	"arrowParens": "always",
	"trailingComma": "none",
	"quoteProps": "as-needed"
}
```

Key rules:

- **Indentation:** Tabs with a width of 4 (except SCSS and YAML files, which use 2 spaces)
- **Print width:** 120 characters
- **Quotes:** Single quotes
- **Semicolons:** Always
- **Trailing commas:** None

Run the formatter before committing:

```bash
pnpm format          # Format all files
pnpm format:check    # Check without modifying (CI-friendly)
```

### Linting (ESLint)

ESLint is configured per repository. Run it with:

```bash
pnpm lint
```

The Platform uses ESLint with TypeScript-specific rules across all workspaces. The Template uses the flat ESLint config (`eslint.config.mjs`) with React, React Hooks, and TypeScript plugins.

### Naming Conventions

| Element                    | Convention       | Example                               |
| -------------------------- | ---------------- | ------------------------------------- |
| Files                      | kebab-case       | `auth.service.ts`, `user-profile.tsx` |
| Classes, Interfaces, Types | PascalCase       | `WorkService`, `UserProfile`          |
| Functions, Variables       | camelCase        | `getWorkById`, `itemCount`            |
| Constants                  | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `DEFAULT_LOCALE`   |

## Commit Conventions

Both repositories enforce [Conventional Commits](https://www.conventionalcommits.org/) via **commitlint** and **husky** pre-commit hooks.

Use the following commit prefixes:

| Prefix      | Usage                                      |
| ----------- | ------------------------------------------ |
| `feat:`     | New features                               |
| `fix:`      | Bug fixes                                  |
| `docs:`     | Documentation changes                      |
| `refactor:` | Code restructuring without behavior change |
| `test:`     | Adding or updating tests                   |
| `chore:`    | Maintenance tasks, dependency updates      |
| `style:`    | Formatting changes (no logic change)       |
| `perf:`     | Performance improvements                   |
| `ci:`       | CI/CD configuration changes                |

Example:

```bash
git commit -m "feat: add search filtering by category in work listing"
git commit -m "fix: resolve null pointer in plugin loader when config is missing"
```

## Branch Naming

Use descriptive branch names with a prefix that matches the type of work:

```
feat/add-category-filter
fix/plugin-loader-null-check
docs/update-contributing-guide
refactor/simplify-auth-middleware
```

## Pull Request Process

1. **Fork** the repository (or create a branch if you have write access).
2. **Create a feature branch** from `develop` (Platform) or `main` (Template).
3. **Make your changes** following the code standards above.
4. **Run quality checks** before pushing (see below).
5. **Push** your branch and open a Pull Request against the base branch.
6. **Fill out the PR template** with a description of your changes, related issues, and testing notes.
7. **Wait for review.** A maintainer will review your PR and may request changes.
8. Once approved, a maintainer will merge your PR.

### Quality Checks Before Submitting a PR

Run all of the following from the repository root:

```bash
# Platform
pnpm lint           # ESLint across all workspaces
pnpm type-check     # TypeScript compilation check
pnpm format:check   # Prettier format verification
pnpm test           # All tests (Jest for agent, Vitest for plugins)

# Template
pnpm lint           # ESLint
pnpm tsc --noEmit   # TypeScript check
pnpm build          # Full production build
```

### Testing Requirements

- **Platform agent package:** Uses **Jest** (26 test suites, 700+ tests). Run with `cd packages/agent && pnpm test`.
- **Platform plugins:** Use **Vitest**. Run with `cd packages/plugins/<name> && pnpm test`.
- **Platform API:** Uses **Jest**. Run with `cd apps/api && pnpm test`.
- **Template:** Uses **Playwright** for end-to-end tests. Run with `pnpm test:e2e`.

If your changes touch existing functionality, ensure all related tests pass. If you add new functionality, include tests for it.

## Plugin Contributions

The Platform has an extensible plugin system. Plugins live in `packages/plugins/` and are standalone ESM packages. To contribute a new plugin:

1. Use an existing plugin as a reference (e.g., `packages/plugins/openai`).
2. Define metadata in your plugin's `package.json` under the `everworks.plugin` field.
3. Implement the required interfaces from `@ever-works/plugin`.
4. Build with **tsup** and test with **Vitest**.
5. Document any required environment variables or API keys.

See the [Plugin System documentation](/plugin-system) for architecture details.

## Documentation Contributions

Documentation is not a side repository you have to hunt for: it is `docs/**` in the platform monorepo, and a docs change is an ordinary PR against `ever-works`.

| Path                            | What lives there                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `docs/`                         | Every published page, as Markdown. `docs/index.md` is the site home (`routeBasePath: '/'`).      |
| `docs/features/`                | User-facing feature pages (Agents, Missions, Knowledge Base, …).                                 |
| `docs/guides/`                  | Task-oriented how-to guides.                                                                     |
| `docs/api/`, `docs/cli/`        | Reference for the REST API and the CLI.                                                          |
| `docs/assets/`                  | Images and other static files, registered via `staticDirectories` and served from the site root. |
| `docs/specs/`, `docs/internal/` | Internal specs and working docs. Real pages, deliberately left out of the sidebar.               |
| `apps/docs/`                    | The Docusaurus site itself: `docusaurus.config.ts`, `sidebarsPlatform.ts`, theme, translations.  |

### How to add or edit a page

1. Install once from the monorepo root with `pnpm install`, then start the docs site with `pnpm dev:docs`. It serves on `http://localhost:3000`; if the web dashboard already holds that port, run `pnpm --filter ever-works-docs dev -- --port 3200` instead. Edits hot-reload.
2. Create or edit the Markdown file under `docs/`. Put user-facing pages in the folder that matches their area, internal plans and hand-off notes in `docs/internal/`, and feature specs in `docs/specs/<feature>/`. Never leave a working document in the monorepo root.
3. Give every new page frontmatter that matches its neighbours — `id`, `title`, `sidebar_label`, and an optional `description` — then open with an H1 that repeats the title.
4. Link to other pages with **relative Markdown paths** (`./missions.md`, `../features/agents.md`). Docusaurus rewrites them to site URLs and reports the ones that no longer resolve.
5. Add the page's `id` to `apps/docs/sidebarsPlatform.ts`. The sidebar is hand-maintained: a file that is not listed still builds and is still reachable by URL, but it never appears in the navigation — which is exactly how `docs/specs/` and `docs/internal/` stay off the nav.
6. Use standard Markdown tables for reference material, and fenced code blocks tagged `mermaid` for diagrams — Mermaid is enabled through `@docusaurus/theme-mermaid` and `markdown.mermaid: true`, so no extra setup is needed. Admonitions (`:::note`, `:::caution`, `:::tip`) are available.
7. Reference images from `docs/assets/`. That folder is a Docusaurus static directory, so `docs/assets/overview.png` is served as `/overview.png`.

### Checks to run before opening a docs PR

```bash
# From the monorepo root
pnpm format                              # Prettier — its glob covers **/*.md
pnpm format:check                        # Exactly what CI runs
pnpm build:docs                          # turbo run build --filter=ever-works-docs
pnpm --filter ever-works-docs spellcheck # cspell over apps/docs (config: apps/docs/.cspell.json)
```

Three details are easy to get caught by:

- **Prettier owns Markdown.** The root `format` script globs `**/*.{ts,tsx,jsx,json,css,md}`, and the CI job runs `pnpm format:check`, so an unformatted table or a trailing space fails the build like any other file.
- **The docs build is not part of `pnpm build`.** Both the root `build` script and the CI build step pass `--filter=!./apps/docs`, so the site is only compiled when you run `pnpm build:docs` (or `pnpm build:all`). Run it yourself before you push.
- **Broken links warn, they do not fail.** `onBrokenLinks` and `onBrokenMarkdownLinks` are both set to `warn`, so a bad relative link ships silently unless you read the build output.

### Translations

The site is internationalized with the Docusaurus `i18n` plugin. Translations live in `apps/docs/i18n/`, and `DOCS_BUILD_LOCALES` decides which locales are actually built — it defaults to `en,fr` because building every aspirational locale produced thousands of untranslated duplicate pages and exhausted the CI disk. To add strings for a locale, run `pnpm --filter ever-works-docs write-translations`, translate the generated JSON, then build with `DOCS_BUILD_LOCALES=en,fr,<locale> pnpm build:docs`.

### How a docs change reaches docs.ever.works

Merging to `main` triggers `.github/workflows/k8s-build.yml`, which rebuilds the `ever-works-docs` image from `.deploy/docker/docs/Dockerfile` and pushes `:prod` and `:sha-<sha>` tags to GHCR. The `docs-ever-works-prod` ArgoCD application tracks the `:prod` tag by digest and rolls the site out. Nothing has to be deployed by hand.

## License

- **Ever Works Platform** and **Work Web Template** are licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. This applies to all packages in `apps/` and `packages/`, including the **Plugin SDK** (`@ever-works/plugin` and `@ever-works/contracts`) and all first-party plugins.
- The only exception is the **public CLI** (`apps/cli`), which is released under the **MIT** license so it can be freely embedded in projects with any license.
- By submitting a contribution, you agree that your work will be licensed under the same license as the repository you are contributing to.

## Code of Conduct

All contributors are expected to follow the project's Code of Conduct. Be respectful, constructive, and collaborative. Harassment, discrimination, and disruptive behavior will not be tolerated.

## Getting Help

If you have questions about contributing:

- Open a [GitHub Discussion](https://github.com/ever-works/ever-works/discussions) for general questions
- Join the [Discord community](https://discord.gg/ever) for real-time help
- Email [ever@ever.co](mailto:ever@ever.co) for private inquiries

## Related

- [Installation](./installation.md) — get the monorepo running before you change it
- [Development Workflow](./development-workflow.md) — the day-to-day commands, debugging, and quality loop
- [Monorepo Structure](./monorepo-structure.md) — what lives in which `apps/*` and `packages/*` workspace
- [Testing Overview](./testing/overview.md) — the per-workspace test runners and how to run them
- [Plugin System](./plugin-system/index.md) · [Plugin Development Guide](./advanced/plugin-development-guide.md)
- [Support](/support) · [Changelog](./changelog.md)
