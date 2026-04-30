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

| Tool | Minimum Version | Purpose | Install |
|------|----------------|---------|---------|
| **Node.js** | 20.x | JavaScript runtime | [nodejs.org](https://nodejs.org) |
| **pnpm** | 10.30+ | Package manager (workspaces) | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Git** | 2.x | Version control, isomorphic-git operations | [git-scm.com](https://git-scm.com) |
| **Docker** *(optional)* | 24.x | Container-based setup | [docker.com](https://www.docker.com) |

### Verifying Prerequisites

```bash
node --version    # Should print v20.x or higher
pnpm --version    # Should print 10.30.x or higher
git --version     # Should print 2.x or higher
```

:::tip Enabling Corepack
Node.js ships with Corepack, which manages pnpm versions automatically. If `pnpm` is not found, run:

```bash
corepack enable
corepack prepare pnpm@10.30.3 --activate
```

The exact pnpm version is pinned in the root `package.json` under `"packageManager": "pnpm@10.30.3"`.
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
# Required - change from default for security
JWT_SECRET=generate-a-strong-random-string-here

# Database - sqlite works out of the box for development
DATABASE_TYPE=sqlite
DATABASE_IN_MEMORY=true

# Web URL - must match the web app
WEB_URL=http://localhost:3000

# CORS - include your web app origin
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

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
Never commit `.env` or `.env.local` files to version control. They contain secrets like `JWT_SECRET`, API keys, and database credentials. The `.env.example` files are safe templates.
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

For PostgreSQL and MySQL, run migrations after initial setup:

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

If you prefer not to install Node.js locally, use the provided Docker Compose setup:

```bash
# Create your Docker-specific env file
cp .env.compose .env.compose.local

# Start the containers
docker compose up -d
```

This starts two services:

| Service | Port | Description |
|---------|------|-------------|
| `ever-works-api` | 3100 | NestJS API with file-based SQLite |
| `ever-works-web` | 3000 | Next.js web dashboard |

The compose file uses published container images from `ghcr.io/ever-works/`. A named volume `api_data` persists the SQLite database between restarts.

## Verification

### Start the Dev Server

```bash
# Start both API and Web in watch mode
pnpm dev
```

Or start them individually:

```bash
# Terminal 1 - API on port 3100
pnpm dev:api

# Terminal 2 - Web on port 3000
pnpm dev:web
```

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
