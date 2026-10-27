/**
 * APW-10 T27 / APW-06 T45 (lane aw-safety, 2026-10-26) — the seam `ConfigAppsTierPolicy.eligibility`
 * reads once the managed tier is open. The facts live in the API (`AppsTierEligibilityService`:
 * the account's email, the plan, the owner's App Works on the tier); the isolated worker reaches
 * the same service over the internal channel (`workerAppsTierEligibilitySource`).
 *
 * This file imports nothing, so the policy — which both processes construct — can depend on the
 * shapes without loading the database layer.
 */

/** A reason this lane adds to FR-35's list when a fact could not be read (fail-closed). */
export const APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON = 'eligibilityUnavailable';

/** What one evaluation answers — reasons are codes; `counted` names the Works the cap counted. */
export interface AppsTierEligibilityAnswer {
    eligible: boolean;
    reasons: string[];
    /**
     * The cap that was applied, when one was evaluated: `config.everWorks.apps.getMaxPerUser()`
     * for a free/unpaid owner, `getMaxPerPaidUser()` for a paid one (absent when a paid owner has
     * no limit — owner decision 2026-10-27).
     */
    max?: number;
    /** The slugs of the OTHER App Works counted against the cap, when it was reached. */
    counted?: string[];
    /**
     * `true` only beside `capReached` for an owner whose plan was READ as unpaid while billing is
     * on, when a paid plan would admit the App — so the refusal can say that upgrading lifts the
     * limit (owner decision 2026-10-27). Absent otherwise; never a reason of its own.
     */
    paidPlanAllowsMore?: boolean;
}

/** The facts behind `AppsTierPolicy.eligibility` (bound in the API; proxied in the worker). */
export interface AppsTierEligibilitySource {
    evaluate(userId: string, opts?: { workId?: string | null }): Promise<AppsTierEligibilityAnswer>;
}

/** DI token for {@link AppsTierEligibilitySource}. */
export const APPS_TIER_ELIGIBILITY_SOURCE = Symbol('APPS_TIER_ELIGIBILITY_SOURCE');
