import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { config } from '../config';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppRuntimeStateRepository } from '../database/repositories/work-app-runtime-state.repository';
import {
    APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON,
    type AppsTierEligibilityAnswer,
    type AppsTierEligibilitySource,
} from './apps-tier-eligibility.port';

export {
    APPS_TIER_ELIGIBILITY_SOURCE,
    APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON,
    type AppsTierEligibilityAnswer,
    type AppsTierEligibilitySource,
} from './apps-tier-eligibility.port';

/**
 * APW-10 T27 / APW-06 T45 (lane aw-safety, 2026-10-26) — **who may run an App on Ever Works Apps**,
 * the facts behind `AppsTierPolicy.eligibility` (spec FR-35, APW-10 plan §5.5:717).
 *
 * ## The defect this closes (prod risk)
 *
 * `ConfigAppsTierPolicy.eligibility` answered `{ eligible: true }` for every account the moment the
 * tier was open, and `config.everWorks.apps.getMaxPerUser()` (default 3) had no caller: while the
 * tier is open on prod, anyone — an anonymous, unverified account included — could run as many
 * Apps on the managed cluster as they liked.
 *
 * ## The reasons, in the order FR-35 / plan §5.5 lists them
 *
 * | reason | rule | default |
 * | --- | --- | --- |
 * | `emailUnverified` | the person deploying has a verified email (`users.emailVerified`) | **enforced** |
 * | `planRequired` | the Work's owner is on a paid plan (`SubscriptionService.resolvePlanForUser`) | **off** — `EVER_WORKS_APPS_MANAGED_REQUIRE_PAID_PLAN=true` turns it on (owner question) |
 * | `capReached` | fewer than `getMaxPerUser()` OTHER App Works of the owner occupy the tier | **enforced**, cap 3 |
 * | `ownerQuarantined` | — | not built (the quarantine domain is APW-10's zone, ⛔) |
 *
 * `capReached` is APW-06's own cap presented by APW-10 ("not a second cap", plan §5.5:715): the
 * limit is read from `config.everWorks.apps.getMaxPerUser()` and from nowhere else.
 *
 * ## What counts towards the cap
 *
 * The owner's App Works whose runtime-state row is on `ever-works-apps`, has not been removed
 * (`removedAt IS NULL`), and actually occupies the tier — a Deployment recorded, a namespace
 * recorded, or the deploy lock held (`countManagedForOwner`). Paused Apps count (their volumes and
 * dependencies are still there); removed ones do not; a Work merely pointed at the tier with
 * nothing deployed does not. The Work being deployed is never counted against itself, so a
 * redeploy of one of the three is never refused.
 *
 * ## Fail-closed
 *
 * A fact that cannot be read refuses (`eligibilityUnavailable`), it never admits: without the
 * repositories (a graph this service was not composed into) nothing can be counted, and "open"
 * must not mean "unlimited". The cap is only evaluated when the caller names the Work
 * (`opts.workId`), because only then can the Work be excluded from its own count; the deploy
 * preconditions — where workloads are created — always name it.
 */

/** The env switch for the `planRequired` rule (default off — owner question, lane aw-safety). */
export const APPS_MANAGED_REQUIRE_PAID_PLAN_ENV = 'EVER_WORKS_APPS_MANAGED_REQUIRE_PAID_PLAN';

/** The plan read, as narrow as the `planRequired` rule needs it. */
export interface AppsTierPlanReader {
    isEnabled(): boolean;
    resolvePlanForUser(user: unknown): Promise<{ code?: string | null; hosting?: string | null } | null>;
}

/** DI token for {@link AppsTierPlanReader} — bound to `SubscriptionService` where it is available. */
export const APPS_TIER_PLAN_READER = Symbol('APPS_TIER_PLAN_READER');

/** Plan codes that are NOT paid on the hosted service. */
const UNPAID_PLAN_CODES = new Set(['free', 'selfhosted_community']);

@Injectable()
export class AppsTierEligibilityService implements AppsTierEligibilitySource {
    private readonly logger = new Logger(AppsTierEligibilityService.name);

    constructor(
        @Optional() private readonly users?: UserRepository,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly runtimeStates?: WorkAppRuntimeStateRepository,
        @Optional() @Inject(APPS_TIER_PLAN_READER) private readonly plans?: AppsTierPlanReader,
    ) {}

    async evaluate(
        userId: string,
        opts?: { workId?: string | null },
    ): Promise<AppsTierEligibilityAnswer> {
        const reasons: string[] = [];
        const answer: AppsTierEligibilityAnswer = { eligible: false, reasons };
        const workId = typeof opts?.workId === 'string' ? opts.workId.trim() : '';
        let id = typeof userId === 'string' ? userId.trim() : '';
        if (!this.users || (!id && !workId)) {
            reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            return answer;
        }

        // The Work's owner — whose Apps the cap counts and whose plan pays. An event-driven
        // Deployment carries no requester, and is judged as the owner.
        let ownerId = id;
        if (workId) {
            const work = await (this.works?.findById(workId) ?? Promise.resolve(null)).catch(
                () => null,
            );
            if (!work) {
                reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
                return answer;
            }
            ownerId = work.userId || id;
            if (!id) id = ownerId;
        }
        if (!id) {
            reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            return answer;
        }

        let requester: { id: string; emailVerified?: boolean | null } | null = null;
        try {
            requester = await this.users.findById(id);
        } catch (error) {
            this.warn(`the requester of ${id} could not be read`, error);
            reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            return answer;
        }
        if (!requester || requester.emailVerified !== true) {
            reasons.push('emailUnverified');
        }

        if (this.paidPlanRequired()) {
            const paid = await this.ownerIsOnPaidPlan(ownerId);
            if (paid === null) {
                reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            } else if (!paid) {
                reasons.push('planRequired');
            }
        }

        if (workId) {
            const max = config.everWorks.apps.getMaxPerUser();
            answer.max = max;
            if (!this.runtimeStates || typeof this.runtimeStates.countManagedForOwner !== 'function') {
                reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            } else {
                try {
                    const others = await this.runtimeStates.countManagedForOwner(ownerId, {
                        excludeWorkId: workId,
                    });
                    if (others.count >= max) {
                        reasons.push('capReached');
                        answer.counted = others.names.slice(0, 20);
                    }
                } catch (error) {
                    this.warn(`the managed App Works of ${ownerId} could not be counted`, error);
                    reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
                }
            }
        }

        answer.reasons = [...new Set(reasons)];
        answer.eligible = answer.reasons.length === 0;
        return answer;
    }

    /** Read at call time, so flipping the switch needs no redeploy of the code. */
    protected paidPlanRequired(): boolean {
        return process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] === 'true';
    }

    /** `true` paid · `false` not paid · `null` unreadable. Billing switched off ⇒ not required. */
    private async ownerIsOnPaidPlan(ownerId: string): Promise<boolean | null> {
        if (!this.plans) return null;
        try {
            if (!this.plans.isEnabled()) return true;
            const owner = await this.users!.findById(ownerId);
            if (!owner) return null;
            const plan = await this.plans.resolvePlanForUser(owner);
            const code = typeof plan?.code === 'string' ? plan.code : '';
            return Boolean(code) && !UNPAID_PLAN_CODES.has(code);
        } catch (error) {
            this.warn(`the plan of ${ownerId} could not be read`, error);
            return null;
        }
    }

    private warn(what: string, error: unknown): void {
        this.logger.warn(
            `Ever Works Apps eligibility: ${what} (${error instanceof Error ? error.message : String(error)}).`,
        );
    }
}
