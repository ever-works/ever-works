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

USER root

WORKDIR /app

# First install the dependencies (as they change less often)
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/.gitignore .gitignore

# Install deps
RUN cd apps/api && pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .

# Build the apps
RUN pnpm build --filter=ever-works-api...

# Prune dev deps and husky
RUN sed -i '/"prepare.*husky/d' package.json
RUN rm -rf ./**/node_modules
RUN rm -rf /app/packages/agent/src /app/packages/monitoring/src

#--
# Build
FROM node:22-alpine

# Install PNPM
RUN npm install -g pnpm@10
RUN npm install -g npm@latest

# Create app directory with proper ownership
RUN mkdir -p /app && chown node:node /app

USER node

WORKDIR /app

ENV NODE_ENV=production
ENV APP_TYPE=api

COPY --from=installer --chown=node:node /app/package.json ./
COPY --from=installer --chown=node:node /app/pnpm-lock.yaml ./
COPY --from=installer --chown=node:node /app/pnpm-workspace.yaml ./
COPY --from=installer --chown=node:node /app/apps /app/apps
COPY --from=installer --chown=node:node /app/packages /app/packages

# Copy entrypoint script
COPY --chown=node:node .deploy/docker/api/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN pnpm install --prod
RUN pnpm store prune

WORKDIR /app/apps/api

ENV PORT=3100
ENV RUN_MIGRATIONS=false

VOLUME [ "/tmp/ever-works-repos" ]

EXPOSE 3100

ENTRYPOINT ["/app/entrypoint.sh"]