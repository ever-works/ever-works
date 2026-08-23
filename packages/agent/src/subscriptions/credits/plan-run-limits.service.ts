import { Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '@src/database/repositories/user.repository';
import { config } from '@src/config';
import type { RunPlanLimits } from '@src/agents/run-plan-limits';
import { ENTITLEMENT_KEYS, EntitlementsService } from './entitlements.service';

/**
 * Ceiling on the userId -> planCode cache. Reached only by a pod that has seen
 * this many distinct users inside one TTL window; clearing costs one re-read
 * per active user.
 */
const PLAN_CODE_CACHE_MAX_ENTRIES = 50_000;

type PlanCodeSlot = {
    planCode: string;
    /** epoch ms after which the slot is stale. */
    expiresAt: number;
};

/**
 * Resolves the concurrency ceiling a user's PLAN entitles them to
 * (`plan_entitlements.max-concurrent-runs`), for the dispatch gate.
 *
 * Bound to the `RUN_PLAN_LIMITS` token by the api-side `@Global()`
 * SubscriptionsModule. Before this existed, `max-concurrent-runs` had
 * zero readers anywhere in the product: the number on the pricing page
 * was seeded into the database and consulted by nothing.
 *
 * ## Cost
 *
 * `admit()` is on a hot path — the schedule dispatcher iterates up to
 * `AGENT_DISPATCH_MAX_BATCH` users every `AGENT_DISPATCH_INTERVAL_MINUTES`,
 * plus one call per drain promotion and per fanned-out task. So the
 * userId → planCode hop gets its own short TTL cache here, and the
 * planCode → entitlement hop is already cached by
 * {@link EntitlementsService}. Both TTLs are deliberately short: a plan
 * change should take effect within about a minute, not on the next
 * deploy.
 *
 * ## Never throws
 *
 * Every path resolves to `null` (= unlimited) on error. The middleware
 * fails open too, so this is belt-and-braces: a DB blip must not park
 * every run in the fleet.
 */
@Injectable()
export class PlanRunLimitsService implements RunPlanLimits {
    private readonly logger = new Logger(PlanRunLimitsService.name);
    private readonly planCodeCache = new Map<string, PlanCodeSlot>();

    constructor(
        private readonly userRepository: UserRepository,
        private readonly entitlementsService: EntitlementsService,
    ) {}

    async resolveConcurrencyLimit(userId: string): Promise<number | null> {
        try {
            const planCode = await this.resolvePlanCode(userId);
            if (!planCode) {
                return null;
            }
            // 🛑 "No row" must come back as `null`, never as a number.
            //
            // This used to pass a fallback of `0`, meaning "no plan-level ceiling,
            // only the env valves apply" — but `0` is also the codebase-wide
            // "valve disabled" sentinel, so the consumer read it as UNLIMITED and
            // skipped the org valve entirely. A plan with no entitlement row got
            // no concurrency ceiling of any kind. The producer and the consumer
            // have to agree on the sentinel, so there is now exactly one:
            //
            //   null      -> the plan has no opinion; the env valves stand alone
            //   negative  -> unlimited (ENTITLEMENT_UNLIMITED = -1, what the seed writes)
            //   positive  -> a real ceiling, applied raise-only
            //
            // `EntitlementsService.get` resolves a missing row to the fallback with
            // `??`, so a stored `0` still survives as `0` and stays distinguishable
            // from "absent".
            const raw = await this.entitlementsService.get(
                planCode,
                ENTITLEMENT_KEYS.MAX_CONCURRENT_RUNS,
                null as number | null,
            );
            if (raw === null || raw === undefined) {
                return null;
            }
            const limit = typeof raw === 'number' ? raw : Number(raw);
            return Number.isFinite(limit) ? limit : null;
        } catch (error) {
            this.logger.warn(
                `Plan concurrency lookup failed for user ${userId} (treated as unlimited): ` +
                    `${(error as Error).message}`,
            );
            return null;
        }
    }

    /** Drop all cached plan codes (tests + plan changes that want immediacy). */
    clearCache(): void {
        this.planCodeCache.clear();
    }

    private async resolvePlanCode(userId: string): Promise<string | null> {
        const now = Date.now();
        const cached = this.planCodeCache.get(userId);
        if (cached && cached.expiresAt > now) {
            return cached.planCode;
        }

        // Crude but bounded. The slots are tiny and the TTL is ~60s, so the map
        // only grows through users who dispatched once and never came back; a
        // hard reset at a generous size keeps a long-lived pod flat without the
        // bookkeeping of an LRU on a hot path.
        if (this.planCodeCache.size >= PLAN_CODE_CACHE_MAX_ENTRIES) {
            this.planCodeCache.clear();
        }

        const user = await this.userRepository.findByIdForScheduledRun(userId);
        const planCode =
            (user?.defaultPlan?.code as string | undefined) ||
            config.subscriptions.getDefaultPlanCode();
        this.planCodeCache.set(userId, {
            planCode,
            expiresAt: now + config.billing.credits.getEntitlementsCacheTtlMs(),
        });
        return planCode;
    }
}
