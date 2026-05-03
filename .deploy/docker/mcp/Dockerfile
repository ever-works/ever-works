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

#-- Production
FROM node:22-alpine

USER node
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3200

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./

EXPOSE 3200
CMD ["node", "dist/http.js"]
