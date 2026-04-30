---
id: scaling
title: Scaling & Performance
sidebar_label: Scaling
sidebar_position: 6
---

# Scaling & Performance

Ever Works is designed to scale from single-instance development to multi-replica production deployments. This document covers the key scaling strategies and performance optimizations.

## Compute Scaling

### Kubernetes Horizontal Scaling

The API and Web deployments on DigitalOcean Kubernetes can be scaled independently:

```bash
kubectl scale deployment/ever-works-api --replicas=3
kubectl scale deployment/ever-works-web --replicas=3
```

The stateless architecture of both applications enables horizontal scaling without code changes. The API stores all persistent state in the database, and Git operations use per-request temporary directories.

### Trigger.dev Worker Scaling

Background generation tasks run on Trigger.dev workers, which scale independently from the API:

- **Machine sizes**: `micro`, `small-1x`, `small-2x`, `medium-1x`, `medium-2x`, `large-1x`, `large-2x`
- Configured via the `TRIGGER_MACHINE` environment variable.
- Tasks can run for up to 5 hours (`maxDuration: 3600 * 5`).
- Multiple tasks can execute in parallel on separate workers.

This offloads heavy AI pipeline processing from the API servers entirely.

## Database Scaling

### Multi-Database Support

Ever Works supports three database backends with different scaling characteristics:

| Driver | Best For | Scaling Path |
|---|---|---|
| `better-sqlite3` | Development, CLI, single-instance | Vertical only (single writer) |
| `postgres` | Production | Connection pooling, read replicas |
| `mysql` / `mariadb` | Production (alternative) | Connection pooling, read replicas |

### PostgreSQL Connection Management

For PostgreSQL deployments, connection pooling is handled at the driver level through TypeORM's built-in pool:

```typescript
// Connection via URL (supports connection parameters)
{
    type: 'postgres',
    url: 'postgresql://user:pass@host:5432/ever_works?sslmode=require',
}

// Direct host configuration
{
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: '',
    database: 'ever_works',
}
```

DigitalOcean Managed PostgreSQL provides built-in connection pooling via PgBouncer, configurable through the DO dashboard.

### Database SSL/TLS

Production PostgreSQL connections use SSL with a CA certificate:

```typescript
if (config.database.sslMode()) {
    baseConfig.ssl = getTlsOptions(true, config.database.databaseCaCert());
}
```

The CA certificate is provided as a base64-encoded environment variable (`DATABASE_CA_CERT`).

## Caching Strategy

### Database Cache

The `CacheEntry` entity provides a simple key-value cache with TTL support:

```typescript
@Entity({ name: 'cache_entries' })
export class CacheEntry {
    @PrimaryColumn('varchar')
    key: string;

    @Column('text')
    value: string;

    @Column({ type: 'bigint', nullable: true })
    @Index()
    expiresAt: number | null;
}
```

This is used for caching API responses, computed results, and configuration data. The `expiresAt` index enables efficient cleanup of expired entries.

### Git Repository Caching

Cloned repositories are cached on the local filesystem to avoid re-cloning on every operation:

- **API Docker volume**: `/tmp/ever-works-repos` -- persists across container restarts.
- **Clone-or-pull strategy**: The Git facade first attempts a `pull` on an existing clone, falling back to a fresh `clone` if the directory does not exist.

This significantly reduces I/O for frequent operations on the same directory's repositories.

## Concurrency Controls

### Generation Pipeline

Item writing uses controlled concurrency to prevent filesystem and database overload:

```typescript
const PARALLEL_WRITE_CONCURRENCY = 10;
await pMap(items, (item) => dataRepo.writeItem(item), {
    concurrency: PARALLEL_WRITE_CONCURRENCY,
});
```

### Branch Synchronization

Website template branch syncing runs sequentially (concurrency = 1) because the clone-or-pull mechanism uses a deterministic directory path based on `owner+repo`:

```typescript
private readonly MAX_CONCURRENT_SYNCS = 1;
```

Parallel syncs to the same template repository would corrupt the local working directory.

### Rate Limiting

The API uses three-tier rate limiting via `@nestjs/throttler`:

| Tier | Window | Limit | Purpose |
|---|---|---|---|
| `short` | 1 second | 50 requests | Burst protection |
| `medium` | 10 seconds | 300 requests | Sustained load protection |
| `long` | 60 seconds | 1000 requests | Per-minute cap |

All three tiers are applied simultaneously. A request must pass all three checks to proceed.

## Build Performance

### Turborepo Caching

Turborepo orchestrates monorepo builds with dependency-aware caching:

```bash
pnpm build  # Turborepo handles ^build dependency ordering
```

Unchanged packages are skipped based on content hash comparison, significantly reducing CI build times.

### Docker Layer Caching

Docker builds use registry-based layer caching:

```yaml
cache-from: type=registry,ref=ghcr.io/ever-works/ever-works-api:latest
cache-to: type=inline
```

Layers that have not changed (base image, dependency install) are reused from the previous build.

### CI Runner Optimization

CI workflows run on `ubicloud-standard-8` runners (8 cores), providing faster builds than standard GitHub-hosted runners.

## Performance Monitoring

### Sentry Performance

Sentry captures transaction traces with configurable sample rates:
- **Production**: 10% of transactions and profiles.
- **Development**: 100% (full visibility).

### PostHog API Tracking

The PostHog interceptor tracks every API request with:
- Response time (duration in milliseconds).
- Endpoint pattern (normalized for grouping).
- Status code distribution.

This data is available in PostHog dashboards for performance analysis.

## Scaling Considerations

### Git Operations

Git clone and push operations are I/O intensive and can be bottlenecks at scale:
- Each generation run clones up to 3 repositories (data, markdown, website template).
- The `/tmp/ever-works-repos` volume caches clones to reduce re-cloning.
- For high-volume deployments, consider network-attached storage with high IOPS.

### AI API Rate Limits

Generation tasks call external AI APIs (OpenAI, Anthropic, etc.) which have their own rate limits:
- The pipeline system handles retries and backoff internally.
- The circuit breaker pattern in the pipeline can degrade gracefully when providers are unavailable.
- Consider multiple AI provider accounts for high-throughput generation.

### Database Indexes

Key indexes are defined on entities to optimize common queries:

| Entity | Index | Query Pattern |
|---|---|---|
| `DirectoryGenerationHistory` | `[directoryId, status]` | History by directory and status |
| `DirectorySchedule` | `[status, nextRunAt]` | Finding due schedules |
| `UserSubscription` | `[userId, status]` | Active subscription lookup |
| `Notification` | `[userId, isRead]` | Unread notification count |
| `UsageLedgerEntry` | `[userId, status]` | Billing aggregation |
