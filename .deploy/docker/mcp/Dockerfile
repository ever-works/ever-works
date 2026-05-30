FROM node:22-alpine AS base

RUN corepack enable && \
    corepack prepare pnpm@10 --activate && \
    npm install -g turbo@latest

#-- Pruner
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-mcp --docker

#-- Installer
FROM base AS installer
WORKDIR /app

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
# Use turbo directly to bypass the root `pnpm build` script's
# `--filter=!./apps/docs` which fails in the pruned workspace where
# apps/docs is not present.
RUN pnpm exec turbo build --filter=ever-works-mcp...
RUN pnpm deploy --filter=ever-works-mcp --prod --legacy /app/deploy

#-- API pruner (for OpenAPI spec generation)
FROM base AS api-pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-api --docker

#-- OpenAPI spec generation
# The MCP loads the API's OpenAPI spec at boot to build its tools, but C-09
# disables the live /api/openapi.json endpoint whenever NODE_ENV=production
# (every deployed env). So we generate the spec here and bundle it into the
# image. `generate-openapi` runs the API under Nest PREVIEW mode — routes are
# introspected for the document, but providers are NOT instantiated and no DB
# / external service is contacted. The dummy secrets below only satisfy
# module-config validation (e.g. AUTH_SECRET length, #869); nothing connects.
FROM base AS specgen
WORKDIR /app
COPY --from=api-pruner /app/out/json/ .
COPY --from=api-pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile
COPY --from=api-pruner /app/out/full/ .
RUN pnpm exec turbo build --filter=ever-works-api...
RUN NODE_ENV=development \
    DATABASE_URL="postgres://user:pass@localhost:5432/everworks" \
    AUTH_SECRET="00000000000000000000000000000000" \
    JWT_SECRET="00000000000000000000000000000000" \
    node apps/api/dist/openapi/generate-openapi.js /app/openapi.json

#-- Production
FROM node:22-alpine

USER node
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3200
# The MCP reads this bundled spec instead of fetching the API (C-09 disables
# the live spec endpoint in deployed envs). See OpenApiLoaderService.
ENV EVER_WORKS_OPENAPI_SPEC_PATH=/app/openapi.json

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./
COPY --from=specgen --chown=node:node /app/openapi.json ./openapi.json

EXPOSE 3200
CMD ["node", "dist/http.js"]
