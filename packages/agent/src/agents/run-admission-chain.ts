import type { RunCreditsPrecheck } from './run-credits-precheck';

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
 * This is a STRUCTURAL change only. `DEFAULT_RUN_ADMISSION_CHAIN`
 * reproduces the previous behaviour exactly, token for token and log
 * line for log line: Work valve first, then org/user valve, then the
 * (kill-switched, fail-open) credits precheck.
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
 */
export const orgConcurrencyAdmission: RunAdmissionMiddleware = async (context, next) => {
    const { input, counters, logger } = context;
    const limit = context.resolveOrgLimit();
    if (limit <= 0) return next();
    const inFlight = input.organizationId
        ? await counters.countInFlightForOrganization(input.organizationId)
        : await counters.countInFlightForUser(input.userId);
    if (inFlight < limit) return next();
    logger.log(
        `Dispatch gate: ${
            input.organizationId ? `org ${input.organizationId}` : `user ${input.userId}`
        } at ${inFlight}/${limit} in-flight runs — queueing.`,
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
