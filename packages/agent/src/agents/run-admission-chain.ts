import type { RunCreditsPrecheck } from './run-credits-precheck';
import type { RunPlanLimits } from './run-plan-limits';

/**
 * Pre-run admission chain (judgment layer G15).
 *
 * The pre-run path used to be ONE imperative method: count the Work's
 * in-flight runs, then the org's, then maybe consult credits — three
 * unrelated policies welded into a single `if`-ladder that could not be
 * reordered, reused, unit-tested in isolation, or extended without
 * editing the method every time.
 *
 * This file makes each policy a MIDDLEWARE: `(ctx, next) => Promise<result>`.
 * A middleware either short-circuits with a verdict or calls `next()`.
 * {@link composeRunAdmission} folds a list into one callable, so the
 * order is data (`DEFAULT_RUN_ADMISSION_CHAIN`) rather than control flow.
 *
 * The refactor that introduced this file was a STRUCTURAL change only.
 * The shipped order today is: Work valve, org/user valve, then the
 * (kill-switched, fail-open) credits precheck.
 *
 * The org valve additionally folds in the plan's `max-concurrent-runs`
 * entitlement as a RAISE-ONLY adjustment — see its docblock for why it
 * may never lower a ceiling.
 */

/** Stamped when the gate parks a run for concurrency. Re-exported by the gate service. */
export const QUEUED_REASON_CONCURRENCY = 'concurrency-limit' as const;

/** Stamped when the soft credits precheck parks a run. Re-exported by the gate service. */
export const QUEUED_REASON_INSUFFICIENT_CREDITS = 'insufficient-credits' as const;

export interface RunAdmissionInput {
    userId: string;
    workId?: string | null;
    organizationId?: string | null;
}

export interface RunAdmissionVerdict {
    admitted: boolean;
    /** Set only when `admitted === false`. */
    queuedReason?: string;
}

/** The narrow slice of `AgentRunRepository` the chain actually counts with. */
export interface RunAdmissionCounters {
    countInFlightForWork(workId: string): Promise<number>;
    countInFlightForOrganization(organizationId: string): Promise<number>;
    countInFlightForUser(userId: string): Promise<number>;
}

/** Just enough of a Nest `Logger` to keep the chain framework-free. */
export interface RunAdmissionLogger {
    log(message: string): void;
    warn(message: string): void;
}

/**
 * Everything a middleware may read. Limits arrive as THUNKS, not
 * numbers, so the documented per-Work override column can slot in
 * behind `resolveWorkLimit` without touching a single middleware.
 */
export interface RunAdmissionContext {
    readonly input: RunAdmissionInput;
    readonly counters: RunAdmissionCounters;
    readonly logger: RunAdmissionLogger;
    readonly resolveWorkLimit: () => number;
    readonly resolveOrgLimit: () => number;
    readonly isCreditsEnforcementEnabled: () => boolean;
    readonly creditsPrecheck?: RunCreditsPrecheck;
    readonly isPlanConcurrencyEnabled: () => boolean;
    readonly planLimits?: RunPlanLimits;
}

export type RunAdmissionNext = () => Promise<RunAdmissionVerdict>;

export type RunAdmissionMiddleware = (
    context: RunAdmissionContext,
    next: RunAdmissionNext,
) => Promise<RunAdmissionVerdict>;

/** The verdict a chain that never short-circuits ends on. */
export const RUN_ADMISSION_ADMITTED: RunAdmissionVerdict = { admitted: true };

/**
 * Fold middlewares into one callable. Runs left to right; the first one
 * that returns without calling `next()` decides. A middleware that
 * calls `next()` twice is a bug and is refused loudly — silently
 * double-running the tail would double-count in-flight runs.
 */
