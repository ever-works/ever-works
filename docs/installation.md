---
id: installation
title: Installation & Prerequisites
sidebar_label: Installation
sidebar_position: 4
---

# Installation & Prerequisites

This guide walks through setting up the Ever Works Platform for local development from a fresh clone to a running dev server.

## Prerequisites

Before starting, ensure you have the following tools installed:

| Tool                    | Minimum Version | Purpose                                    | Install                                                      |
| ----------------------- | --------------- | ------------------------------------------ | ------------------------------------------------------------ |
| **Node.js**             | 22.x            | JavaScript runtime                         | [nodejs.org](https://nodejs.org)                             |
| **pnpm**                | 10.33.x         | Package manager (workspaces)               | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Git**                 | 2.x             | Version control, isomorphic-git operations | [git-scm.com](https://git-scm.com)                           |
| **Docker** _(optional)_ | 24.x            | Container-based setup                      | [docker.com](https://www.docker.com)                         |

The root `package.json` declares `"engines": { "node": ">=22", "pnpm": ">=9.9.0" }` and pins the package manager with `"packageManager": "pnpm@10.33.3"`. Node 22 is also the base image used by every container (`node:22-alpine`), so building locally on 22 matches what CI and production run.

### Verifying Prerequisites

```bash
node --version    # Should print v22.x or higher
pnpm --version    # Should print 10.33.x (Corepack activates the pinned version)
git --version     # Should print 2.x or higher
```

:::tip Enabling Corepack
Node.js ships with Corepack, which manages pnpm versions automatically. If `pnpm` is not found, run:

```bash
corepack enable
corepack prepare pnpm@10.33.3 --activate
```

The exact pnpm version is pinned in the root `package.json` under `"packageManager": "pnpm@10.33.3"`. Corepack reads that field, so running any `pnpm` command from inside the repository already gives you the right version -- the `corepack prepare` line above is only needed to pre-download it.
:::

## Step-by-Step Installation

### 1. Clone the Repository

```bash
git clone https://github.com/ever-works/ever-works.git
cd ever-works
```

### 2. Install Dependencies

```bash
pnpm install
```

This installs dependencies for all workspace packages (`apps/*`, `packages/*`, `packages/plugins/*`). The `pnpm-workspace.yaml` defines these three workspace roots. Several packages require native module compilation -- see [Troubleshooting](#common-installation-errors--fixes) if you encounter build errors.

### 3. Build Workspace Packages

Some packages must be built before the apps can run in dev mode, since they reference compiled output:

```bash
pnpm build:packages
```

This builds shared packages like `@ever-works/contracts`, `@ever-works/plugin`, and `@ever-works/agent` in the correct dependency order (handled by Turborepo).

## Setting Up Environment Variables

The platform requires environment files for both the **API** and **Web** apps.

### API Environment (apps/api/.env)

```bash
cp apps/api/.env.example apps/api/.env
```

Open `apps/api/.env` and configure at minimum:

```bash
# Required - the API refuses to boot without it, and rejects anything
# shorter than 32 characters. Generate with: openssl rand -base64 48
AUTH_SECRET=generate-a-strong-random-string-here

# Database - sqlite works out of the box for development
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=true

# Web URL - must match the web app
WEB_URL=http://localhost:3000

# CORS - include your web app origin
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

:::info Two secrets the API checks at boot
`bootstrap()` in `apps/api/src/main.ts` resolves both of these eagerly, so a misconfiguration shows up as an immediate exit rather than a failed OAuth callback hours later:

| Variable                  | Rule                                                                                                                         | Local development                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `AUTH_SECRET`             | Required always; must be **at least 32 characters**. Both tiers use it -- JWT signing in the API, cookie sealing in the web. | Set it in `apps/api/.env` **and** `apps/web/.env.local`; use the same value.   |
| `PLATFORM_ENCRYPTION_KEY` | Master key that encrypts operator-supplied secrets at rest. Required unless `NODE_ENV` is `development`, `test`, or unset.   | Optional locally. Generate with `openssl rand -hex 32` before any real deploy. |

:::

### Web Environment (apps/web/.env.local)

```bash
cp apps/web/.env.example apps/web/.env.local
```

Open `apps/web/.env.local` and configure:

```bash
# API backend URL
API_URL=http://localhost:3100

# Web URL
NEXT_PUBLIC_WEB_URL=http://localhost:3000

# Cookie/session secret - generate a strong random string
COOKIE_SECRET=your-secret-key-here
AUTH_SECRET=your-secret-key-here
```

:::warning
Never commit `.env` or `.env.local` files to version control. They contain secrets like `AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY`, provider API keys, and database credentials. The `.env.example` files are safe templates.
:::

## Database Setup

Ever Works supports three database backends. SQLite is the default and requires zero configuration for development.

### SQLite (Development -- Default)

No additional setup required. By default the API starts with an in-memory SQLite database:

```bash
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=true
```

For persistent local development data, use a file-based SQLite database:

```bash
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=false
DATABASE_PATH=./data/database.db
```

### PostgreSQL (Production Recommended)

```bash
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=your_password
DATABASE_NAME=ever_works
```

Or use a connection URL:

```bash
DATABASE_TYPE=postgres
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/ever_works
```

### MySQL / MariaDB

```bash
DATABASE_TYPE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USERNAME=root
DATABASE_PASSWORD=your_password
DATABASE_NAME=ever_works
```

### Running Migrations

The API applies pending migrations itself on startup. `packages/agent/src/database/database.config.ts` sets TypeORM's `migrationsRun` when three conditions hold: the process is the API app type, `RUN_MIGRATIONS` resolves true (default: true unless `NODE_ENV=test` or you set `RUN_MIGRATIONS=false`), and `DATABASE_AUTOMIGRATE` is off. `DATABASE_AUTOMIGRATE` (TypeORM `synchronize`) defaults to `false` everywhere except unit tests, so on a normal PostgreSQL setup migrations run on boot and you do not need to invoke anything by hand.

The commands below are for **authoring** a migration, or for applying one out-of-band when you have deliberately set `RUN_MIGRATIONS=false`:

```bash
cd apps/api
pnpm migration:run
```

To generate a new migration after modifying entities:

```bash
cd apps/api
pnpm migration:generate src/migrations/YourMigrationName
```

## Docker Compose (Alternative)

If you prefer not to install Node.js locally -- or you want Postgres and Redis in containers while you keep hacking on the apps natively -- use the Compose files at the repository root. There are five of them, layered, so you can pick the stack that matches what you are doing. [Docker Compose Setup](./devops/docker-compose.md) is the full reference; the summary below is what you need to get running.

| File                         | Brings up                                                                         | Use when                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `docker-compose.demo.yml`    | api + web (+ mcp, docs) on SQLite. No Postgres, no Redis.                         | Kicking the tires for the first time.                              |
| `docker-compose.infra.yml`   | PostgreSQL + Redis only. No application containers.                               | Running the apps with `pnpm dev:apps` against real backing stores. |
| `docker-compose.yml`         | The full platform from pre-built GHCR images, plus the infra file via `include:`. | Production-shaped self-host with no local Docker build.            |
| `docker-compose.build.yml`   | Same services, built from source using the Dockerfiles in `.deploy/docker/`.      | Hacking on the images themselves.                                  |
| `docker-compose.trigger.yml` | Self-hosted Trigger.dev webapp, its own Postgres and Redis (profile-gated).       | Developing background jobs without Trigger.dev Cloud.              |

### The default stack

```bash
# Optional - review and edit the committed template first
cp .env.compose .env

# Start the platform plus Postgres and Redis
docker compose up -d
```

`docker-compose.yml` starts four application containers and, through `include: ./docker-compose.infra.yml`, the two backing services they depend on:

| Service            | Image                                | Host port | Notes                                                                                                                |
| ------------------ | ------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `ever-works-api`   | `ghcr.io/ever-works/ever-works-api`  | 3100      | NestJS API. `APP_TYPE=api` and `PORT=3100` are pinned inline; waits for the db and redis healthchecks.               |
| `ever-works-web`   | `ghcr.io/ever-works/ever-works-web`  | 3000      | Next.js dashboard. Reaches the API in-network at `http://ever-works-api:3100`.                                       |
| `ever-works-mcp`   | `ghcr.io/ever-works/ever-works-mcp`  | 3200      | MCP server. Behind the `mcp` profile -- it refuses to start without an `EVER_WORKS_API_KEY` minted in the dashboard. |
| `ever-works-docs`  | `ghcr.io/ever-works/ever-works-docs` | 3300      | This documentation site, served by nginx (container port 80).                                                        |
| `ever-works-db`    | `postgres:17-alpine`                 | 5432      | From the infra file. `pg_isready` healthcheck, `postgres_data` named volume.                                         |
| `ever-works-redis` | `redis:7-alpine`                     | 6379      | From the infra file. Appendonly persistence, `redis_data` named volume. Backs the throttler and BullMQ queues.       |

Bring the MCP server up once you have a key:

```bash
docker compose --profile mcp up -d ever-works-mcp
```

### Just Postgres and Redis, apps on your machine

This is the most useful hybrid for day-to-day development -- containers hold the state, `pnpm` runs the code you are editing:

```bash
docker compose -f docker-compose.infra.yml --env-file .env.compose up -d
pnpm dev:apps
```

Postgres answers on `localhost:5432` (database `ever_works`, user `postgres`, password `ever_works_password` by default) and Redis on `localhost:6379`. Point `apps/api/.env` at them with `DATABASE_TYPE=postgres` and the matching `DATABASE_*` values from [Database Setup](#database-setup) above.

### Before you expose any of this

The committed `.env.compose` and `.env.demo.compose` are **templates with placeholder secrets**. Two details bite immediately:

- **`AUTH_SECRET=secure-cookie-secret-here`** is 25 characters, and the API rejects anything under 32. Replace it with `openssl rand -base64 48` output before the first `up`.
- **`PLATFORM_ENCRYPTION_KEY`** is absent from both templates, and the API image sets `ENV NODE_ENV=production`, which makes it mandatory. Generate one with `openssl rand -hex 32`.

`.env.compose` also ships `RUN_MIGRATIONS=false` with `DATABASE_AUTOMIGRATE=true` on purpose: TypeORM's entity sync bootstraps the schema on a fresh container, and the existing migrations are deltas on top of that schema rather than a from-zero bootstrap. The file's own comments explain the trade-off; do not flip both knobs on at once.

For TLS termination, image pinning, Kubernetes manifests, and the rest of the operator checklist, follow [Self-host with Docker Compose and Kubernetes](./guides/self-host-docker-kubernetes.md).

## Verification

### Start the Dev Server

```bash
# Start every runnable app in watch mode
pnpm dev:apps
```

Or start them individually:

```bash
# Terminal 1 - API on port 3100
pnpm dev:api

# Terminal 2 - Web on port 3000
pnpm dev:web
```

:::note There is no bare `pnpm dev`
The root `package.json` defines the dev scripts by target, not a single catch-all:

| Command            | Turborepo filter                                           | What it starts                                                  |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev:apps`    | `./apps/*` minus `docs`, `desktop`, `desktop-node`, `node` | API on 3100 and web on 3000 together                            |
| `pnpm dev:api`     | `ever-works-api`                                           | `nest start -b swc --watch` on port 3100                        |
| `pnpm dev:web`     | `ever-works-web`                                           | `next dev --turbopack` on port 3000                             |
| `pnpm dev:docs`    | `ever-works-docs`                                          | Docusaurus dev server for this site (defaults to port 3000 too) |
| `pnpm dev:trigger` | `@ever-works/trigger-tasks`                                | Trigger.dev dev server for background jobs                      |

`pnpm dev:docs` and `pnpm dev:web` both want port 3000, so run the docs site on its own or pass `--port` through to Docusaurus.
:::

### Check Health Endpoints

Once the API is running, verify it is healthy:

```bash
# API health
curl http://localhost:3100/api

# Interactive API docs (open in browser)
# Swagger UI:       http://localhost:3100/api/swagger
# Scalar Reference: http://localhost:3100/api/docs
# OpenAPI spec:     http://localhost:3100/api/openapi.json
```

Open `http://localhost:3000` in your browser to see the web dashboard.

## Common Installation Errors & Fixes

### Native Module Build Failures

Several dependencies (`better-sqlite3`, `bcrypt`, `sharp`, `@swc/core`) require native compilation. The `pnpm-workspace.yaml` lists these under `onlyBuiltDependencies`.

**Fix**: Ensure you have build tools installed:

- **macOS**: `xcode-select --install`
- **Ubuntu/Debian**: `sudo apt-get install build-essential python3`
- **Windows**: Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload

### pnpm Workspace Resolution Errors

If you see errors like `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`:

```bash
# Clean and reinstall
pnpm store prune
rm -rf node_modules
pnpm install
```

### Port Already in Use

If port 3100 or 3000 is occupied:

```bash
# Find and kill the process (Linux/macOS)
lsof -ti:3100 | xargs kill -9

# Or change the port in .env
PORT=3101
```

### TypeORM Metadata Errors

If you see `EntityMetadataNotFoundError` or similar TypeORM issues:

```bash
# Ensure packages are built
pnpm build:packages

# Restart the API
pnpm dev:api
```

### SWC Compilation Errors

The API uses SWC for fast compilation (`nest start -b swc`). If SWC fails:

```bash
# Rebuild SWC binary
pnpm rebuild @swc/core
```

## Next Steps

- [Development Workflow](/development-workflow) -- Day-to-day development commands and debugging
- [Environment Variables Reference](/environment-variables) -- Complete variable reference
- [Monorepo Structure](/monorepo-structure) -- Understand the project organization
- [Architecture](/architecture) -- System design and data flow

## Related

- [Docker Compose Setup](./devops/docker-compose.md) -- All five Compose files, per-service env vars, volumes, and troubleshooting
- [Self-host with Docker Compose and Kubernetes](./guides/self-host-docker-kubernetes.md) -- Operator guide: required secrets, GHCR images, `.deploy/k8s` manifests
- [Getting Started](./getting-started.md) -- Create your first Work once the stack is running
- [Development Workflow](./development-workflow.md) -- Build, test, lint, and debug commands
- [Environment Variables](./environment-variables.md) -- Every variable the API and web apps read
- [Monorepo Structure](./monorepo-structure.md) -- What lives in `apps/`, `packages/`, and `packages/plugins/`
