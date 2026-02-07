FROM node:22-alpine AS base
RUN npm install -g npm@latest && \
    npm install -g pnpm@10 && \
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

RUN pnpm build --filter=ever-works-api...
RUN pnpm build --filter="./packages/plugins/*"
RUN pnpm deploy --filter=ever-works-api --prod --legacy /app/deploy
RUN node scripts/prepare-docker-plugins.js

#-- Production
FROM node:22-alpine

USER node
WORKDIR /app

ENV NODE_ENV=production
ENV APP_TYPE=api
ENV PORT=3100
ENV RUN_MIGRATIONS=false

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./
COPY --from=installer --chown=node:node /app/deploy/plugins ./plugins
COPY --chown=node:node .deploy/docker/api/entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME [ "/tmp/ever-works-repos" ]
EXPOSE 3100
ENTRYPOINT ["/app/entrypoint.sh"]
