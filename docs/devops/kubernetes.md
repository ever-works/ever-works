---
id: kubernetes
title: Kubernetes Deployment
sidebar_label: Kubernetes
sidebar_position: 14
---

# Kubernetes Deployment

This guide covers deploying the Ever Works platform to Kubernetes, including manifest configuration, health checks, scaling policies, secrets management, and Helm chart structure.

## Deployment Architecture

```
                         Ingress (nginx / traefik)
                              |
                    +---------+---------+
                    |                   |
              +-----v------+    +------v------+
              | API Service |    | Web Service  |
              | (ClusterIP) |    | (ClusterIP)  |
              +-----+------+    +------+------+
                    |                   |
           +--------+--------+    +----+----+
           |        |        |    |         |
        +--v--+ +--v--+ +--v--+ +--v--+ +--v--+
        | API | | API | | API | | Web | | Web |
        |pod 1| |pod 2| |pod 3| |pod 1| |pod 2|
        +-----+ +-----+ +-----+ +-----+ +-----+
                    |
              +-----v------+
              |  PostgreSQL |   (StatefulSet or managed service)
              +-----+------+
                    |
              +-----v------+
              |   Redis     |   (Optional: rate limit storage)
              +-------------+

        Background Workers:
        +-----+  +-----+
        | Trigger.dev   |   (Separate deployment or external)
        +---------------+
```

## Kubernetes Manifests

### Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
    name: ever-works
    labels:
        app.kubernetes.io/name: ever-works
```

### API Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: ever-works-api
    namespace: ever-works
    labels:
        app: ever-works-api
        component: api
spec:
    replicas: 3
    selector:
        matchLabels:
            app: ever-works-api
    template:
        metadata:
            labels:
                app: ever-works-api
                component: api
        spec:
            containers:
                - name: api
                  image: ever-works/api:latest
                  ports:
                      - containerPort: 3100
                        name: http
                  env:
                      - name: NODE_ENV
                        value: 'production'
                      - name: PORT
                        value: '3100'
                      - name: DATABASE_TYPE
                        value: 'postgres'
                      - name: DATABASE_AUTOMIGRATE
                        value: 'false'
                      - name: DATABASE_URL
                        valueFrom:
                            secretKeyRef:
                                name: api-secrets
                                key: DATABASE_URL
                      - name: JWT_SECRET
                        valueFrom:
                            secretKeyRef:
                                name: api-secrets
                                key: JWT_SECRET
                      - name: SENTRY_DSN
                        valueFrom:
                            secretKeyRef:
                                name: monitoring-secrets
                                key: SENTRY_DSN
                      - name: POSTHOG_API_KEY
                        valueFrom:
                            secretKeyRef:
                                name: monitoring-secrets
                                key: POSTHOG_API_KEY
                      - name: ALLOWED_ORIGINS
                        value: 'https://app.example.com'
                  resources:
                      requests:
                          memory: '256Mi'
                          cpu: '250m'
                      limits:
                          memory: '512Mi'
                          cpu: '1000m'
                  livenessProbe:
                      httpGet:
                          path: /health
                          port: http
                      initialDelaySeconds: 30
                      periodSeconds: 10
                      timeoutSeconds: 5
                      failureThreshold: 3
                  readinessProbe:
                      httpGet:
                          path: /health
                          port: http
                      initialDelaySeconds: 10
                      periodSeconds: 5
                      timeoutSeconds: 3
                      failureThreshold: 3
                  startupProbe:
                      httpGet:
                          path: /health
                          port: http
                      initialDelaySeconds: 5
                      periodSeconds: 5
                      failureThreshold: 12
```

### API Service

```yaml
apiVersion: v1
kind: Service
metadata:
    name: ever-works-api
    namespace: ever-works
spec:
    type: ClusterIP
    selector:
        app: ever-works-api
    ports:
        - port: 3100
          targetPort: http
          protocol: TCP
          name: http
```

### Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
    name: api-secrets
    namespace: ever-works
type: Opaque
stringData:
    JWT_SECRET: 'your-production-jwt-secret'
    DATABASE_URL: 'postgresql://user:password@db-host:5432/ever_works?sslmode=require'
    GH_CLIENT_SECRET: 'github-oauth-secret'
    GOOGLE_CLIENT_SECRET: 'google-oauth-secret'

---
apiVersion: v1
kind: Secret
metadata:
    name: monitoring-secrets
    namespace: ever-works
type: Opaque
stringData:
    SENTRY_DSN: 'https://key@sentry.io/project'
    POSTHOG_API_KEY: 'phc_your_key'
```

Create secrets from the command line (preferred over YAML for production):

```bash
kubectl create secret generic api-secrets \
    --namespace ever-works \
    --from-literal=JWT_SECRET="$(openssl rand -base64 32)" \
    --from-literal=DATABASE_URL="postgresql://..." \
    --from-literal=GH_CLIENT_SECRET="..."
