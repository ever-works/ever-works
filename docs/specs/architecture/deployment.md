# Architecture: Deployment Infrastructure

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers shipping the platform to a new
environment, building Docker images, debugging Kubernetes manifests,
or extending the deploy pipeline.

---

## 1. Purpose

The platform ships as **four separate runtime artifacts**:

- `ever-works-api` — the NestJS REST API
- `ever-works-web` — the Next.js dashboard
- `ever-works-mcp` — the MCP server
- `ever-works-docs` — the Docusaurus static documentation site

A fifth runtime — the **Trigger.dev worker** — is hosted by
Trigger.dev itself and deployed via their SDK; it doesn't ship as a
container image (see [`trigger-worker`](./trigger-worker.md)).

This spec covers the **`.deploy/` layout**, the **per-app Dockerfile
strategy** (multi-stage with `turbo prune`), the **Kubernetes manifest
set** (six manifests across `dev` / `stage` / `prod` × `core` / `mcp`),
the **Compose stack** for self-hosted deploys, and the **environment
variable contract** every runtime expects.

## 2. The `.deploy/` Layout

```
.deploy/
├── docker/                            # Per-app Dockerfile + helpers
│   ├── api/
│   │   ├── Dockerfile
│   │   └── entrypoint.sh
│   ├── web/
│   │   └── Dockerfile
│   ├── mcp/
│   │   └── Dockerfile
│   └── docs/
│       ├── Dockerfile
│       ├── docker-compose.yml         # Standalone docs stack
│       └── nginx.conf
└── k8s/                               # Kubernetes manifests
    ├── k8s-manifest.dev.yaml
    ├── k8s-manifest.stage.yaml
    ├── k8s-manifest.prod.yaml
    ├── k8s-manifest.mcp.dev.yaml
    ├── k8s-manifest.mcp.stage.yaml
    └── k8s-manifest.mcp.prod.yaml
```

Plus the **monorepo-level `compose.yaml`** at the repo root for
running the full stack locally as containers.

## 3. Dockerfile Strategy: `turbo prune` Multi-Stage

Every app's Dockerfile follows the same pattern, established by
`apps/web/Dockerfile` and replicated for `api`, `mcp`, `docs`:

```dockerfile
# Stage 1: pruner — produces a lean build context for one app
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate && npm install -g turbo@latest

FROM base AS builder
USER node
WORKDIR /app
COPY . .
RUN turbo prune --scope=ever-works-<app> --docker

# Stage 2: installer — installs only the deps the app needs
FROM base AS installer
USER root
WORKDIR /app
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/.gitignore .gitignore
RUN cd apps/<app> && pnpm install --frozen-lockfile
COPY --from=builder /app/out/full/ .
RUN pnpm build --filter=ever-works-<app>...

# Stage 3: runner — the actual production image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=installer --chown=node:node /app/apps/<app>/dist ./dist
# ... (per-app runtime files)
USER node
EXPOSE <port>
CMD ["node", "dist/main.js"]
```

The key win is `turbo prune --scope=<app> --docker`:

| Stage       | Output                                                          |
| ----------- | --------------------------------------------------------------- |
| `out/json/` | Every package.json + lockfile, **not** source — for layer cache |
| `out/full/` | All source files for the app + its workspace dependencies       |

The `out/json` copy goes into the cached layer first; only when a
`package.json` changes does the install layer rebuild. Source-only
changes invalidate just the build layer. Result: typical incremental
rebuilds finish in 30–90 seconds vs 5+ minutes for a naive `COPY .`.

## 4. Per-App Image Specifics

### 4.1 `api`

- Base image: `node:22-alpine`
- Entrypoint: `entrypoint.sh` runs `migration:run` on first boot, then
  starts the NestJS server.
- Exposes: `3100`.
- Special: requires `DATABASE_URL`, `JWT_SECRET`,
  `PLUGIN_SECRETS_ENCRYPTION_KEY`. See §8.

### 4.2 `web`

- Base image: `node:22-alpine`
- Built with `next build` standalone output (NEXT_BUILD_OUTPUT=standalone)
  so the final image only contains `node_modules` + `.next/standalone`
    - `.next/static` + `public`.
- Exposes: `3000`.
- Special: requires `python3`, `pkgconfig`, `pixman-dev`, `cairo-dev`,
  `pango-dev`, `jpeg-dev`, `giflib-dev` for the canvas + sharp
  native deps.

### 4.3 `mcp`

- Base image: `node:22-alpine`
- Two entry-point scripts:
    - `start:stdio` for Claude Desktop / Code subprocess mode.
    - `start:http` for remote / containerised mode (most relevant in
      Docker).
- Exposes: `3200` (HTTP mode only).
- Special: requires `EVER_WORKS_API_KEY`, `EVER_WORKS_API_URL`. See
  [`mcp-server-internals`](./mcp-server-internals.md).

### 4.4 `docs`

- Base image: `nginx:1.27-alpine` (multi-stage builds the static site
  from Docusaurus, then serves it via nginx).
