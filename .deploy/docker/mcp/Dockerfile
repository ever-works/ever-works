FROM node:22-alpine AS base
RUN npm install -g npm@latest && \
    npm install -g pnpm@10 && \
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
RUN pnpm build --filter=ever-works-mcp...
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