```

### Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
    name: ever-works-api-hpa
    namespace: ever-works
spec:
    scaleTargetRef:
        apiVersion: apps/v1
        kind: Deployment
        name: ever-works-api
    minReplicas: 2
    maxReplicas: 10
    metrics:
        - type: Resource
          resource:
              name: cpu
              target:
                  type: Utilization
                  averageUtilization: 70
        - type: Resource
          resource:
              name: memory
              target:
                  type: Utilization
                  averageUtilization: 80
    behavior:
        scaleUp:
            stabilizationWindowSeconds: 60
            policies:
                - type: Pods
                  value: 2
                  periodSeconds: 60
        scaleDown:
            stabilizationWindowSeconds: 300
            policies:
                - type: Pods
                  value: 1
                  periodSeconds: 120
```

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
    name: ever-works-ingress
    namespace: ever-works
    annotations:
        nginx.ingress.kubernetes.io/rate-limit: '100'
        nginx.ingress.kubernetes.io/rate-limit-window: '1m'
        nginx.ingress.kubernetes.io/ssl-redirect: 'true'
        cert-manager.io/cluster-issuer: 'letsencrypt-prod'
spec:
    ingressClassName: nginx
    tls:
        - hosts:
              - api.example.com
              - app.example.com
          secretName: ever-works-tls
    rules:
        - host: api.example.com
          http:
              paths:
                  - path: /
                    pathType: Prefix
                    backend:
                        service:
                            name: ever-works-api
                            port:
                                number: 3100
        - host: app.example.com
          http:
              paths:
                  - path: /
                    pathType: Prefix
                    backend:
                        service:
                            name: ever-works-web
                            port:
                                number: 3000
```

## Health Checks

The API exposes a health endpoint used by Kubernetes probes:

```typescript
// apps/api/src/api.controller.ts
@Controller()
export class APIController {
	@Public()
	@Get('health')
	healthCheck() {
		return { status: 'ok', timestamp: new Date().toISOString() };
	}
}
```

### Probe Configuration Guide

| Probe     | Purpose                     | Recommended Settings             |
| --------- | --------------------------- | -------------------------------- |
| Startup   | Wait for app to initialize  | delay: 5s, period: 5s, fail: 12  |
| Liveness  | Restart if process is stuck | delay: 30s, period: 10s, fail: 3 |
| Readiness | Remove from LB if not ready | delay: 10s, period: 5s, fail: 3  |

The startup probe gives the application up to 60 seconds (12 failures \* 5s period) to initialize -- enough time for database connections, plugin loading, and Sentry initialization.

## Resource Sizing

| Component | CPU Request | CPU Limit | Memory Request | Memory Limit |
| --------- | ----------- | --------- | -------------- | ------------ |
| API       | 250m        | 1000m     | 256Mi          | 512Mi        |
| Web       | 100m        | 500m      | 128Mi          | 256Mi        |
| Worker    | 500m        | 2000m     | 512Mi          | 1Gi          |

## Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/agent/package.json packages/agent/
COPY packages/monitoring/package.json packages/monitoring/
COPY packages/tasks/package.json packages/tasks/
COPY packages/plugin/package.json packages/plugin/
COPY packages/contracts/package.json packages/contracts/

RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/*/dist ./packages/*/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/

EXPOSE 3100
CMD ["node", "apps/api/dist/main.js"]
```

## Multi-Instance Considerations

When running multiple API replicas:

1. **Rate Limiting** -- In-memory throttler counts are per-instance. Use Redis storage for shared counters (see [Rate Limiting](../advanced/rate-limiting.md)).

2. **Database Connections** -- Each replica opens its own pool. Set `max` connections to `total_db_connections / replica_count`.

3. **Cron Jobs** -- The `@nestjs/schedule` cron tasks run in every replica. Use leader election or run scheduled tasks in a single-replica deployment.

4. **WebSocket/SSE** -- If using real-time features, use Redis pub/sub for cross-instance communication.

## Best Practices

1. **Use managed databases** -- Run PostgreSQL as a managed service (RDS, Cloud SQL, Neon) rather than as a pod.

2. **Separate secrets from config** -- Use Kubernetes Secrets for credentials, ConfigMaps for non-sensitive configuration.

3. **Set resource limits** -- Always define both `requests` and `limits` to prevent noisy-neighbor problems.

4. **Use rolling updates** -- The default `RollingUpdate` strategy ensures zero-downtime deployments. The readiness probe prevents traffic to pods that are not ready.

5. **Monitor pod restarts** -- Frequent restarts indicate OOM kills (increase memory limit) or health check failures (increase probe timeouts).

## Troubleshooting

### Pods stuck in CrashLoopBackOff

Check logs with `kubectl logs -n ever-works deploy/ever-works-api`. Common causes: missing secrets, database connection failure, or port conflict.

### Readiness probe failing

The health endpoint requires the full NestJS application to be initialized. Increase `startupProbe.failureThreshold` if plugin loading takes more than 60 seconds.

### OOMKilled events

The API uses more memory during content generation. Increase the memory limit or offload generation to Trigger.dev workers (see [Performance Tuning](../advanced/performance-tuning.md)).

## Related Documentation

- [Configuration Management](../architecture/configuration-management.md) -- Environment variables
- [Rate Limiting](../advanced/rate-limiting.md) -- Multi-instance rate limiting
- [Database Optimization](../advanced/database-optimization.md) -- Connection pooling
- [Monitoring Deep Dive](../advanced/monitoring-deep-dive.md) -- Production monitoring
