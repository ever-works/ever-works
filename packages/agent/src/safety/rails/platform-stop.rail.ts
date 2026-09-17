import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 1 — the PLATFORM stop flag (EW-778), unchanged.
 *
 * This rail owns no decision of its own. It asks `RUN_KILL_SWITCH`
 * (`agents/run-kill-switch.ts`) the same question the run dispatch gate, the
 * fleet router and the job lease already ask, and reports the answer in the
 * shared vocabulary. Re-implementing "is the platform stopped?" here would
 * give the product two answers that could disagree.
 *
 * Unbound port ⇒ pass-through: an install with no fleet stack has no flag,
 * exactly as the admission chain treats it.
 *
 * 🛑 FAIL CLOSED, and never throw. A flag that could not be read is a REFUSAL,
 * not a pass — the whole point of the flag is to survive the failure that
 * makes it unreadable.
 */
export const platformStopRail: SafetyRailMiddleware = async (context, next) => {
    const { platformStop, logger, subject } = context;
    if (!platformStop) return next();

    let halted: boolean;
    try {
        halted = await platformStop.shouldHaltDispatch();
    } catch (error) {
        logger.warn(
            `Safety gate: the platform stop flag could not be read for user ${subject.userId} ` +
                `— refusing (fail-closed): ${error instanceof Error ? error.message : String(error)}`,
        );
        halted = true;
    }
    if (!halted) return next();

    return buildVerdict({
        decision: 'refused',
        railId: 'platform-stop',
        reasonCode: 'platform-stopped',
        context,
        summary: 'The platform is stopped. No new work starts until an operator clears it.',
    });
};
