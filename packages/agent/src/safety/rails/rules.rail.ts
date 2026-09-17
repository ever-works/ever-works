import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 7 — the category-specific rules, unchanged.
 *
 * Merge policy, protected branches and the per-inbox send rules already
 * decide their own questions, at their own call sites, with their own
 * response shapes. This rail delegates to them and re-implements none of it;
 * what it adds is their place in the published order and a refusal record
 * that names them.
 *
 * Last in the order on purpose: these are the most expensive checks and the
 * most specific, and every one of them is moot once something above has
 * refused. A merge policy lookup for an agent whose category is switched off
 * is a query nobody needed.
 *
 * FAIL OPEN on an unbound port and on an error — the authoritative check is
 * still at its own call site, which is where it has always been enforced.
 * This rail reports; it does not replace.
 */
export const rulesRail: SafetyRailMiddleware = async (context, next) => {
    const { rules, category, subject, logger } = context;
    if (!rules || !category) return next();

    let decision: { allowed: boolean; reason?: string | null };
    try {
        decision = await rules.isRuleSatisfied(subject, category);
    } catch (error) {
        logger.warn(
            `Safety gate: category rules could not be evaluated for "${category}" ` +
                `— deferring to the rule's own call site: ${
                    error instanceof Error ? error.message : String(error)
                }`,
        );
        return next();
    }
    if (decision.allowed) return next();

    return buildVerdict({
        decision: 'refused',
        railId: 'rules',
        reasonCode: 'rule-blocked',
        context,
        summary: decision.reason?.trim()
            ? decision.reason
            : `A rule for "${category}" refused this.`,
    });
};
