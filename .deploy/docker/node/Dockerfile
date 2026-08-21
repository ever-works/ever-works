FROM node:22-bookworm-slim AS base

# bookworm (not alpine) on purpose: the node's `browser-check` executor
# drives a real Chromium, and the prebuilt Chromium/keyring binaries the
# optional dependencies ship are glibc-linked. A musl base would silently
# lose both capabilities.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10 --activate \
    && npm install -g turbo@latest

#-- Pruner
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-node --docker

#-- Installer
FROM base AS installer
WORKDIR /app

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN echo "shamefully-hoist=true" > .npmrc

# Package registry selection (backward-compatible, fork-safe) — see the
# API/MCP Dockerfiles for the full rationale. Empty is a no-op.
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

COPY --from=pruner /app/out/full/ .
# `turbo` directly, not the root `pnpm build`: that script filters out
# apps/docs, which does not exist in the pruned workspace.
RUN pnpm exec turbo build --filter=ever-works-node...
RUN pnpm deploy --filter=ever-works-node --prod --legacy /app/deploy

#-- Production
FROM node:22-bookworm-slim

# WITH_BROWSER=true installs Chromium so the image advertises — and can
# honour — the `browser` capability. It roughly triples the image size,
# so it is opt-in: a node that only runs acceptance checks has no reason
# to carry a browser.
ARG WITH_BROWSER="false"

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tini \
    && if [ "$WITH_BROWSER" = "true" ]; then \
         apt-get install -y --no-install-recommends chromium fonts-liberation; \
       fi \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Config lives on a volume, not in the image layer: the node's heartbeat
# credential is written here, and it must survive `docker run --rm` only
# when the operator explicitly mounts it.
ENV EVER_WORKS_NODE_CONFIG=/var/lib/ever-works-node/node-config.json
# There is no OS keychain in a container, so the credential falls back to
# the config file. Declaring it keeps the fallback deliberate and keeps
# the node's warning honest instead of surprising.
ENV EVER_WORKS_NODE_DISABLE_KEYCHAIN=1
# Chromium cannot use its own sandbox inside an unprivileged container;
# the container IS the isolation boundary here.
ENV EVER_WORKS_NODE_BROWSER_NO_SANDBOX=1
ENV EVER_WORKS_NODE_BROWSER=/usr/bin/chromium

WORKDIR /app

COPY --from=installer --chown=node:node /app/deploy/dist ./dist
COPY --from=installer --chown=node:node /app/deploy/node_modules ./node_modules
COPY --from=installer --chown=node:node /app/deploy/package.json ./

RUN mkdir -p /var/lib/ever-works-node /workspaces \
    && chown -R node:node /var/lib/ever-works-node /workspaces

USER node
VOLUME ["/var/lib/ever-works-node"]

# tini as PID 1: the node's graceful shutdown is a SIGTERM handler that
# drains in-flight jobs, and PID 1 without an init does not get default
# signal handling — the drain would never run.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["start", "--work"]
