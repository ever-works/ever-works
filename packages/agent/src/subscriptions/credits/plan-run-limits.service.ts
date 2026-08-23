import { Injectable, Logger } from '@nestjs/common';
import { UserRepository } from '@src/database/repositories/user.repository';
import { config } from '@src/config';
import type { RunPlanLimits } from '@src/agents/run-plan-limits';
import { ENTITLEMENT_KEYS, EntitlementsService } from './entitlements.service';

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
            // Fallback 0 = "no plan-level ceiling", so a plan with no
            // `max-concurrent-runs` row behaves exactly as it did before this
            // service existed: only the two env valves apply.
            const limit = await this.entitlementsService.getNumber(
                planCode,
                ENTITLEMENT_KEYS.MAX_CONCURRENT_RUNS,
                0,
            );
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
