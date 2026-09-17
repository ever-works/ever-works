import {
    RAIL_REFUSAL_SUMMARY_MAX,
    SAFETY_ALLOW,
    type ActionCategory,
    type RailRefusalSubjectType,
    type ResolvedLadder,
    type SafetyCeiling,
    type SafetyDecision,
    type SafetyRailId,
    type SafetyReasonCode,
    type SafetyVerdict,
    type WorkspacePauseState,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — the composition idiom, and what a rail may read.
 *
 * This is a straight port of `composeRunAdmission` in
 * `agents/run-admission-chain.ts`, including its "called `next()` more than
 * once" guard. That is deliberate: the repo already has one composable
 * policy-chain idiom with the order expressed as data, and inventing a second
 * one is how two security-relevant orderings start disagreeing.
 *
 * ## What a rail may read — and why the type is the enforcement
 *
 * FR-15 is the load-bearing requirement of this whole epic: no rail decision
 * may read any value the model can write. Instructions, standing
 * instructions, skill bodies, Memory facts, Knowledge Base documents, tool
 * ARGUMENTS, model output, chat messages and file contents are not inputs.
 *
 * {@link SafetyRailContext} is how that is kept true rather than remembered:
 * it carries an entry-point id, a classified category, identifiers, and ports
 * onto persisted state. There is no field a model can reach, so a rail cannot
 * accidentally consult one — and a change that added such a field would have
 * to be written here, in the open, rather than buried in a call site.
 */

/** Who or what is trying to act. Identifiers only — never a payload. */
export interface SafetyRailSubject {
    userId: string;
    agentId?: string | null;
    runId?: string | null;
    subjectType: RailRefusalSubjectType;
    subjectId?: string | null;
    /** The Organization id, or the tenant id for a bare-tenant workspace. */
    workspaceScopeId: string;
    tenantId?: string | null;
    organizationId?: string | null;
}

/** The platform stop flag, read through the existing port. */
export interface SafetyPlatformStop {
    shouldHaltDispatch(): Promise<boolean>;
}

/** The scope pause question: is this Agent / Mission / Run itself stopped? */
export interface SafetyScopePause {
    isScopePaused(subject: SafetyRailSubject): Promise<boolean>;
}

/** The grants question, delegated to the existing tool-grant enforcer. */
export interface SafetyGrantCheck {
    isToolAllowed(
        subject: SafetyRailSubject,
        toolName: string,
    ): Promise<{ allowed: boolean; reason?: string | null }>;
}

/** The caps question, delegated to the existing budget guard. */
export interface SafetyCapCheck {
    isWithinCaps(
        subject: SafetyRailSubject,
        category: ActionCategory,
    ): Promise<{ allowed: boolean; reason?: string | null }>;
}

/** The category-specific rules question (send rules, merge policy, branches). */
export interface SafetyRuleCheck {
    isRuleSatisfied(
        subject: SafetyRailSubject,
        category: ActionCategory,
    ): Promise<{ allowed: boolean; reason?: string | null }>;
}

/** Just enough of a Nest `Logger` to keep the chain framework-free. */
export interface SafetyRailLogger {
    log(message: string): void;
    warn(message: string): void;
}

/**
 * Everything a rail may read.
 *
 * Note what is NOT here: no tool arguments, no prompt, no instructions, no
 * document text, no model output. `toolName` is the platform's own descriptor
 * identity, not a free-text field — an unresolvable name never reaches the
 * gate.
 */
export interface SafetyRailContext {
    /** The platform's id for the action's entry point. */
    readonly entryPointId: string;
    /** The registered tool name, when the entry point is a tool call. */
    readonly toolName: string | null;
    /** `null` when nothing classified it (FR-3). */
    readonly category: ActionCategory | null;
    readonly subject: SafetyRailSubject;
    /** The rungs in force, already resolved and already narrow-only merged. */
    readonly ladder: ResolvedLadder;
    /** The workspace pause row, already read (and already fail-closed). */
    readonly pause: WorkspacePauseState;
    /**
     * True when an instruction, skill body, memory fact or document was
     * observed asserting a permission the ladder does not grant (FR-17).
     *
     * This is an OBSERVATION the caller made, never an input to the decision:
     * the action is refused or held on the rung alone, and this flag only
     * changes the reason code that is RECORDED, because an instruction trying
     * to widen a rung is a signal worth reading.
     */
    readonly widenAttemptObserved?: boolean;
    readonly logger: SafetyRailLogger;
    readonly platformStop?: SafetyPlatformStop;
    readonly scopePause?: SafetyScopePause;
    readonly grants?: SafetyGrantCheck;
    readonly caps?: SafetyCapCheck;
    readonly rules?: SafetyRuleCheck;
}

export type SafetyRailNext = () => Promise<SafetyVerdict>;

export type SafetyRailMiddleware = (
    context: SafetyRailContext,
    next: SafetyRailNext,
) => Promise<SafetyVerdict>;

/**
 * Fold rails into one callable. Runs left to right; the first one that
 * returns without calling `next()` decides (FR-19, "first refusal wins").
 *
 * A rail that calls `next()` twice is a bug and is refused loudly — silently
 * double-running the tail would evaluate caps and rules twice and could
 * produce two refusal records for one action.
 */
export function composeSafetyRails(
    chain: readonly SafetyRailMiddleware[],
): (context: SafetyRailContext) => Promise<SafetyVerdict> {
    return async (context: SafetyRailContext) => {
        let lastCalled = -1;
        const dispatch = async (index: number): Promise<SafetyVerdict> => {
            if (index <= lastCalled) {
                throw new Error('safety rail middleware called next() more than once');
            }
            lastCalled = index;
            const middleware = chain[index];
            if (!middleware) return SAFETY_ALLOW;
            return middleware(context, () => dispatch(index + 1));
        };
        return dispatch(0);
    };
}

export interface BuildVerdictInput {
    decision: SafetyDecision;
    railId: SafetyRailId;
    reasonCode: SafetyReasonCode;
    context: SafetyRailContext;
    summary: string;
    rung?: SafetyVerdict['rung'];
    ceiling?: SafetyCeiling | null;
}

/**
 * Build a non-allow verdict, with the summary capped where the refusal record
 * caps it (FR-70) so the two can never disagree about what was stored.
 *
 * `widenAttemptObserved` is folded in HERE rather than in each rail, so every
 * rail reports the signal identically and no rail can forget to.
 */
export function buildVerdict(input: BuildVerdictInput): SafetyVerdict {
    const { context } = input;
    return {
        decision: input.decision,
        railId: input.railId,
        category: context.category,
        rung: input.rung ?? null,
        reasonCode: context.widenAttemptObserved
            ? 'instruction-widening-attempt'
            : input.reasonCode,
        summary: capSummary(input.summary),
        ceiling: input.ceiling ?? null,
        safeMode: context.ladder.safeMode === true ? true : undefined,
    };
}

/** Never store or report more summary than the refusal record can hold. */
export function capSummary(summary: string): string {
    const trimmed = summary.trim();
    return trimmed.length > RAIL_REFUSAL_SUMMARY_MAX
        ? `${trimmed.slice(0, RAIL_REFUSAL_SUMMARY_MAX - 1)}…`
        : trimmed;
}
