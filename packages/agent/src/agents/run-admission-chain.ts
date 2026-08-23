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
 * The per-Work valve bounds everything above it — but ONLY on runs that
 * carry a workId. Heartbeats pass `workId: null` and reach this valve with
 * nothing else in front of them, which is why the unlimited sentinel does
 * not switch the valve off there.
 */
export const orgConcurrencyAdmission: RunAdmissionMiddleware = async (context, next) => {
    const { input, counters, logger } = context;
    const envLimit = context.resolveOrgLimit();
    let limit = envLimit;

    if (context.planLimits && context.isPlanConcurrencyEnabled()) {
        try {
            const planLimit = await context.planLimits.resolveConcurrencyLimit(input.userId);
            // `null` = the plan has no opinion; leave the env valve exactly as it
            // was. Deliberately NOT folded in with the `0` case: they used to be
            // the same branch, which let a plan with no entitlement row bypass the
            // org valve entirely instead of falling back to it.
            if (planLimit !== null) {
                if (planLimit < 0) {
                    // Unlimited tier. This lifts the PLAN ceiling, not the
                    // operator's last line of defence: bypass only when the
                    // per-Work valve is actually in play to bound the user.
                    //
                    // 🛑 On the Work-LESS path this valve is the only one in the
                    // chain — `workConcurrencyAdmission` short-circuits on
                    // `!input.workId`, and the heartbeat dispatcher passes
                    // `workId: null` precisely because "the org/user valve is the
                    // one that applies". Switching it off there would leave the
                    // user completely unbounded, which is a capacity failure
                    // rather than the generosity the raise-only argument assumes.
                    if (input.workId) {
                        return next();
                    }
                } else if (planLimit > 0) {
                    limit = Math.max(envLimit, planLimit);
                }
                // planLimit === 0 -> an explicit "no plan ceiling"; keep envLimit.
            }
        } catch (err) {
            // Fail open on the ENV limit: a broken billing lookup must never
            // change how much work the platform will accept.
            logger.warn(
                `Dispatch gate: plan concurrency lookup failed for user ${input.userId} ` +
                    `(keeping the env limit): ${err}`,
            );
        }
    }

    if (limit <= 0) return next();
    const inFlight = input.organizationId
        ? await counters.countInFlightForOrganization(input.organizationId)
        : await counters.countInFlightForUser(input.userId);
    if (inFlight < limit) return next();
    // Name the plan when it moved the ceiling. Without this an operator who set
    // AGENT_MAX_CONCURRENT_RUNS_PER_ORG=25 greps for their own 25 and finds a
    // number they never configured, with nothing pointing at the entitlement.
    const ceilingNote = limit === envLimit ? '' : ` (env ${envLimit}, raised by plan entitlement)`;
    logger.log(
        `Dispatch gate: ${
            input.organizationId ? `org ${input.organizationId}` : `user ${input.userId}`
        } at ${inFlight}/${limit}${ceilingNote} in-flight runs — queueing.`,
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
