import { buildVerdict, type SafetyRailMiddleware } from '../safety-rails';

/**
 * Rail 4 — connections and tool grants, unchanged.
 *
 * The tool-grant matrix (audit item G4) already resolves four scopes with a
 * narrow-only merge over a permissive default, and already has one decision
 * point: `TOOL_GRANT_ENFORCER.decide()`. This rail delegates to it and
 * re-implements nothing. What it adds is the thing grants never had — the
 * refusal appearing in a queryable log under a published reason code, so an
 * owner can see that a tool call was refused and by which rail.
 *
 * Grants are folded once at descriptor-assembly time today
 * (`resolveGrantedTools`). Evaluating them here as well is what closes the
 * mid-run grant-change gap: a grant revoked while a run is in flight now
 * takes effect at the next tool call instead of at the next run.
 *
 * FAIL OPEN on an unbound port and on an error, matching the enforcer's own
 * documented posture: an access matrix that fails closed when its own wiring
 * is missing would take the product down on a DI mistake, and the resolver's
 * default is permissive anyway.
 */
export const grantsRail: SafetyRailMiddleware = async (context, next) => {
    const { grants, toolName, subject, logger } = context;
    if (!grants || !toolName) return next();

    let decision: { allowed: boolean; reason?: string | null };
    try {
        decision = await grants.isToolAllowed(subject, toolName);
    } catch (error) {
        logger.warn(
            `Safety gate: tool grants could not be resolved for "${toolName}" ` +
                `— deferring to the assembly-time grant set: ${
                    error instanceof Error ? error.message : String(error)
                }`,
        );
        return next();
    }
    if (decision.allowed) return next();

    return buildVerdict({
        decision: 'refused',
        railId: 'grants',
        reasonCode: 'grant-denied',
        context,
        summary: decision.reason?.trim()
            ? decision.reason
            : `"${toolName}" is not granted in this scope.`,
    });
};
