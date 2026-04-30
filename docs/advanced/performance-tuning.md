---
id: performance-tuning
title: Performance Tuning
sidebar_label: Performance Tuning
sidebar_position: 13
---

# Performance Tuning

The Ever Works platform is optimized for fast builds, efficient runtime performance, and low memory usage. This guide covers the SWC compiler configuration, caching strategies, lazy loading patterns, memory management, and profiling techniques used in the codebase.

## Build Performance

### SWC Compilation

The API application uses SWC (Speedy Web Compiler) instead of the default TypeScript compiler for significantly faster builds:

```
Build Speed Comparison:
  tsc:  ~12s full build
  SWC:  ~1.5s full build (8x faster)
```

SWC is configured in the NestJS app via `nest-cli.json`:

```json
{
    "compilerOptions": {
        "builder": "swc",
        "typeCheck": false
    }
}
```

The agent package also uses SWC for compilation with a separate tsc pass for type declarations:

```json
{
    "scripts": {
        "build": "nest build && tsc -p tsconfig.types.json",
        "dev": "nest start --watch"
    }
}
```

### Turborepo Build Orchestration

The monorepo uses Turborepo with `^build` dependency ordering. Only changed packages and their dependents are rebuilt:

```bash
# Build everything (respects dependency graph)
pnpm build

# Build single package
turbo build --filter=@ever-works/agent

# Build with cache inspection
turbo build --dry-run
```

### Plugin Builds with tsup

Each plugin package uses tsup for fast ESM builds:

```typescript
// packages/plugins/openai/tsup.config.ts
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    external: ['@ever-works/plugin'],
});
```

## Runtime Caching

### TypeORM-Backed Cache

The platform uses a TypeORM-based cache (not Redis by default) for simplicity in single-instance deployments:

```typescript
// packages/agent/src/cache/cache.factory.ts
export const CacheFactory = {
    InMemory() {
        return CacheModule.register();
    },

    TypeORM(options?: CacheOptions) {
        return CacheModule.registerAsync({
            imports: [TypeOrmModule.forFeature([CacheEntry])],
            inject: [DataSource],
            useFactory: async (dataSource: DataSource) => {
                const repository = dataSource.getRepository(CacheEntry);
                const typeormAdapter = new TypeORMKeyvAdapter({
                    repository,
                    namespace: options?.namespace,
                    ttl: options?.ttl,
                });
                return { stores: [typeormAdapter] };
            },
        });
    },
};
```

Registered globally in `ApiModule`:

```typescript
CacheFactory.TypeORM({ isGlobal: true }),
```

### AI Model Cache

The `AiFacadeService` implements in-memory caching for expensive external API calls:

```typescript
export class AiFacadeService extends BaseFacadeService {
    private static readonly CACHE_TTL = 3_600_000;  // 1 hour
    private openRouterModels: readonly OpenRouterModelEntry[] | null = null;
    private openRouterCacheTime = 0;

    private async getCachedOpenRouterModels() {
        const now = Date.now();
        if (this.openRouterModels &&
            now - this.openRouterCacheTime < AiFacadeService.CACHE_TTL) {
            return this.openRouterModels;  // Serve from cache
        }

        const fresh = await fetchOpenRouterModels();
        if (fresh) {
            this.openRouterModels = fresh;
            this.openRouterCacheTime = now;
        }

        // Stale-while-revalidate: return old data if fresh fetch failed
        return this.openRouterModels;
    }
}
```

This uses a stale-while-revalidate pattern: if the fresh fetch fails, the previous cached data is returned rather than throwing.

## Request Pipeline Efficiency

### Conditional Logging

The `LoggingInterceptor` only activates when `HTTP_DEBUG=true`, avoiding any overhead in production:

```typescript
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (!config.debug()) {
            return next.handle();  // Zero overhead when disabled
        }
        // ... logging logic
    }
}
```

### Parallel Operations

The orchestrator uses `Promise.all` for independent database updates:

