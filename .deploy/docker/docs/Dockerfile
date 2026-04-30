# Ever Works — Docusaurus documentation site
# Multi-stage build: prune the monorepo → install → build static site → serve via nginx

FROM node:22-alpine AS base

RUN corepack enable && \
    corepack prepare pnpm@10 --activate && \
    npm install -g turbo@latest

ENV CI=true

#-- Pruner: isolate the docs workspace and produce a lean build context
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-docs --docker

#-- Installer + Builder: install deps and build the static site
FROM base AS builder
WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first (lockfile + package.jsons only — better cache)
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Copy the rest of the pruned sources
COPY --from=pruner /app/out/full/ .

# Docusaurus reads markdown from ../../docs/ (resolves to platform/docs/).
# turbo prune doesn't follow non-workspace path references, so copy explicitly.
COPY docs/ ./docs/

# Build the static site (defaults to all locales — pass --locale en to speed up if needed)
RUN pnpm --filter ever-works-docs build

#-- Runtime: nginx serving the static build output
FROM nginx:1.27-alpine

# Copy nginx config tuned for an SPA with locale subpaths
COPY .deploy/docker/docs/nginx.conf /etc/nginx/conf.d/default.conf

# Drop the default nginx welcome page and copy in the built site
RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/apps/docs/build /usr/share/nginx/html

EXPOSE 80

# nginx:alpine ships an entrypoint that boots nginx in the foreground
