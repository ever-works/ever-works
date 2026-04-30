---
id: digital-ocean
title: DigitalOcean Deployment
sidebar_label: DigitalOcean
sidebar_position: 3
---

# DigitalOcean Deployment

Ever Works production runs on DigitalOcean Kubernetes (DOKS) with a managed PostgreSQL database and container registry. The deployment is automated through GitHub Actions.

## Infrastructure Components

| Component | DigitalOcean Service | Details |
|---|---|---|
| **Compute** | Kubernetes (DOKS) | Cluster `k8s-gauzy` in `sfo2` region |
| **Database** | Managed PostgreSQL | SSL/TLS with CA certificate |
| **Container Registry** | DO Container Registry | `registry.digitalocean.com/ever/` |
| **DNS / Domains** | DigitalOcean DNS | `api.ever.works`, `app.ever.works` |

## Kubernetes Cluster

The production cluster is named `k8s-gauzy` and runs in the `sfo2` (San Francisco) region. Access is managed through `doctl` with short-lived credentials:

```bash
doctl kubernetes cluster kubeconfig save --expiry-seconds 600 k8s-gauzy
```

The 600-second (10-minute) credential expiry limits the window of access during deployments.

### Deployments

Two Kubernetes Deployments run the platform:

| Deployment | Image | Port |
|---|---|---|
| `ever-works-api` | `ghcr.io/ever-works/ever-works-api:latest` | 3100 |
| `ever-works-web` | `ghcr.io/ever-works/ever-works-web:latest` | 3000 |

### Ingress & TLS

The cluster uses Kubernetes Ingress with TLS termination. Two TLS secrets manage certificates:

| Domain | TLS Secret |
|---|---|
| `api.ever.works` | `api.ever.works-tls` |
| `app.ever.works` | `app.ever.works-tls` |

Certificates are stored as GitHub Secrets (base64-encoded) and created/updated during deployment:

```bash
kubectl create secret tls api.ever.works-tls \
    --save-config --dry-run=client \
    --cert=${HOME}/ingress.api.crt \
    --key=${HOME}/ingress.api.key \
    -o yaml | kubectl --context do-sfo2-k8s-gauzy apply -f -
```

The `--save-config --dry-run=client` pattern enables idempotent create-or-update.

## K8s Manifests

Kubernetes manifests live in `.deploy/k8s/` and use environment variable substitution:

```bash
envsubst < .deploy/k8s/k8s-manifest.prod.yaml | kubectl apply -f -
```

The `envsubst` command replaces `${VARIABLE}` placeholders in the manifest with actual values from GitHub Secrets. This covers all application configuration: database, auth, plugins, mail, and monitoring.

## Container Registry

Images are pushed to three registries during CI, with DigitalOcean serving as one of the deployment sources:

| Registry | Image Pattern |
|---|---|
| GHCR (primary) | `ghcr.io/ever-works/ever-works-api:latest` |
| Docker Hub | `everco/ever-works-api:latest` |
| DigitalOcean | `registry.digitalocean.com/ever/ever-works-api:latest` |

Registry authentication uses `doctl registry login` with short-lived (3600s) credentials.

## Managed PostgreSQL

The production database is a DigitalOcean Managed PostgreSQL instance with SSL/TLS required.

### SSL Configuration

The database CA certificate is provided as a base64-encoded GitHub Secret (`DATABASE_CA_CERT`). During deployment, it is decoded and written to a file:

```bash
echo "$DB_CA_CERT" | base64 --decode > ${HOME}/ca-certificate.crt
```

The application connects using:

| Variable | Value |
|---|---|
| `DATABASE_TYPE` | `postgres` |
| `DATABASE_URL` | Connection string with SSL |
| `DATABASE_SSL_MODE` | `true` |
| `DATABASE_CA_CERT` | Base64-encoded CA certificate |

The database configuration in `database.config.ts` processes SSL options:

```typescript
if (config.database.sslMode()) {
    baseConfig.ssl = getTlsOptions(true, config.database.databaseCaCert());
}
```

## Deployment Flow

```
GitHub Actions (deploy-do-prod.yml)
    |
    +-- Install doctl
    |
    +-- Save kubeconfig (600s TTL)
    |
    +-- Write PostgreSQL CA cert
    |
    +-- Generate TLS secrets for Ingress
    |
    +-- envsubst + kubectl apply (K8s manifests)
    |
    +-- kubectl rollout restart (API + Web deployments)
```

## Environment Variables in Production

The deployment workflow injects a comprehensive set of environment variables into the K8s manifests:

| Category | Key Variables |
|---|---|
| **Application** | `WEB_URL`, `ALLOWED_ORIGINS` |
| **Auth** | `JWT_SECRET`, `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **OAuth Callbacks** | `GH_CALLBACK_URL`, `GOOGLE_CALLBACK_URL` |
| **Database** | `DATABASE_TYPE`, `DATABASE_URL`, `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_SSL_MODE`, `DATABASE_CA_CERT` |
| **Trigger.dev** | `TRIGGER_ENABLED`, `TRIGGER_SECRET_KEY`, `TRIGGER_INTERNAL_SECRET` |
| **Plugins** | `PLUGIN_OPENROUTER_API_KEY`, `PLUGIN_GITHUB_CLIENT_ID`, `PLUGIN_TAVILY_API_KEY`, `PLUGIN_SCREENSHOTONE_ACCESS_KEY` |
| **Mail** | `MAILER_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `RESEND_APIKEY` |

## Rollout Strategy

The current deployment strategy uses `:latest` tag with rolling restarts:

```bash
kubectl rollout restart deployment/ever-works-api
kubectl rollout restart deployment/ever-works-web
```

This triggers Kubernetes to recreate pods, pulling the latest image from the registry. Kubernetes handles rolling updates to maintain zero-downtime deployments.

## Access Control

| Credential | Scope | Lifetime |
|---|---|---|
| `DIGITALOCEAN_ACCESS_TOKEN` | doctl API access | Long-lived (GitHub Secret) |
| kubeconfig credentials | Cluster access | 600 seconds |
| Registry login | Image pull/push | 3600 seconds |
| TLS certificates | Ingress termination | Until manual rotation |