export function composeRunAdmission(
    chain: readonly RunAdmissionMiddleware[],
): (context: RunAdmissionContext) => Promise<RunAdmissionVerdict> {
    return async (context: RunAdmissionContext) => {
        let lastCalled = -1;
        const dispatch = async (index: number): Promise<RunAdmissionVerdict> => {
            if (index <= lastCalled) {
                throw new Error('run admission middleware called next() more than once');
            }
            lastCalled = index;
            const middleware = chain[index];
            if (!middleware) return RUN_ADMISSION_ADMITTED;
            return middleware(context, () => dispatch(index + 1));
        };
        return dispatch(0);
    };
}

/**
 * Per-Work concurrency valve. A limit of `<= 0` disables it entirely —
 * and, importantly, skips the count query, which is what the "valve of
 * 0 never touches the repository" contract depends on.
 */
export const workConcurrencyAdmission: RunAdmissionMiddleware = async (context, next) => {
    const { input, counters, logger } = context;
    const limit = context.resolveWorkLimit();
    if (!input.workId || limit <= 0) return next();
    const inFlight = await counters.countInFlightForWork(input.workId);
    if (inFlight < limit) return next();
    logger.log(
        `Dispatch gate: Work ${input.workId} at ${inFlight}/${limit} in-flight runs — queueing.`,
    );
    return { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY };
};

/**
 * Per-org valve, falling back to per-user when the run has no org. Same
 * `<= 0` disables semantics as the Work valve.
 *
 * The plan's `max-concurrent-runs` entitlement is folded in here as a
 * RAISE-ONLY adjustment — `max(envLimit, planLimit)`, and a plan whose
 * value is `<= 0` (the "unlimited" sentinel) switches the valve off.
 *
 * 🛑 Raise-only is not a style choice, it is what makes this safe. Three
 * things break if a plan may LOWER the ceiling:
 *
 *  1. **Parked runs would be unrecoverable.** The drain is Work-keyed:
 *     `findOldestQueuedForConcurrency` filters `run.workId`, and every
 *     caller passes the workId of a run that just went terminal. A valve
 *     scoped to the USER can park a run in a Work that then has no
 *     terminal transition to fire a drain — precisely the cross-Work case
 *     the valve exists for. The run sits `queued` until the sweeper
 *     mislabels it `stuck-timeout`.
 *  2. **It would be a cut for every existing user.** Nothing read this
 *     entitlement before, so the ENFORCED status quo is this valve's env
 *     default (25). The `free` row seeded at 3 would take everyone from
 *     25 to 3 on the first deploy.
 *  3. **The plan can be resolved wrongly.** A seat-holder on someone
 *     else's Enterprise org, and anyone whose plan row exists while
 *     `defaultPlanId` still says free, both resolve to `free`.
 *
 * Raise-only makes all three moot: this can never park a run that would
 * not already have parked, so a wrong answer can only over-deliver.
 *
 * The per-Work valve bounds everything above it — but only on runs that
 * carry a workId AND when that valve is itself enabled, which is why the
 * unlimited sentinel checks both before bypassing.
 *
 * The plan allowance is measured against the BUYER's own in-flight count,
 * never the org's: the entitlement is per-user, and applying it to an org
 * counter would share one member's paid capacity with all of them.
 */
