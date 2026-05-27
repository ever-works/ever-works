import { CacheModule } from '@nestjs/cache-manager';
import { CacheEntry } from '../entities/cache.entity';
import { DataSource } from 'typeorm';
import { TypeORMKeyvAdapter } from './typeorm-keyv.adapter';
import { TypeOrmModule } from '@nestjs/typeorm';

type CacheOptions = {
    ttl?: number;
    namespace?: string;
    isGlobal?: boolean;
};

/**
 * Wire either an in-process or a DB-backed cache into a Nest module.
 *
 * **Pick the right variant for the consistency you need:**
 *
 *   - **`InMemory()`** — default cache-manager LRU, per-process. Cheap
 *     and synchronous. In a multi-pod deployment each pod has its
 *     OWN cache; writes from one pod don't reach the others, and
 *     invalidations only invalidate locally. Same horizontal-scaling
 *     gotcha as the template's `session-cache` and `category-file`.
 *     Use only for caches that tolerate per-pod drift (e.g. memoised
 *     expensive computations where staleness is harmless).
 *
 *   - **`TypeORM({...})`** — backed by the `cache_entries` table via
 *     {@link TypeORMKeyvAdapter}. Survives restart, shared across
 *     pods. Pays one Postgres round-trip per get/set. Use when
 *     cross-pod consistency or restart-durability matters (the
 *     distributed-task-lock service sits on this same table).
 *
 *   - **`isGlobal: true`** registers the cache module globally so
 *     child modules don't need to re-import it. Convenience flag,
 *     no security implications.
 */
export const CacheFactory = {
    InMemory() {
        return CacheModule.register();
    },

    TypeORM(options?: CacheOptions) {
        return CacheModule.registerAsync({
            imports: [TypeOrmModule.forFeature([CacheEntry])],
            inject: [DataSource],
            isGlobal: options?.isGlobal,
            useFactory: async (dataSource: DataSource) => {
                const repository = dataSource.getRepository(CacheEntry);

                // Create the TypeORM adapter
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
