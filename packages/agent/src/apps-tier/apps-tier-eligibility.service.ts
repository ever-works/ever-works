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
 * | `capReached` | fewer than the owner's cap of OTHER App Works occupy the tier | **enforced** — see below |
 * | `ownerQuarantined` | — | not built (the quarantine domain is APW-10's zone, ⛔) |
 *
 * `capReached` is APW-06's own cap presented by APW-10 ("not a second cap", plan §5.5:715): the
 * limit is read from `config.everWorks.apps` and from nowhere else.
 *
 * ## The cap depends on the owner's plan (owner decision, 2026-10-27)
 *
 * "Max 3 managed apps per owner of an UNPAID plan, verified email required, paid plans can host
 * more than 3 apps."
 *
 * | the Work owner's plan | cap |
 * | --- | --- |
 * | paid (billing on, a plan code outside `UNPAID_PLAN_CODES`) | `getMaxPerPaidUser()` — `EVER_WORKS_APPS_MAX_PER_PAID_USER`, **unset = no limit** |
 * | free / unpaid | `getMaxPerUser()` — `EVER_WORKS_APPS_MAX_PER_USER`, default 3 |
 * | billing switched off | the free cap (no one can be on a paid plan) |
 * | the plan cannot be read | the free cap — **fail closed for the extra allowance**, never open |
 *
 * The plan read is the one `planRequired` uses (`APPS_TIER_PLAN_READER` →
 * `SubscriptionService.resolvePlanForUser`, `UNPAID_PLAN_CODES`), done once per evaluation. A free
 * owner refused `capReached` gets `paidPlanAllowsMore: true` when a paid plan would admit the App,
 * so the refusal can say that upgrading lifts the limit.
 *
 * ## What counts towards the cap
 *
 * The owner's App Works whose runtime-state row is on `ever-works-apps`, has not been removed
 * (`removedAt IS NULL`), and actually occupies the tier — a Deployment recorded, a namespace
 * recorded, or the deploy lock held (`countManagedForOwner`). Paused Apps count (their volumes and
 * dependencies are still there); removed ones do not; a Work merely pointed at the tier with
 * nothing deployed does not. The Work being deployed is never counted against itself, so a
 * redeploy of one of the three is never refused. Since 2026-10-27 an owner can also be OVER the cap
 * with Apps that were all admitted (a downgrade to free, a lowered cap, a paid owner whose plan
 * cannot be read), so a Work that already occupies the tier (a Deployment or namespace recorded on
 * `ever-works-apps`) is never refused `capReached` either — only a NEW App is.
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
    resolvePlanForUser(
        user: unknown,
    ): Promise<{ code?: string | null; hosting?: string | null } | null>;
}

/** DI token for {@link AppsTierPlanReader} — bound to `SubscriptionService` where it is available. */
export const APPS_TIER_PLAN_READER = Symbol('APPS_TIER_PLAN_READER');

/** Plan codes that are NOT paid on the hosted service. */
const UNPAID_PLAN_CODES = new Set(['free', 'selfhosted_community']);

/** What the owner's plan read answers (see `readOwnerPlan`); `null` = unreadable. */
type OwnerPlan = 'paid' | 'unpaid' | 'billing-off';