export const orgConcurrencyAdmission: RunAdmissionMiddleware = async (context, next) => {
    const { input, counters, logger } = context;
    const envLimit = context.resolveOrgLimit();

    // Resolved up front but consulted ONLY after the env valve has decided to
    // park. That ordering is what keeps the plan adjustment raise-only: it can
    // exempt a run, never park one.
    let planLimit: number | null = null;
    if (context.planLimits && context.isPlanConcurrencyEnabled()) {
        try {
            planLimit = await context.planLimits.resolveConcurrencyLimit(input.userId);
        } catch (err) {
            // Fail open on the ENV limit: a broken billing lookup must never
            // change how much work the platform will accept.
            logger.warn(
                `Dispatch gate: plan concurrency lookup failed for user ${input.userId} ` +
                    `(keeping the env limit): ${err}`,
            );
        }
    }

    if (envLimit <= 0) return next();

    const scopedToOrg = Boolean(input.organizationId);
    const inFlight = scopedToOrg
        ? await counters.countInFlightForOrganization(input.organizationId as string)
        : await counters.countInFlightForUser(input.userId);
    if (inFlight < envLimit) return next();

    // The env valve would park this run. A plan entitlement may exempt the
    // BUYER — and only the buyer.
    //
    // 🛑 The entitlement is per-USER (subscriptions hang off `userId`;
    // `Organization` carries no plan at all), so it must never be measured
    // against the ORG counter. Raising the org ceiling because one member
    // bought Enterprise would hand that capacity to every colleague, and let
    // them consume the allowance the buyer paid for. Their own in-flight count
    // is the only number their plan has an opinion about.
    if (planLimit !== null) {
        if (planLimit < 0) {
            // Unlimited tier. This lifts the PLAN ceiling, not the operator's
            // last line of defence — so bypass only when a per-Work valve is
            // genuinely still bounding this run.
            //
            // Both halves of that condition are load-bearing.
            // `workConcurrencyAdmission` returns next() when EITHER there is no
            // workId (heartbeats pass `workId: null` deliberately) OR the Work
            // limit is `<= 0` (a supported way to disable that valve). Checking
            // only for a workId would let an unlimited plan plus
            // `AGENT_MAX_CONCURRENT_RUNS_PER_WORK=0` bypass every valve in the
            // chain at once.
            if (input.workId && context.resolveWorkLimit() > 0) {
                return next();
            }
        } else if (planLimit > 0) {
            // Reuse the count when it is already the user's own — the non-org
            // path measures exactly that, so this costs a query only inside an
            // org, and only on the path that was about to park anyway.
            const ownInFlight = scopedToOrg
                ? await counters.countInFlightForUser(input.userId)
                : inFlight;
            if (ownInFlight < planLimit) {
                return next();
            }
        }
        // planLimit === 0 -> an explicit "no plan ceiling"; the env valve stands.
    }

    // Name the plan when it was consulted and still did not exempt the run, so
    // an operator who set AGENT_MAX_CONCURRENT_RUNS_PER_ORG can tell their own
    // valve firing from an entitlement that declined to lift it.
    const planNote =
        planLimit !== null && planLimit !== 0 ? ` (plan allowance ${planLimit} not met)` : '';
    logger.log(
        `Dispatch gate: ${
            input.organizationId ? `org ${input.organizationId}` : `user ${input.userId}`
        } at ${inFlight}/${envLimit}${planNote} in-flight runs — queueing.`,
    );
    return { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY };
};
/**
 * Soft credits enforcement (ship-dark). Runs ONLY when the kill-switch
 * is on AND the precheck token is bound. Fail-open on any error: a
 * broken billing check must never stop work.
 */
export const creditsAdmission: RunAdmissionMiddleware = async (context, next) => {
    const { input, logger, creditsPrecheck } = context;
    if (!creditsPrecheck || !context.isCreditsEnforcementEnabled()) return next();
    try {
        if (await creditsPrecheck.shouldQueueForCredits(input.userId)) {
            logger.log(
                `Dispatch gate: user ${input.userId} is credit-limited with an ` +
                    `exhausted balance — queueing.`,
            );
            return { admitted: false, queuedReason: QUEUED_REASON_INSUFFICIENT_CREDITS };
        }
    } catch (err) {
        logger.warn(
            `Dispatch gate: credits precheck failed for user ${input.userId} (fail-open): ${err}`,
        );
    }
    return next();
};

/**
 * The shipped order. Concurrency wins over credits by construction —
 * a saturated Work parks with `concurrency-limit` and never spends a
 * billing query, which is exactly what the pre-refactor ladder did.
 */
export const DEFAULT_RUN_ADMISSION_CHAIN: readonly RunAdmissionMiddleware[] = [
    workConcurrencyAdmission,
    orgConcurrencyAdmission,
    creditsAdmission,
];
