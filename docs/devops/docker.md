---
id: docker
title: Docker Setup & Configuration
sidebar_label: Docker
sidebar_position: 1
---

# Docker Setup & Configuration

Ever Works provides Docker images for both the API and Web applications. The build system uses multi-stage Dockerfiles optimized for production, and a Docker Compose configuration for local development.

## Dockerfile Locations

| Application   | Dockerfile                      | Image            |
| ------------- | ------------------------------- | ---------------- |
| API (NestJS)  | `.deploy/docker/api/Dockerfile` | `ever-works-api` |
| Web (Next.js) | `.deploy/docker/web/Dockerfile` | `ever-works-web` |

## API Dockerfile

The API Dockerfile uses a three-stage build process: **base**, **pruner/installer**, and **production**.

### Stage 1: Base

```dockerfile
FROM node:22-alpine AS base
RUN npm install -g npm@latest && \
    npm install -g pnpm@10 && \
    npm install -g turbo@latest
```

Installs the required tooling (pnpm and Turborepo) on an Alpine-based Node 22 image.

### Stage 2: Pruner

```dockerfile
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-api --docker
```

Uses `turbo prune` to extract only the API app and its workspace dependencies, reducing the build context. Because Turbo's prune may miss plugin packages (they are not direct API dependencies), the pruner also collects all `package.json` files:

```dockerfile
RUN mkdir -p /app/pkg-jsons && \
    find . -name "package.json" \
      -not -path "*/node_modules/*" \
      -exec sh -c '...' _ {} + && \
    cp pnpm-workspace.yaml pnpm-lock.yaml /app/pkg-jsons/
```

### Stage 3: Installer

```dockerfile
FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/pkg-jsons/ .
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY packages/plugins/ packages/plugins/
RUN pnpm build --filter=ever-works-api...
RUN pnpm build --filter="./packages/plugins/*"
RUN pnpm deploy --filter=ever-works-api --prod --legacy /app/deploy
RUN node scripts/prepare-docker-plugins.js
```

Key steps:

1. **Install dependencies** with `shamefully-hoist=true` for compatibility.
2. **Build the API** and all upstream workspace dependencies (`...` suffix).
3. **Build all plugins** separately.
4. **Deploy** to a clean directory using `pnpm deploy --prod`, which produces a minimal production installation.
5. **Prepare plugins** for Docker using a custom script that copies built plugins into the deploy directory.

### Stage 4: Production

```dockerfile
FROM node:22-alpine
USER node
WORKDIR /app
ENV NODE_ENV=production
ENV APP_TYPE=api
ENV PORT=3100

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./
COPY --from=installer --chown=node:node /app/deploy/plugins ./plugins
COPY --chown=node:node .deploy/docker/api/entrypoint.sh ./entrypoint.sh

VOLUME [ "/tmp/ever-works-repos" ]
EXPOSE 3100
ENTRYPOINT ["/app/entrypoint.sh"]
```

The production image:

- Runs as the non-root `node` user for security.
- Copies only the built `dist/`, `node_modules/`, `package.json`, and `plugins/`.
- Declares a volume at `/tmp/ever-works-repos` for Git repository cloning.
- Exposes port 3100.
- Uses an entrypoint script that can optionally run migrations before starting.

The `RUN_MIGRATIONS` environment variable controls whether the entrypoint runs database migrations on container start.

## Web Dockerfile

The Web Dockerfile follows a similar three-stage pattern optimized for Next.js standalone output.

### Build Stages

1. **Builder**: Copies the monorepo and runs `turbo prune --scope=ever-works-web --docker`.
2. **Installer**: Installs system dependencies (Python, Cairo, Pango for canvas support), then:
    - Installs npm dependencies with `pnpm install --frozen-lockfile`
    - Builds with `pnpm build --filter=ever-works-web...`
    - Prunes dev dependencies
3. **Production**: Copies the Next.js standalone output:

```dockerfile
FROM node:22-alpine
WORKDIR /app

COPY --from=installer /app/apps/web/.next/standalone ./
COPY --from=installer /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer /app/apps/web/public ./apps/web/public
COPY --from=installer /app/apps/web/messages ./apps/web/messages

USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
```

The `NEXT_BUILD_OUTPUT=standalone` environment variable tells Next.js to produce a self-contained server. The `messages/` directory contains i18n translation files.

A writable volume is created at `/app/apps/web/.next/cache` for Next.js image optimization cache.

## Docker Compose

The `compose.yaml` file defines a two-service setup for local deployment:

```yaml
services:
    ever-works-api:
        image: ghcr.io/ever-works/ever-works-api:latest
        container_name: ever-works-api
        ports:
            - '3100:3100'
        environment:
            - DATABASE_TYPE=sqlite
            - DATABASE_PATH=/app/apps/api/data/database.db
        volumes:
            - api_data:/app/apps/api/data
        env_file: .env.compose

    ever-works-web:
        image: ghcr.io/ever-works/ever-works-web:latest
        container_name: ever-works-web
        ports:
            - '3000:3000'
        depends_on:
            - ever-works-api
        environment:
            - API_URL=http://ever-works-api:3100
        env_file: .env.compose

networks:
    ever-works-network:
        driver: bridge

volumes:
    api_data:
```

### Networking

Both services share a `bridge` network (`ever-works-network`), allowing the web app to reach the API via `http://ever-works-api:3100`.

### Volumes

The `api_data` named volume persists the SQLite database file at `/app/apps/api/data/database.db`, surviving container restarts.

### Environment File

The `.env.compose` file provides all application configuration. Key variable groups:

| Group           | Examples                                                     |
| --------------- | ------------------------------------------------------------ |
| **Auth**        | `JWT_SECRET`, `JWT_EXPIRATION_TIME`, `AUTH_SECRET`           |
| **OAuth**       | `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, etc. |
| **Database**    | `DATABASE_TYPE`, `DATABASE_PATH`, `DATABASE_URL`             |
| **Trigger.dev** | `TRIGGER_ENABLED`, `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL`   |
| **Plugins**     | `PLUGIN_OPENROUTER_API_KEY`, `PLUGIN_GITHUB_CLIENT_ID`, etc. |
| **Mail**        | `MAILER_PROVIDER`, `SMTP_HOST`, `RESEND_APIKEY`              |
| **Monitoring**  | `SENTRY_DSN`, `POSTHOG_API_KEY`                              |
| **Billing**     | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                 |

## Running with Docker Compose

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Stop all services
docker compose down

# Stop and remove volumes (reset database)
docker compose down -v
```

## Building Images Locally

```bash
# Build API image
docker build -f .deploy/docker/api/Dockerfile -t ever-works-api:local .

# Build Web image
docker build -f .deploy/docker/web/Dockerfile -t ever-works-web:local .
```

Note: Both Dockerfiles expect the build context to be the repository root (not the `.deploy/` directory).