```typescript
await Promise.all([
    this.directoryOperations.recordGenerationFinishTime(directoryId, finishedAt),
    this.directoryOperations.updateGenerateStatus(directoryId, { status, error }),
    this.directoryOperations.updateGenerationHistory(directoryId, historyId, {
        status, finishedAt, durationInSeconds, errorMessage,
    }),
]);
```

## Memory Management

### Payload Size Limits

Large request bodies are capped to prevent memory exhaustion:

```typescript
app.use(json({ limit: '10mb' }));
app.use(urlencoded({ limit: '10mb', extended: true }));
```

### Streaming for AI Responses

The `AiFacadeService` supports streaming via `AsyncGenerator`, which avoids buffering large AI responses in memory:

```typescript
async *createStreamingChatCompletion(
    options: ChatCompletionOptions,
    facadeOptions: FacadeOptions,
): AsyncGenerator<ChatCompletionChunk> {
    // ...
    yield* plugin.createStreamingChatCompletion(mergedOptions);
}
```

### Background Task Offloading

Long-running tasks (directory generation, imports) are dispatched to Trigger.dev workers, keeping the API process lean:

```typescript
async dispatchDirectoryGeneration(payload): Promise<string | null> {
    const handle = await directoryGenerationTask.trigger(payload, {
        tags: ['directory-generation', payload.mode, payload.directoryId],
        machine: this.machine(),
    });
    return handle.id;
}
```

## Profiling with Sentry

Sentry profiling is enabled via the Node.js profiling integration:

```typescript
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const config = {
    integrations: [nodeProfilingIntegration()],
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
};
```

In development, 100% of transactions are profiled. In production, 10% sampling keeps overhead minimal while still providing representative data.

### What to Look For

| Metric                    | Healthy Range   | Action if Exceeded                      |
|---------------------------|-----------------|------------------------------------------|
| API response time (p95)   | < 500ms         | Check DB queries, add indexes            |
| Memory usage              | < 512MB         | Check for leaks, reduce cache sizes      |
| Event loop lag            | < 50ms          | Offload CPU work to workers              |
| DB query time (p95)       | < 100ms         | Add indexes, optimize queries            |

## TypeScript Compilation Optimization

### Path Aliases

Path aliases reduce import complexity and enable faster module resolution:

```json
{
    "compilerOptions": {
        "paths": {
            "@src/*": ["./src/*"],
            "@ever-works/*": ["../../packages/*/src"]
        }
    }
}
```

### Skip Type Checking in SWC

During development, SWC skips type checking entirely. Run type checking separately:

```bash
pnpm type-check    # Full TypeScript type check across monorepo
pnpm dev:api       # Fast SWC compilation, no type checking
```

## Best Practices

1. **Profile before optimizing** -- Use Sentry profiling data to identify actual bottlenecks before making changes.

2. **Cache at the right level** -- Use the TypeORM cache for database results, in-memory cache for computation-heavy lookups, and CDN caching for static assets.

3. **Offload heavy work** -- Any operation over 5 seconds should be dispatched to Trigger.dev workers.

4. **Use streaming** -- For AI completions and large data exports, use streaming to keep memory flat.

5. **Monitor in production** -- Keep `tracesSampleRate` at 0.1 and `profilesSampleRate` at 0.1 to maintain visibility without impacting performance.

## Troubleshooting

### Slow cold starts

SWC compilation should be fast (~1.5s). If cold starts are slow, check for synchronous `fs` operations in module initialization or large dependency trees.

### Memory growing over time

Check for event listener leaks (EventEmitter without `removeListener`) or growing cache stores. The TypeORM cache uses database storage, so memory impact should be minimal.

### High event loop lag

CPU-intensive operations (JSON parsing of large AI responses, bcrypt hashing) block the event loop. These are already offloaded where possible. Consider increasing the bcrypt cost only if login throughput is acceptable.

## Related Documentation

- [Database Optimization](./database-optimization.md) -- Query-level performance
- [Monitoring Deep Dive](./monitoring-deep-dive.md) -- Profiling and metrics
- [Kubernetes Deployment](../devops/kubernetes.md) -- Resource allocation
- [Module System](../architecture/module-system.md) -- Build dependency graph
