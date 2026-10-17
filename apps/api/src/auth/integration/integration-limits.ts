import {
    INTEGRATION_THROTTLE_DEFAULT_READS_PER_MIN,
    INTEGRATION_THROTTLE_DEFAULT_WRITES_PER_MIN,
} from '@ever-works/contracts';

/**
 * EW-P1-2 — the integration principal's own throttle tier (plan doc 02 §2):
 * per KEY, per minute, one bucket for reads and one for writes, replacing the
 * per-route caps (30/min on most writes) for integration keys only. Tunable
 * without a redeploy:
 *
 *   INTEGRATION_THROTTLE_READS_PER_MIN   (default 3000)
 *   INTEGRATION_THROTTLE_WRITES_PER_MIN  (default 600)
 *   INTEGRATION_THROTTLE_BURST_PER_SEC   (default 50 — the global `short` tier)
 */
export interface IntegrationLimits {
    readsPerMin: number;
    writesPerMin: number;
    burstPerSec: number;
}

function envPositiveInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function integrationLimits(): IntegrationLimits {
    return {
        readsPerMin: envPositiveInt(
            'INTEGRATION_THROTTLE_READS_PER_MIN',
            INTEGRATION_THROTTLE_DEFAULT_READS_PER_MIN,
        ),
        writesPerMin: envPositiveInt(
            'INTEGRATION_THROTTLE_WRITES_PER_MIN',
            INTEGRATION_THROTTLE_DEFAULT_WRITES_PER_MIN,
        ),
        burstPerSec: envPositiveInt('INTEGRATION_THROTTLE_BURST_PER_SEC', 50),
    };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A write is anything that is not a safe method. */
export function isWriteMethod(method: unknown): boolean {
    return typeof method === 'string' && !SAFE_METHODS.has(method.toUpperCase());
}
