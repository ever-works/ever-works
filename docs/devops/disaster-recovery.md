---
id: disaster-recovery
title: Disaster Recovery
sidebar_label: Disaster Recovery
sidebar_position: 12
---

# Disaster Recovery

This document describes the backup strategies, restore procedures, failover mechanisms, and recovery time objectives for the Ever Works platform deployed on DigitalOcean Kubernetes.

## Infrastructure Overview

```
                      +--------------------------+
                      |    DigitalOcean Cloud     |
                      |  +---------+ +---------+ |
  Internet ---------> |  | Ingress | | Ingress | |
  (app.ever.works)    |  | (Web)   | | (API)   | |
  (api.ever.works)    |  +----+----+ +----+----+ |
                      |       |            |      |
                      |  +----v----+ +-----v---+  |
                      |  | Web x2  | | API x2  |  |
                      |  | pods    | | pods    |  |
                      |  +---------+ +----+----+  |
                      |                   |        |
                      |            +------v------+ |
                      |            | PostgreSQL  | |
                      |            | (Managed)   | |
                      |            +------+------+ |
                      |                   |        |
                      |            +------v------+ |
                      |            | Git Repos   | |
                      |            | (emptyDir)  | |
                      |            +-------------+ |
                      +--------------------------+
```

## Recovery Objectives

| Metric                             | Target     | Notes                                          |
| ---------------------------------- | ---------- | ---------------------------------------------- |
| **RTO** (Recovery Time Objective)  | 15 minutes | Time to restore service after outage detection |
| **RPO** (Recovery Point Objective) | 1 hour     | Maximum acceptable data loss window            |
| **MTTR** (Mean Time To Recover)    | 10 minutes | Average recovery time for pod-level failures   |

## Backup Strategies

### Database Backups (PostgreSQL)

DigitalOcean Managed PostgreSQL provides automated backups:

- **Automated daily backups**: Retained for 7 days by default
- **Point-in-time recovery (PITR)**: Available within the backup retention window
- **Manual snapshots**: Trigger before major migrations via `doctl databases backups create`

Environment variables governing database connectivity:

```yaml
DATABASE_TYPE: postgres
DATABASE_URL: $DATABASE_URL
DATABASE_HOST: $DATABASE_HOST
DATABASE_PORT: $DATABASE_PORT
DATABASE_USERNAME: $DATABASE_USERNAME
DATABASE_PASSWORD: $DATABASE_PASSWORD
DATABASE_NAME: $DATABASE_NAME
DATABASE_SSL_MODE: $DATABASE_SSL_MODE
DATABASE_CA_CERT: $DATABASE_CA_CERT
```

### Container Image Registry

Docker images are pushed to three registries for redundancy during the CI/CD pipeline (`docker-build-publish-prod.yml`):

1. **GitHub Container Registry** (primary): `ghcr.io/ever-works/ever-works-api:latest`
2. **Docker Hub** (secondary): `everco/ever-works-api:latest`
3. **DigitalOcean Registry** (deployment source): `registry.digitalocean.com/ever/ever-works-api:latest`

If one registry is unavailable, images can be pulled from an alternative source.

### Git Repository Data

The API pods mount an `emptyDir` volume at `/tmp/ever-works-repos` with a 5Gi size limit for temporary git repository clones. This data is **ephemeral** by design:

```yaml
volumes:
    - name: git-repos
      emptyDir:
          sizeLimit: 5Gi
```

Git repositories are the source of truth; local clones are regenerated on demand. No backup is required for this volume.

### Application Secrets

Secrets are managed through GitHub Actions encrypted secrets and injected at deployment time via `envsubst`. TLS certificates are stored as Kubernetes secrets:

```bash
kubectl create secret tls app.ever.works-tls \
    --cert=ingress.webapp.crt --key=ingress.webapp.key
kubectl create secret tls api.ever.works-tls \
    --cert=ingress.api.crt --key=ingress.api.key
```

Secret recovery procedure: Re-run the deployment workflow, which regenerates Kubernetes secrets from GitHub Actions secrets.

## Failover Mechanisms

### Pod-Level Failover

Both the API and Web deployments run with 2 replicas and a rolling update strategy:

```yaml
spec:
    replicas: 2
    strategy:
        type: RollingUpdate
        rollingUpdate:
            maxSurge: 1
            maxUnavailable: 0
```

Kubernetes health probes detect and replace unhealthy pods:

| Probe     | Path          | Port                    | Initial Delay | Period | Failure Threshold |
| --------- | ------------- | ----------------------- | ------------- | ------ | ----------------- |
| Liveness  | `/api/health` | 3100 (API) / 3000 (Web) | 30s           | 10s    | 3                 |
| Readiness | `/api/health` | 3100 (API) / 3000 (Web) | 10s           | 5s     | 3                 |

When a liveness probe fails 3 consecutive times, Kubernetes restarts the pod. Readiness failures remove the pod from the service load balancer without restarting it.

### Database Failover

DigitalOcean Managed PostgreSQL handles automatic failover to standby nodes. Connection strings resolve to the primary node automatically after failover.

### DNS and TLS Failover

Ingress resources use NGINX ingress controller with forced SSL redirect:

```yaml
annotations:
    nginx.ingress.kubernetes.io/force-ssl-redirect: 'true'
    nginx.ingress.kubernetes.io/proxy-body-size: '10m'
```

TLS certificates are pre-provisioned as Kubernetes secrets. If cert-manager is used, certificates auto-renew before expiry.

## Restore Procedures

### Procedure 1: Pod Restart (Automatic)

**Trigger**: Health check failure
**Action**: Kubernetes automatically restarts the affected pod
**Recovery Time**: 30-60 seconds (initial delay + readiness check)

### Procedure 2: Full Redeployment

**Trigger**: Corrupted deployment or configuration error

```bash
# Re-run the deployment from the latest passing build
kubectl --context do-sfo2-k8s-gauzy rollout restart deployment/ever-works-api
kubectl --context do-sfo2-k8s-gauzy rollout restart deployment/ever-works-web
```

**Recovery Time**: 2-5 minutes

### Procedure 3: Database Restore

**Trigger**: Data corruption or accidental deletion

1. Create a new database from the most recent backup in the DigitalOcean console
2. Update `DATABASE_*` environment variables in GitHub Actions secrets
3. Re-run the `deploy-do-prod.yml` workflow to apply new connection details
4. Run pending migrations via the API entrypoint:

```bash
# Set RUN_MIGRATIONS=true in environment
# The entrypoint.sh handles migration execution:
node -e "
    const { DataSource } = require('typeorm');
    const dataSource = new DataSource({ ...config, migrations: ['dist/migrations/*.js'] });
    dataSource.initialize().then(() => dataSource.runMigrations());
"
```

**Recovery Time**: 10-15 minutes

### Procedure 4: Full Cluster Recovery

**Trigger**: Cluster-level failure

1. Provision a new Kubernetes cluster via `doctl kubernetes cluster create`
2. Install NGINX ingress controller
3. Regenerate TLS secrets from stored certificates
4. Apply k8s manifests: `envsubst < k8s-manifest.prod.yaml | kubectl apply -f -`
5. Verify health endpoints respond

**Recovery Time**: 15-30 minutes

## Resource Limits

The k8s manifests define resource boundaries to prevent cascade failures:

| Service | CPU Request | CPU Limit | Memory Request | Memory Limit |
| ------- | ----------- | --------- | -------------- | ------------ |
| API     | 500m        | 2 cores   | 512Mi          | 2Gi          |
| Web     | 250m        | 500m      | 256Mi          | 512Mi        |

## Monitoring During Recovery

During DR events, the following monitoring channels provide status:

- **Sentry**: Error spikes and transaction failures (see [Logging & Aggregation](./logging-aggregation.md))
- **Kubernetes events**: `kubectl get events --sort-by=.metadata.creationTimestamp`
- **Pod status**: `kubectl get pods -l app=ever-works-api -w`
- **Trigger.dev dashboard**: Background task execution status

## Cross-References

- [Logging & Aggregation](./logging-aggregation.md) -- monitoring log flow during recovery
- [Performance Monitoring](./performance-monitoring.md) -- detecting performance degradation
- [Deployment UI](../web-dashboard/deployment-ui.md) -- user-facing deployment status
