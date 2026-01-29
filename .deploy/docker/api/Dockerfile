# NodeJS Base
FROM node:22-alpine AS base
# Update npm and configure pnpm and turbo
RUN npm install -g npm@latest && \
    npm install -g pnpm@10 && \
    npm install -g turbo@latest

#--
FROM base AS builder

USER node

WORKDIR /app

COPY . .

RUN turbo prune --scope=ever-works-api --docker

#--
# Add lockfile and package.json's of isolated subworkspace
FROM base AS installer

WORKDIR /app

# First install the dependencies (as they change less often)
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

# Install deps
RUN pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .

# Build the API and its dependencies
RUN pnpm build --filter=ever-works-api...

# Build built-in plugins (if any exist)
RUN pnpm build --filter="./packages/plugins/*" || true

# Deploy creates standalone copy with all npm dependencies (no pnpm needed at runtime)
RUN pnpm deploy --filter=ever-works-api --prod --legacy /app/deploy

# Copy built-in plugins to deploy directory
RUN mkdir -p /app/deploy/plugins && \
    for dir in packages/plugins/*/; do \
        if [ -d "$dir/dist" ]; then \
            plugin_name=$(basename "$dir"); \
            cp -r "$dir" /app/deploy/plugins/"$plugin_name"; \
        fi \
    done

#--
# Production image - NO PNPM required
FROM node:22-alpine

USER node

WORKDIR /app

ENV NODE_ENV=production
ENV APP_TYPE=api
ENV PORT=3100
ENV RUN_MIGRATIONS=false

# Copy production files from pnpm deploy output
COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./

# Copy built-in plugins
COPY --from=installer --chown=node:node /app/deploy/plugins ./plugins

# Copy entrypoint script
COPY --chown=node:node .deploy/docker/api/entrypoint.sh ./entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME [ "/tmp/ever-works-repos" ]

EXPOSE 3100

ENTRYPOINT ["/app/entrypoint.sh"]