- Custom `nginx.conf` in `.deploy/docker/docs/`.
- Exposes: `80`.
- Special: stateless; no DB, no env-var requirements beyond the
  static site's contents.

## 5. The Compose Stack (`compose.yaml`)

`compose.yaml` at the repo root composes all four services for
self-hosted deploys:

```yaml
services:
    ever-works-api:
        build: .
        dockerfile: .deploy/docker/api/Dockerfile
        env_file: .env.compose
        ports: ['3100:3100']
        depends_on: [postgres]
    ever-works-web:
        build: .
        dockerfile: .deploy/docker/web/Dockerfile
        env_file: .env.compose
        ports: ['3000:3000']
        depends_on: [ever-works-api]
    ever-works-mcp:
        build: .
        dockerfile: .deploy/docker/mcp/Dockerfile
        env_file: .env.compose
        ports: ['3200:3200']
        depends_on: [ever-works-api]
    ever-works-docs:
        build: .
        dockerfile: .deploy/docker/docs/Dockerfile
        ports: ['8080:80']
    postgres:
        image: postgres:16-alpine
        env_file: .env.compose
        volumes: [postgres-data:/var/lib/postgresql/data]
volumes:
    postgres-data:
```

`.env.compose` is the **single env-var source** for every service.
Operators copy `.env.compose.example` to `.env.compose`, fill in
secrets, and `docker compose up`. The example file is checked in;
the real file is `.gitignore`'d.

## 6. Kubernetes Manifests

`.deploy/k8s/` ships **six** manifests:

| Manifest                      | Environment | Apps included                                         |
| ----------------------------- | ----------- | ----------------------------------------------------- |
| `k8s-manifest.dev.yaml`       | dev         | `api`, `web`                                          |
| `k8s-manifest.stage.yaml`     | stage       | `api`, `web`                                          |
| `k8s-manifest.prod.yaml`      | prod        | `api`, `web`                                          |
| `k8s-manifest.mcp.dev.yaml`   | dev         | `mcp` (separate so it can be enabled per-environment) |
| `k8s-manifest.mcp.stage.yaml` | stage       | `mcp`                                                 |
| `k8s-manifest.mcp.prod.yaml`  | prod        | `mcp`                                                 |

Each manifest contains:

- **Service** definitions (ClusterIP, port mapping)
- **Deployment** definitions with `replicas`, rolling-update strategy,
  health probes
- **Ingress** rules (HTTPS termination at the cluster edge)
- **Secret** references (manifests reference `Secret` names; the
  actual values come from cluster-side secret management)

### 6.1 Replicas + Rollout

Production deployment defaults:

| Service          | Replicas | Strategy      | Max surge | Max unavailable |
| ---------------- | -------- | ------------- | --------- | --------------- |
| `ever-works-api` | 2        | RollingUpdate | 1         | 0               |
| `ever-works-web` | 2        | RollingUpdate | 1         | 0               |
| `ever-works-mcp` | 1        | Recreate      | —         | —               |

`maxUnavailable: 0` means rollouts always over-provision rather than
under-provision — no period of degraded capacity during deploys.

### 6.2 Health Probes

All long-running services expose `/health` (see
[`monitoring §10`](./monitoring.md)):

```yaml
livenessProbe:
    httpGet: { path: /api/health, port: 3100 }
    initialDelaySeconds: 30
    periodSeconds: 10
readinessProbe:
    httpGet: { path: /api/health, port: 3100 }
    initialDelaySeconds: 10
    periodSeconds: 5
```

The MCP server uses its own `/health` endpoint with shorter delays
(stateless, fast cold start).

### 6.3 Resource Requests + Limits

Production-tier pods:

| Service          | CPU request | CPU limit | Memory request | Memory limit |
| ---------------- | ----------- | --------- | -------------- | ------------ |
| `ever-works-api` | 500m        | 2         | 1 Gi           | 2 Gi         |
| `ever-works-web` | 250m        | 1         | 512 Mi         | 1 Gi         |
| `ever-works-mcp` | 100m        | 500m      | 256 Mi         | 512 Mi       |

Tunable per-deploy via the manifest. dev / stage halve the requests.

## 7. Build Pipeline

CI runs on every push to `develop` (staging) and `main` (production):

1. **`pnpm install --frozen-lockfile`** — single root install for the
   whole monorepo.
2. **Type-check + lint + test** via `turbo` — caches across runs.
3. **Build all docker images in parallel** — each `.deploy/docker/<app>/Dockerfile`
   is built as `ghcr.io/ever-works/ever-works-<app>:<sha>`.
4. **Push to ghcr.io** with both `:<sha>` and `:latest` tags (latest only
   on main).
5. **Deploy** — `kubectl apply -k overlays/prod/` (kustomize) updates
   image tags in the production manifest.
6. **Trigger.dev deploy** — `pnpm deploy:trigger` deploys the worker
   code to Trigger.dev's hosted runtime.
7. **Smoke tests** against the deployed environment.
8. **Sentry release** — tag the deploy with the git SHA so
   error traces resolve to the right source-map.

A failed step at any point halts the pipeline and the previous image
stays in production.

## 8. Environment Variables

