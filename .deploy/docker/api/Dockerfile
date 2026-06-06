FROM node:22-alpine AS base

RUN corepack enable && \
    corepack prepare pnpm@10 --activate && \
    npm install -g turbo@latest

#-- Pruner
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-api --docker

# Collect ALL package.json files (turbo prune misses plugins since they're not API deps)
RUN mkdir -p /app/pkg-jsons && \
    find . -name "package.json" \
      -not -path "*/node_modules/*" \
      -not -path "*/.git/*" \
      -not -path "./out/*" \
      -not -path "./pkg-jsons/*" \
      -exec sh -c 'for f; do d=$(dirname "$f"); mkdir -p "/app/pkg-jsons/$d"; cp "$f" "/app/pkg-jsons/$d/"; done' _ {} + && \
    cp pnpm-workspace.yaml pnpm-lock.yaml /app/pkg-jsons/

#-- Installer
FROM base AS installer
WORKDIR /app

COPY --from=pruner /app/pkg-jsons/ .
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .
COPY packages/plugins/ packages/plugins/
COPY scripts/prepare-docker-plugins.js scripts/prepare-docker-plugins.js
COPY scripts/strip-non-core-plugins.js scripts/strip-non-core-plugins.js

# Use turbo directly to bypass the root `pnpm build` script's
# `--filter=!./apps/docs` which fails in the pruned workspace where
# apps/docs is not present.
RUN pnpm exec turbo build --filter=ever-works-api...
RUN pnpm exec turbo build --filter="./packages/plugins/*"
RUN pnpm deploy --filter=ever-works-api --prod --legacy /app/deploy
RUN node scripts/prepare-docker-plugins.js

# EW-693 / T29 — dual-mode image.
#
# `bundled` (default): every plugin is built into /app/deploy/plugins
# above, exactly as before this PR. No behaviour change.
#
# `dynamic` (opt-in via --build-arg PLUGIN_DISTRIBUTION_MODE=dynamic):
# after prepare-docker-plugins.js writes the full tree, we strip every
# plugin whose manifest resolves to `distribution: 'registry'`. Core
# plugins (systemPlugin=true OR distribution='core') stay so the API
# can boot. The runtime installer (Phase 5) lazily pulls registry
# plugins on first enable; warmup (Phase 5 + this entrypoint via
# warmupDynamicPlugins) pre-installs the DB-recorded set on boot.
ARG PLUGIN_DISTRIBUTION_MODE=bundled
ENV PLUGIN_DISTRIBUTION_MODE=$PLUGIN_DISTRIBUTION_MODE
RUN if [ "$PLUGIN_DISTRIBUTION_MODE" = "dynamic" ]; then \
        PLUGINS_DIR=/app/deploy/plugins node /app/scripts/strip-non-core-plugins.js; \
    else \
        echo "==> EW-693: bundled image (PLUGIN_DISTRIBUTION_MODE=$PLUGIN_DISTRIBUTION_MODE) — keeping every plugin."; \
    fi

#-- Production
FROM node:22-alpine

USER node
WORKDIR /app

ENV NODE_ENV=production
ENV APP_TYPE=api
ENV PORT=3100
# RUN_MIGRATIONS gates whether the API self-applies pending TypeORM
# migrations on startup. Default `true` so deployments self-heal after a
# schema change — set to `false` only for diagnostic / debug pods that
# should not touch the schema.
ENV RUN_MIGRATIONS=true

# Build / release identity surfaced at GET /api/version + /api/health/ready.
# Injected by the docker-build-publish-* workflows via --build-arg; empty
# defaults keep a plain `docker build` working (the API then reports a `dev`
# version). These are runtime ENV, so no rebuild is needed to read them.
ARG BUILD_VERSION=
ARG GIT_SHA=
ARG GIT_REF=
ARG BUILD_RUN=
ARG BUILD_TIME=
# EW-693 — propagate the build-time mode into the runtime image so
# operators can confirm the image variant at GET /api/version. The
# runtime config (apps/api/src/config/constants.ts) reads
# PLUGIN_DISTRIBUTION_MODE at request time, so this is informational
# in the runtime image but ensures `bundled` vs `dynamic` is set
# correctly by default for each image variant.
ARG PLUGIN_DISTRIBUTION_MODE=bundled
ENV BUILD_VERSION=$BUILD_VERSION \
    GIT_SHA=$GIT_SHA \
    GIT_REF=$GIT_REF \
    BUILD_RUN=$BUILD_RUN \
    BUILD_TIME=$BUILD_TIME \
    PLUGIN_DISTRIBUTION_MODE=$PLUGIN_DISTRIBUTION_MODE

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./
COPY --from=installer --chown=node:node /app/deploy/plugins ./plugins
COPY --chown=node:node .deploy/docker/api/entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME [ "/tmp/ever-works-repos" ]
EXPOSE 3100
ENTRYPOINT ["/app/entrypoint.sh"]
