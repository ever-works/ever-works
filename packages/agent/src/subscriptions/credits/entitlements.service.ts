import { Injectable } from '@nestjs/common';
import { PlanEntitlementRepository } from '@src/database/repositories/plan-entitlement.repository';
import { config } from '@src/config';

/** Seeded entitlement keys (free plan) — see the 1783400000000 migration. */
export const ENTITLEMENT_KEYS = {
    DAILY_FREE_CREDITS: 'daily-free-credits',
    MAX_CONCURRENT_RUNS: 'max-concurrent-runs',
    WORKS_LIMIT: 'works-limit',
    /**
     * Pricing Wave 9 M2 — whether the plan's runs are billed against the
     * credits balance (1 = credit-limited, 0/absent = not). Consumed by
     * the dispatch gate's soft-enforcement precheck: only a
     * credit-limited plan with balance ≤ 0 parks new runs (and only when
     * `CREDITS_ENFORCEMENT=on`). No row seeded yet — every plan resolves
     * to the fallback 0, keeping enforcement doubly dark.
     */
    CREDIT_LIMITED: 'credit-limited',
} as const;

type CacheSlot = {
    value: number | string | null;
    /** epoch ms after which the slot is stale. */
    expiresAt: number;
};

/**
 * Plan-entitlement reads (pricing Wave 9 M1) with a small in-memory TTL
 * cache (`CREDITS_ENTITLEMENTS_CACHE_TTL_MS`, default 60s).
 *
 * `planId` is the plan CODE (`subscription_plans.code`). A missing row
 * resolves to the caller-supplied fallback — entitlements are additive
 * plan levers, so "no row" always means "use the platform default",
 * never an error.
 */
@Injectable()
export class EntitlementsService {
    private readonly cache = new Map<string, CacheSlot>();

    constructor(private readonly planEntitlementRepository: PlanEntitlementRepository) {}

    /**
     * Resolve one entitlement lever for a plan. Returns `valueInt` when
     * set, else `valueText`, else the fallback.
     */
    async get<T extends number | string | null>(
        planId: string,
        key: string,
        fallback: T,
    ): Promise<number | string | T> {
        const cacheKey = `${planId}:${key}`;
        const now = Date.now();
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return cached.value ?? fallback;
        }

        const row = await this.planEntitlementRepository.findByPlanAndKey(planId, key);
        const value = row ? (row.valueInt ?? row.valueText ?? null) : null;
        this.cache.set(cacheKey, {
            value,
            expiresAt: now + config.billing.credits.getEntitlementsCacheTtlMs(),
        });
        return value ?? fallback;
    }

    /** Typed convenience for numeric levers (limits, credit amounts). */
    async getNumber(planId: string, key: string, fallback: number): Promise<number> {
        const value = await this.get(planId, key, fallback);
        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Drop all cached slots (tests + admin edits). */
    clearCache(): void {
        this.cache.clear();
    }
}