Every runtime reads its config from env vars. The contract is
documented in [`docs/environment-variables.md`](../../environment-variables.md);
the categories are:

| Category                        | Examples                                                  |
| ------------------------------- | --------------------------------------------------------- |
| Database                        | `DATABASE_TYPE`, `DATABASE_URL`, `DATABASE_POOL_MAX`      |
| Auth secrets                    | `JWT_SECRET`, `JWT_REFRESH_SECRET`                        |
| Encryption                      | `PLUGIN_SECRETS_ENCRYPTION_KEY`                           |
| OAuth providers                 | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_*`    |
| AI provider keys (when default) | `PLUGIN_OPENROUTER_API_KEY`                               |
| Mailer                          | `MAILER_PROVIDER`, `SMTP_*` / `POSTMARK_API_TOKEN` / etc. |
| Subscriptions                   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              |
| Monitoring                      | `SENTRY_DSN`, `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST`       |
| Trigger.dev                     | `TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`                   |
| Public client                   | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SENTRY_DSN`           |

**Plugin-specific env vars** follow the convention
`PLUGIN_<plugin-id-upper>_<setting>` and are consumed via the
`x-envVar` schema extension (see [`settings-system §8`](./settings-system.md)).

Every required var is validated at startup; missing values fail
boot with a clear log line listing each one. `NEXT_PUBLIC_*` vars
are inlined at Next.js build time, not at runtime.

## 9. Secrets in Production

| Layer          | Mechanism                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Kubernetes     | `Secret` objects, mounted as env vars                                                          |
| Cloud KMS      | Cluster secrets sourced from cloud provider's secret manager                                   |
| OAuth tokens   | Encrypted in DB via `PLUGIN_SECRETS_ENCRYPTION_KEY` (see settings system)                      |
| Plugin secrets | Same — the secrets column on plugin_settings / user_plugins / work_plugins is AES-256-GCM |

Operators rotate `PLUGIN_SECRETS_ENCRYPTION_KEY` via the registered-keys
mechanism documented in [`settings-system §5`](./settings-system.md).

## 10. Multi-Region & Scale-Out

Today the production deploy is **single-region**. Multi-region is on
the roadmap but not implemented:

- The DB is a single primary with read replicas in the same region.
- The API + web are stateless — they scale horizontally cleanly.
- The Trigger.dev worker scales independently via Trigger.dev's
  own concurrency settings.
- The MCP server is also stateless but typically runs `replicas: 1`
  because each instance holds an in-memory OpenAPI cache (see
  [`mcp-server-internals`](./mcp-server-internals.md)).

Sticky sessions are **not** required — JWT auth is stateless;
WebSocket connections balance per-pod via `Sec-WebSocket-Protocol`
headers.

## 11. Observability of Deploys

Every deploy emits:

- Sentry release event (with git SHA, environment, source-maps).
- PostHog `deploy_completed` event with environment + duration.
- Kubernetes deployment events surfaced via cluster logging.
- A dashboard banner if a deploy is in `Progressing` for >5 min
  (alerting hook).

The `release` Sentry tag (see [`monitoring §4`](./monitoring.md)) is
the cross-pivot key — every error in a deploy window correlates to
the active release.

## 12. Constitution Reconciliation

| Principle                   | How deployment respects it                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| I — Plugin-first            | Plugins ship as workspace packages; no per-plugin container.                              |
| II — Capability-driven      | Capability resolution is runtime; deploy doesn't bake choices in.                         |
| III — Source-of-truth repos | The platform never deploys user repos — only its own code.                                |
| IV — Trigger.dev            | The worker deploys separately via the Trigger.dev SDK, not as a container.                |
| V — Forward-only migrations | `entrypoint.sh` runs `migration:run` before serving — guaranteed forward direction.       |
| VI — Tests                  | CI runs the full test suite before any image build.                                       |
| VII — Secret hygiene        | Secrets via cluster Secret objects; encryption keys rotate via the registered-keys story. |
| VIII — Plugin counts        | Plugin counts are runtime queries against the deployed registry.                          |
| IX — Behaviour-first        | This spec describes observable deploy behaviour.                                          |
| X — Backwards-compat        | Forward-only migrations + image-tag-versioned rollouts allow safe rollback.               |

## 13. References

- Source:
    - `.deploy/docker/`
    - `.deploy/k8s/`
    - `compose.yaml` (root)
    - `apps/api/typeorm.config.ts`
- Related specs:
    - [`monitoring`](./monitoring.md) (release tagging)
    - [`subscriptions`](./subscriptions.md) (`subscriptionsEnabled` toggle)
    - [`trigger-worker`](./trigger-worker.md) (separate deploy path)
    - [`mcp-server-internals`](./mcp-server-internals.md) (per-pod MCP cache)
- User docs:
    - [`docs/devops/docker.md`](../../devops/docker.md)
    - [`docs/devops/kubernetes.md`](../../devops/kubernetes.md)
    - [`docs/devops/digital-ocean.md`](../../devops/digital-ocean.md)
    - [`docs/environment-variables.md`](../../environment-variables.md)
