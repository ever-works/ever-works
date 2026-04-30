---
id: caching
title: Caching Architecture
sidebar_label: Caching
sidebar_position: 8
---

# Caching Architecture

The Ever Works platform implements caching through a TypeORM-backed cache adapter that integrates with NestJS's cache module. This provides database-persisted caching with TTL support, namespace isolation, and automatic expiration cleanup.

## Architecture

The cache system is located in `packages/agent/src/cache/` and consists of three components:

| File                      | Purpose                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `cache.factory.ts`        | Factory for creating cache module instances                  |
| `typeorm-keyv.adapter.ts` | TypeORM-backed adapter implementing the Keyv store interface |
| `repository.ts`           | TypeORM repository for the CacheEntry entity                 |

## CacheFactory

The `CacheFactory` provides two cache strategies:

### InMemory

A simple in-memory cache suitable for development or single-instance deployments:

```typescript
CacheFactory.InMemory();
// Returns: CacheModule.register()
```

### TypeORM

A database-backed cache that persists across application restarts and works in multi-instance deployments:

```typescript
CacheFactory.TypeORM({
	ttl: 60000, // Default TTL in milliseconds
	namespace: 'my-cache', // Namespace prefix for cache keys
	isGlobal: true // Register as global NestJS module
});
```

The TypeORM strategy:

1. Imports the `CacheEntry` entity via `TypeOrmModule.forFeature()`.
2. Injects the TypeORM `DataSource` to get the repository.
3. Creates a `TypeORMKeyvAdapter` instance with the repository.
4. Returns an `CacheModule.registerAsync()` configuration.

## TypeORMKeyvAdapter

The `TypeORMKeyvAdapter` implements the Keyv store interface using a TypeORM repository. This makes it compatible with NestJS's `CacheModule` which expects a Keyv-compatible store.

### Key Operations

#### Get

```typescript
async get(key: string): Promise<any>
```

1. Constructs the full key: `{namespace}:{key}`.
2. Queries the `CacheEntry` table.
3. Checks TTL expiration -- if expired, deletes the entry and returns `undefined`.
4. Parses and returns the JSON value.

#### Set

```typescript
async set(key: string, value: any, ttl?: number): Promise<any>
```

1. Constructs the full key with namespace prefix.
2. Calculates `expiresAt` timestamp from TTL (or `null` for no expiration).
3. Upserts the entry using TypeORM's `upsert()` (insert or update on conflict).
4. Value is JSON-serialized before storage.

#### Delete

```typescript
async delete(key: string): Promise<boolean>
```

Deletes the entry by full key and returns whether any row was affected.

#### Clear

```typescript
async clear(): Promise<void>
```

Deletes all entries matching the namespace prefix using a SQL `LIKE` pattern:

```sql
DELETE FROM cache_entries WHERE key LIKE '{namespace}:%'
```

#### Has

```typescript
async has(key: string): Promise<boolean>
```

Returns whether an entry exists (does not check expiration).

### TTL and Expiration

TTL values are stored as absolute timestamps (`Date.now() + ttl`). The adapter checks expiration on every `get()` call:

```typescript
if (entry.expiresAt && Date.now() > entry.expiresAt) {
	await this.delete(key);
	return undefined;
}
```

### Bulk Cleanup

The `cleanExpired()` method removes all expired entries in a single query:

```typescript
async cleanExpired(): Promise<number> {
    const result = await this.repository.delete({
        expiresAt: LessThan(Date.now()),
    });
    return result.affected || 0;
}
```

This can be called on a schedule (e.g., via a cron job) to prevent the cache table from growing unbounded.

### Wrap Pattern

The `wrap()` method implements the cache-aside pattern:

```typescript
async wrap<T>(key: string, fn: () => T | Promise<T>, options?: { ttl?: number }): Promise<T>
```

1. Check if the key exists in cache.
2. If cached, return the cached value.
3. If not, execute the factory function `fn()`.
4. Store the result in cache with the specified TTL.
5. Return the result.

Usage:

```typescript
const data = await cache.wrap(
	'my-key',
	async () => {
		return await expensiveComputation();
	},
	{ ttl: 300000 }
); // Cache for 5 minutes
```

### Namespace Isolation

All keys are prefixed with the adapter's namespace (defaults to `app-cache`):

```
app-cache:user:123
app-cache:directory:456:config
```

This allows multiple cache instances with different namespaces to share the same database table without key collisions.

### Unscoped Operations

The `deleteUnscopedEntriesLike()` method bypasses namespace isolation for cross-namespace cleanup:

```typescript
async deleteUnscopedEntriesLike(likeTerm: string): Promise<void>
```

This matches the `LIKE` pattern against the full key (including namespace prefix), useful for invalidating all cache entries related to a specific entity across all namespaces.

### Batch Operations

The `deleteMany()` method deletes multiple keys in parallel:

```typescript
async deleteMany(keys: string[]): Promise<boolean>
```

Returns `true` only if all deletions succeeded.

## Cache Entity

The `CacheEntry` entity (in `entities/cache.entity.ts`) stores cache data:

| Column      | Type              | Description                          |
| ----------- | ----------------- | ------------------------------------ |
| `key`       | string (primary)  | Namespaced cache key                 |
| `value`     | text              | JSON-serialized cached value         |
| `expiresAt` | bigint (nullable) | Expiration timestamp in milliseconds |

## Error Handling

All adapter operations catch errors and emit them via the `EventEmitter` pattern rather than throwing. This prevents cache failures from crashing the application:

```typescript
try {
	// cache operation
} catch (error) {
	this.emit('error', error);
	return undefined; // Graceful fallback
}
```

Consumers can listen for error events to log cache failures without disrupting the request flow.
