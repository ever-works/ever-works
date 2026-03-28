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
RUN pnpm build --filter=ever-works-web...
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
