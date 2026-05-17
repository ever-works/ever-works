import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * H-17 / H-18 — distributed throttler config with optional Redis backend.
 *
 * **Default (no env set):** in-memory throttler. Fine for single-replica
 * dev / preview, but in a 2+ replica cluster each pod tracks its own
 * counters, so per-endpoint limits effectively multiply by replica count.
 *
 * **`THROTTLER_REDIS_URL` set:** every replica reads/writes the same Redis
 * counters, so a 5/hour limit means 5/hour cluster-wide regardless of pod
 * count. This requires `@nest-lab/throttler-storage-redis` (added in a
 * follow-up PR) — for now we read the env var and log a warning if it's
 * set but the storage package isn't installed.
 *
 * Operators can also tune each tier via env to tighten under attack
 * without redeploying:
 *   THROTTLER_SHORT_TTL_MS / THROTTLER_SHORT_LIMIT
 *   THROTTLER_MEDIUM_TTL_MS / THROTTLER_MEDIUM_LIMIT
 *   THROTTLER_LONG_TTL_MS / THROTTLER_LONG_LIMIT
 */

function envNum(key: string, fallback: number): number {
    const v = process.env[key];
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const throttlerConfig: ThrottlerModuleOptions = {
    throttlers: [
        {
            name: 'short',
            ttl: envNum('THROTTLER_SHORT_TTL_MS', 1000),
            limit: envNum('THROTTLER_SHORT_LIMIT', 50),
        },
        {
            name: 'medium',
            ttl: envNum('THROTTLER_MEDIUM_TTL_MS', 10_000),
            limit: envNum('THROTTLER_MEDIUM_LIMIT', 300),
        },
        {
            name: 'long',
            ttl: envNum('THROTTLER_LONG_TTL_MS', 60_000),
            limit: envNum('THROTTLER_LONG_LIMIT', 1000),
        },
    ],
};

/**
 * H-17/H-18: tries to load `@nest-lab/throttler-storage-redis` lazily. If
 * the dep isn't installed yet we fall back to in-memory and surface a
 * warning at boot so the operator notices the discrepancy.
 *
 * Returns either a `ThrottlerModuleOptions` with the Redis storage wired
 * in, or the in-memory config above unchanged.
 */
export async function buildThrottlerConfig(): Promise<ThrottlerModuleOptions> {
    const redisUrl = process.env.THROTTLER_REDIS_URL?.trim();
    if (!redisUrl) {
        return throttlerConfig;
    }

    try {
        // Dynamic import so the dep is optional. If the storage package
        // isn't installed (current state), we noisily fall back rather
        // than failing the bootstrap.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — peer dep, may not be installed
        const mod = await import('@nest-lab/throttler-storage-redis').catch(() => null);
        if (!mod) {
            // eslint-disable-next-line no-console
            console.warn(
                '[throttler] THROTTLER_REDIS_URL is set but @nest-lab/throttler-storage-redis is not installed — falling back to in-memory throttler. Install the package to enable distributed limits.',
            );
            return throttlerConfig;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ThrottlerStorageRedisService = (mod as any).ThrottlerStorageRedisService;
        return {
            ...throttlerConfig,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            storage: new ThrottlerStorageRedisService(redisUrl) as any,
        };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
            `[throttler] failed to initialize Redis storage (${(err as Error).message}); falling back to in-memory throttler.`,
        );
        return throttlerConfig;
    }
}
