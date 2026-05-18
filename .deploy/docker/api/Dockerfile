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

# Use turbo directly to bypass the root `pnpm build` script's
# `--filter=!./apps/docs` which fails in the pruned workspace where
# apps/docs is not present.
RUN pnpm exec turbo build --filter=ever-works-api...
RUN pnpm exec turbo build --filter="./packages/plugins/*"
RUN pnpm deploy --filter=ever-works-api --prod --legacy /app/deploy
RUN node scripts/prepare-docker-plugins.js

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

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./
COPY --from=installer --chown=node:node /app/deploy/plugins ./plugins
COPY --chown=node:node .deploy/docker/api/entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME [ "/tmp/ever-works-repos" ]
EXPOSE 3100
ENTRYPOINT ["/app/entrypoint.sh"]
