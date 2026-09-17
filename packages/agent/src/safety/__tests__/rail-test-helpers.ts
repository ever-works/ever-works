import { WORKSPACE_RUNNING, type ResolvedLadder } from '@ever-works/contracts';
import { resolveLadder, type AutonomyGrantRow } from '../trust-ladder';
import type { SafetyRailContext } from '../safety-rails';

/** A silent logger, so a rail's warnings do not pollute the test output. */
export const silentLogger = { log: () => undefined, warn: () => undefined };

export interface MakeContextOverrides extends Partial<Omit<SafetyRailContext, 'ladder'>> {
    ladder?: ResolvedLadder;
    /** Convenience: build the ladder from rows instead of passing one. */
    rows?: readonly AutonomyGrantRow[];
}

/**
 * A bare rail context: nothing bound, no rungs stored, workspace running.
 *
 * Every rail must pass this through — an install with none of the optional
 * ports bound has to behave exactly as it did before this epic landed.
 */
export function makeContext(overrides: MakeContextOverrides = {}): SafetyRailContext {
    const { rows, ladder, ...rest } = overrides;
    return {
        entryPointId: 'sendEmail',
        toolName: 'sendEmail',
        category: 'message.external',
        subject: {
            userId: 'user-1',
            agentId: 'agent-1',
            runId: 'run-1',
            subjectType: 'run',
            subjectId: 'run-1',
            workspaceScopeId: 'org-1',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        },
        ladder: ladder ?? resolveLadder(rows ?? [], { workspaceScopeId: 'org-1' }),
        pause: { ...WORKSPACE_RUNNING },
        logger: silentLogger,
        ...rest,
    };
}

/** One stored rung, with sensible defaults for the fields a test does not care about. */
export function grantRow(partial: Partial<AutonomyGrantRow> = {}): AutonomyGrantRow {
    return {
        id: 'row-1',
        scopeType: 'workspace',
        scopeId: 'org-1',
        category: 'message.external',
        rung: 'ask',
        ...partial,
    } as AutonomyGrantRow;
}
