# NodeJS Base
FROM node:22-alpine AS base

# Update npm and configure pnpm and turbo
RUN corepack enable && \
    corepack prepare pnpm@10 --activate && \
    npm install -g turbo@latest

ENV CI=true

#--
FROM base AS builder

USER node

WORKDIR /app

COPY . .

RUN turbo prune --scope=ever-works-web --docker

#--
# Add lockfile and package.json's of isolated subworkspace
FROM base AS installer
USER root
WORKDIR /app

ENV NODE_ENV=build
ENV NEXT_BUILD_OUTPUT=standalone
ENV CI=true

# NEXT_PUBLIC_* must be present BEFORE `next build` runs because Next.js
# inlines them into the client bundle at build time. The docker-build
# workflows pass them via `--build-arg`; unset values resolve to empty
# strings and the PostHog browser SDK degrades to a no-op gracefully.
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST

# Build / release identity baked into the client bundle (footer "Web" chip).
# Same build-time rule as the PostHog vars above — NEXT_PUBLIC_* must be ENV
# before `next build`. Injected via --build-arg by the docker-build-publish-*
# workflows; empty defaults make the footer show a `dev` build.
ARG NEXT_PUBLIC_BUILD_VERSION=
ARG NEXT_PUBLIC_BUILD_SHA=
ARG NEXT_PUBLIC_BUILD_REF=
ARG NEXT_PUBLIC_BUILD_RUN=
ARG NEXT_PUBLIC_BUILD_TIME=
ENV NEXT_PUBLIC_BUILD_VERSION=$NEXT_PUBLIC_BUILD_VERSION
ENV NEXT_PUBLIC_BUILD_SHA=$NEXT_PUBLIC_BUILD_SHA
ENV NEXT_PUBLIC_BUILD_REF=$NEXT_PUBLIC_BUILD_REF
ENV NEXT_PUBLIC_BUILD_RUN=$NEXT_PUBLIC_BUILD_RUN
ENV NEXT_PUBLIC_BUILD_TIME=$NEXT_PUBLIC_BUILD_TIME

# Install python3
RUN apk add --no-cache python3 pkgconfig build-base
RUN apk add --no-cache pixman-dev cairo-dev pango-dev jpeg-dev giflib-dev

# First install the dependencies (as they change less often)
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/.gitignore .gitignore

# Install deps
RUN cd apps/web && pnpm install --frozen-lockfile

# Build the project
COPY --from=builder /app/out/full/ .
# Build the apps
RUN turbo build --filter=ever-works-web...
# Prune dev deps
RUN sed -i '/"prepare.*husky/d' package.json
RUN cd apps/web && pnpm prune --prod

#--
# Build
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=installer --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=installer --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=installer --chown=node:node /app/apps/web/messages ./apps/web/messages

# Create cache directory with proper permissions for node user
RUN mkdir -p /app/apps/web/.next/cache/images && \
    chown -R node:node /app/apps/web/.next/cache

VOLUME /app/apps/web/.next/cache

USER node
WORKDIR /app/apps/web

ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