/** The env var bounding a PAID owner's App Works on the tier (unset = no limit), 2026-10-27. */
export const APPS_MAX_PER_PAID_USER_ENV = 'EVER_WORKS_APPS_MAX_PER_PAID_USER';

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

        // One plan read serves both rules: `planRequired` (opt-in) and the cap (2026-10-27).
        const planRequired = this.paidPlanRequired();
        const plan = planRequired || workId ? await this.readOwnerPlan(ownerId) : null;

        if (planRequired) {
            // Unchanged since #2914: billing switched off => not required; unreadable => refused.
            if (plan === null) {
                reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
            } else if (plan === 'unpaid') {
                reasons.push('planRequired');
            }
        }

        if (workId) {
            // Owner decision 2026-10-27: the free cap binds an UNPAID owner; a paid owner is held
            // only to the operator's optional paid cap. Only a plan READ as paid lifts the free
            // cap; billing off and an unreadable plan both keep it (fail closed).
            const freeMax = config.everWorks.apps.getMaxPerUser();
            const paidMax = config.everWorks.apps.getMaxPerPaidUser();
            const max = plan === 'paid' ? paidMax : freeMax;
            if (max !== null) {
                answer.max = max;
                if (
                    !this.runtimeStates ||
                    typeof this.runtimeStates.countManagedForOwner !== 'function'
                ) {
                    reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
                } else {
                    try {
                        const others = await this.runtimeStates.countManagedForOwner(ownerId, {
                            excludeWorkId: workId,
                        });
                        // A redeploy of an App already ON the tier is never refused for the cap:
                        // it adds nothing to what the owner occupies. Before 2026-10-27 excluding
                        // the Work from its own count was enough; now an owner can be over the cap
                        // with every App admitted (a paid owner whose plan read fails, a downgrade
                        // to free, a lowered cap), and their running Apps must keep redeploying.
                        if (others.count >= max && !(await this.alreadyOnTier(workId))) {
                            reasons.push('capReached');
                            answer.counted = others.names.slice(0, 20);
                            // Tell a free owner that upgrading lifts it: only when billing is on,
                            // the plan was READ as unpaid, and a paid plan would admit this App.
                            if (plan === 'unpaid' && (paidMax === null || others.count < paidMax)) {
                                answer.paidPlanAllowsMore = true;
                            }
                        }
                    } catch (error) {
                        this.warn(`the managed App Works of ${ownerId} could not be counted`, error);
                        reasons.push(APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON);
                    }
                }
            }
        }

        answer.reasons = [...new Set(reasons)];
        answer.eligible = answer.reasons.length === 0;
        return answer;
    }

    /**
     * Whether the Work being deployed already occupies Ever Works Apps: its runtime-state row is on
     * `ever-works-apps`, not removed, and records a Deployment or a namespace (the count's own
     * predicate WITHOUT the deploy lock, so a first Deployment in flight is still a NEW App and the
     * worker's re-check keeps catching two new Apps racing past the cap). Anything unreadable
     * answers `false`: the cap then applies, as before.
     */
    private async alreadyOnTier(workId: string): Promise<boolean> {
        const states = this.runtimeStates;
        if (!states || typeof states.findStateForWorks !== 'function') return false;
        try {
            const row = (await states.findStateForWorks([workId])).get(workId);
            return Boolean(
                row &&
                    row.target === 'ever-works-apps' &&
                    !row.removedAt &&
                    (row.currentDeploymentId || row.namespace),
            );
        } catch (error) {
            this.warn(`the runtime state of ${workId} could not be read`, error);
            return false;
        }
    }

    /** Read at call time, so flipping the switch needs no redeploy of the code. */
    protected paidPlanRequired(): boolean {
        return process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] === 'true';
    }

    /**
     * The Work owner's plan, read once per evaluation (the #2914 read, unchanged):
     * `paid` · `unpaid` · `billing-off` (subscriptions switched off: no one is on a paid plan) ·
     * `null` unreadable (no plan reader, the owner not found, or the read threw).
     *
     * Each rule maps it itself: `planRequired` admits `billing-off` (not required when billing is
     * off) and refuses `null`; the cap lifts ONLY on `paid`, so `billing-off` and `null` keep the
     * free cap. The extra allowance fails closed.
     */
    private async readOwnerPlan(ownerId: string): Promise<OwnerPlan | null> {
        if (!this.plans) return null;
        try {
            if (!this.plans.isEnabled()) return 'billing-off';
            const owner = await this.users!.findById(ownerId);
            if (!owner) return null;
            const plan = await this.plans.resolvePlanForUser(owner);
            const code = typeof plan?.code === 'string' ? plan.code : '';
            return Boolean(code) && !UNPAID_PLAN_CODES.has(code) ? 'paid' : 'unpaid';
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
