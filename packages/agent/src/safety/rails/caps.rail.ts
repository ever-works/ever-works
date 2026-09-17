import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 6 — budgets and caps, unchanged.
 *
 * The budget guard already refuses a metered call above a per-Work or
 * per-Agent ceiling, and AW-17 owns the caps themselves. This rail owns only
 * their POSITION in the published order and their refusal record: a cap is
 * consulted after the ladder because a category the owner switched off must
 * not spend a spend query, and before the category-specific rules because a
 * cap is the cheaper of the two.
 *
 * FAIL CLOSED on an error. This is the one delegating rail that does, and it
 * matches the budget guard's own `unevaluable` posture: a cap that permits
 * whenever it cannot count is not a cap. Unbound port ⇒ pass-through, because
 * an install with no budget stack has no ceiling to exceed.
 */
export const capsRail: SafetyRailMiddleware = async (context, next) => {
    const { caps, category, subject, logger } = context;
    if (!caps || !category) return next();

    let decision: { allowed: boolean; reason?: string | null };
    try {
        decision = await caps.isWithinCaps(subject, category);
    } catch (error) {
        logger.warn(
            `Safety gate: caps could not be evaluated for user ${subject.userId} ` +
                `— refusing (fail-closed): ${error instanceof Error ? error.message : String(error)}`,
        );
        decision = { allowed: false, reason: 'The spend behind this cap could not be read.' };
    }
    if (decision.allowed) return next();

    return buildVerdict({
        decision: 'refused',
        railId: 'caps',
        reasonCode: 'cap-reached',
        context,
        summary: decision.reason?.trim() ? decision.reason : 'A spending cap refused this.',
    });
};
