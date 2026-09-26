# syntax=docker/dockerfile:1
#
# app-fixture-hello — the Dockerfile `.works/works.yml` names:
#   build: { strategy: dockerfile, dockerfile: Dockerfile, context: ., target: runtime,
#            args: [{ name: FIXTURE_BUILD_LABEL, fromEnv: FIXTURE_BUILD_LABEL }] }
#
# Two stages. `deps` runs the install step the platform's build budget assumes (`npm ci`); `runtime` is
# the stage the App spec targets and the only one that ends up in the image. The fixture has no
# dependencies, so `deps` is nearly a no-op today — it stays because an evolve-loop change that adds a
# dependency must not silently produce an image without it.
#
# `--ignore-scripts` is deliberate and load-bearing: the prompt-injection fixture (plan §5.2) carries a
# `postinstall` that would exfiltrate the environment, and an install step that runs repository scripts
# would obey it.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p node_modules

FROM node:22-alpine AS runtime
# Baked at build time from the App spec's build argument; `GET /marker` reports it, which is how the
# build-phase value is proven to have reached the running container.
ARG FIXTURE_BUILD_LABEL=dev
ENV NODE_ENV=production \
	FIXTURE_BUILD_LABEL=${FIXTURE_BUILD_LABEL} \
	FIXTURE_DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
# The volume of the App spec (`volumes: [{ name: uploads, path: /data }]`) is the only writable path:
# the component runs with `writableRootFilesystem: false`.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
# Must match the `web` component's `port` in .works/works.yml.
EXPOSE 8080
CMD ["node", "src/server.mjs"]
