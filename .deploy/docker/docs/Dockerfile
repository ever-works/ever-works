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

# Package registry selection (backward-compatible, fork-safe):
# When the VERDACCIO_REGISTRY build-arg is set, install deps through our internal
# Verdaccio cache (an anonymous, read-only proxy of npm — identical integrity
# hashes, so `pnpm install --frozen-lockfile` still verifies). When empty — a
# fork, or a plain `docker build` — this is a no-op and pnpm uses the public npm
# registry, exactly as before. Same pattern as the api/web/mcp/node Dockerfiles.
ARG VERDACCIO_REGISTRY=""
# Reachability probe (this repo's builds run inside BuildKit on our LAN
# runners, where the VIP is normally reachable — but a Verdaccio outage, or a
# build that ends up on a GitHub-hosted runner, must NOT fail the image build):
# probe the registry with a 5s timeout in the SAME layer, and fall back to the
# public npm registry with a loud warning when it is unreachable. `node` is the
# probe because the base image has no curl/wget guarantee. Any HTTP response
# counts as reachable; only a connect failure/timeout trips the fallback.
RUN if [ -n "$VERDACCIO_REGISTRY" ]; then \
        if node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(r=>{r.body&&r.body.cancel();process.exitCode=0},()=>{process.exitCode=1})" "${VERDACCIO_REGISTRY%/}/"; then \
            echo "==> Verdaccio reachable - installing through ${VERDACCIO_REGISTRY}" && \
            echo "registry=${VERDACCIO_REGISTRY}" >> .npmrc && \
            { sed -i "s|https://registry.npmjs.org|${VERDACCIO_REGISTRY%/}|g; s|https://registry.yarnpkg.com|${VERDACCIO_REGISTRY%/}|g" pnpm-lock.yaml 2>/dev/null || true; }; \
        else \
            echo "WARNING: VERDACCIO_REGISTRY=${VERDACCIO_REGISTRY} is unreachable from this builder - falling back to the public npm registry." >&2; \
        fi; \
    fi

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
