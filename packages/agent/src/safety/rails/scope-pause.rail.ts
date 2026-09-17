import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 3 — the Agent / Mission / Run pause, unchanged.
 *
 * Those pauses are statuses on their own records with their own endpoints,
 * and they keep working exactly as they do today (FR-40). This rail gives
 * them a position in the published order and the shared reason display; it
 * decides nothing itself and delegates through the port.
 *
 * Unbound port ⇒ pass-through, because every existing status check still runs
 * where it always did. This rail is additive reporting, not a replacement —
 * which is also why it fails OPEN on an error: the authoritative checks are
 * still in place downstream, and refusing here on a transient read failure
 * would stop work that the real check would have admitted.
 */
export const scopePauseRail: SafetyRailMiddleware = async (context, next) => {
    const { scopePause, subject, logger } = context;
    if (!scopePause) return next();

    let paused: boolean;
    try {
        paused = await scopePause.isScopePaused(subject);
    } catch (error) {
        logger.warn(
            `Safety gate: scope pause could not be read for agent ${subject.agentId ?? 'n/a'} ` +
                `— deferring to the existing status checks: ${
                    error instanceof Error ? error.message : String(error)
                }`,
        );
        return next();
    }
    if (!paused) return next();

    return buildVerdict({
        decision: 'refused',
        railId: 'scope-pause',
        reasonCode: 'scope-paused',
        context,
        summary: 'This agent, mission or run is paused, so nothing new starts for it.',
    });
};
