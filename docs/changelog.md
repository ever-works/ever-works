---
id: changelog
title: Changelog & Versioning
sidebar_label: Changelog
sidebar_position: 15
---

# Changelog & Versioning

This page explains how Ever Works manages versioning, releases, and upgrade paths across the Platform and Template repositories.

## Semantic Versioning

Both the Platform and Template follow [Semantic Versioning (SemVer)](https://semver.org/). Version numbers use the format **MAJOR.MINOR.PATCH**:

| Component | When to increment                                    |
| --------- | ---------------------------------------------------- |
| **MAJOR** | Breaking changes that require migration steps        |
| **MINOR** | New features added in a backward-compatible manner   |
| **PATCH** | Backward-compatible bug fixes and minor improvements |

Pre-release versions may use suffixes like `-alpha.1`, `-beta.2`, or `-rc.1` for early testing.

## Platform Versioning

The Ever Works Platform is organized as a **Turborepo monorepo** with multiple independently versioned packages and applications.

### Monorepo Package Structure

Each workspace package maintains its own version in its `package.json`:

```
apps/
  api/              # e.g., 0.1.0
  web/              # e.g., 0.1.0
  cli/              # e.g., 0.1.0
packages/
  agent/            # e.g., 0.1.0
  plugin/           # e.g., 0.1.0
  contracts/        # e.g., 0.1.0
  plugins/openai/   # e.g., 0.1.0
  plugins/anthropic/# e.g., 0.1.0
  ...
```

### Why Independent Versions?

Independent versioning allows individual packages to evolve at their own pace. A bug fix in the OpenAI plugin does not require bumping the version of the API application. This is standard practice in large monorepos managed by Turborepo and pnpm workspaces.

### Database Migrations (Platform)

The Platform API uses **TypeORM** for database management. Migrations are generated and applied through the TypeORM CLI:

```bash
# Generate a migration from entity changes
cd apps/api
pnpm typeorm migration:generate -d typeorm.config.ts

# Apply pending migrations
pnpm typeorm migration:run -d typeorm.config.ts
```

Migrations are stored in the `apps/api/src/migrations/` work and are tracked in version control. Each migration has a timestamp-based name and includes both `up` and `down` methods for forward and rollback operations.

## Template Versioning

The Work Web Template is a **standalone Next.js application** with a single version in its root `package.json`.

### Database Migrations (Template)

The Template uses **Drizzle ORM** with PostgreSQL. Database schema changes are managed through Drizzle Kit:

```bash
# Generate migration files from schema changes
pnpm db:generate

# Apply migrations to the database
pnpm db:migrate

# Open Drizzle Studio for visual database management
pnpm db:studio
```

Migration files are stored in the `lib/db/migrations/` work. Each migration is a SQL file generated from changes to the Drizzle schema definitions in `lib/db/schema/`.

### Migration-Based Upgrades

When upgrading the Template to a newer version:

1. Pull the latest changes from the repository.
2. Run `pnpm install` to update dependencies.
3. Run `pnpm db:generate` to check for new schema changes.
4. Run `pnpm db:migrate` to apply any pending migrations.
5. Run `pnpm build` to verify the build succeeds.

## Tracking Releases

### GitHub Releases

Both repositories publish releases on GitHub:

- **Platform:** [github.com/ever-works/ever-works/releases](https://github.com/ever-works/ever-works/releases)
- **Template:** [github.com/ever-works/ever-works-website-template/releases](https://github.com/ever-works/ever-works-website-template/releases)

Each release includes:

- A version tag (e.g., `v0.1.0`)
- Release notes describing changes, new features, bug fixes, and breaking changes
- Links to relevant pull requests and issues

### Commit History

Both repositories use [Conventional Commits](https://www.conventionalcommits.org/), making it easy to scan the commit history for changes:

```bash
# View recent commits with conventional commit prefixes
git log --oneline --since="2025-01-01"

# Filter for feature commits only
git log --oneline --grep="^feat:"

# Filter for breaking changes
git log --oneline --grep="BREAKING CHANGE"
```

## Breaking Changes Policy

Breaking changes are taken seriously. The project follows these principles:

1. **Advance notice.** Breaking changes are announced at least one minor release before they take effect, when possible. Deprecation warnings are added to code and documentation.

2. **Migration guides.** Every breaking change includes a migration guide in the release notes explaining what changed and how to update your code.

3. **Minimize disruption.** Breaking changes are batched into major releases rather than spread across multiple minor releases.

4. **Database backward compatibility.** Migrations are designed to be non-destructive. Column additions and table creations are preferred over column removals or renames. When destructive changes are necessary, a multi-step migration path is provided.

### Examples of Breaking Changes

The following types of changes are considered breaking:

- Removing or renaming a public API endpoint
- Changing the shape of API request or response bodies
- Removing or renaming database columns or tables
- Changing required environment variables
- Dropping support for a Node.js version
- Changing authentication or authorization behavior
- Removing or renaming exported TypeScript types or interfaces

### Examples of Non-Breaking Changes

The following are not considered breaking:

- Adding new API endpoints
- Adding new optional fields to request or response bodies
- Adding new database columns with default values
- Adding new environment variables with sensible defaults
- Adding new features or plugins
- Performance improvements
- Bug fixes (unless the bug was being relied upon)

## Upgrade Paths

### Upgrading the Platform

```bash
cd ever-works

# Pull latest changes
git pull origin develop

# Install updated dependencies
pnpm install

# Rebuild all packages (Turborepo handles dependency ordering)
pnpm build

# Run database migrations for the API
cd apps/api
pnpm typeorm migration:run -d typeorm.config.ts
```

### Upgrading the Template

```bash
cd ever-works-website-template

# Pull latest changes
git pull origin main

# Install updated dependencies
pnpm install

# Apply database migrations
pnpm db:migrate

# Verify build
pnpm build
```

### Handling Conflicts During Upgrades

If you have customized the Template, you may encounter merge conflicts when pulling updates. The recommended approach:

1. **Keep customizations in separate files** when possible (custom components, new routes, additional services).
2. **Use the Git-based CMS** for content changes rather than modifying core files.
3. **Review release notes** before upgrading to understand what files have changed.
4. **Test thoroughly** after resolving conflicts by running `pnpm lint`, `pnpm tsc --noEmit`, and `pnpm build`.

## Changelog Format

Release notes follow this structure:

```markdown
## [0.2.0] - 2025-04-15

### Added

- New plugin system for AI provider integration
- Category-based work filtering

### Changed

- Upgraded Next.js from 15 to 16
- Improved authentication flow with better error messages

### Fixed

- Resolved race condition in concurrent work updates
- Fixed pagination offset calculation for search results

### Deprecated

- Legacy REST endpoints under /api/v1/ (use /api/v2/ instead)

### Breaking Changes

- Removed `LEGACY_AUTH_MODE` environment variable
- Renamed `WorkItem` type to `Item` across all APIs
```

This format follows [Keep a Changelog](https://keepachangelog.com/) conventions, making it easy to scan for the information you need.
