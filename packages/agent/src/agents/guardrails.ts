import {
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    type AgentActionProposalActionType,
    type AgentActionRiskFlag,
} from '../entities/agent-action-proposal.entity';

/**
 * Agent Dispatch Guardrails — the per-Agent policy that decides what
 * happens to a newly proposed side-effectful action BEFORE it reaches
 * the human approval queue.
 *
 * Pure, no-IO helper (same posture as `budget-period.ts` and the
 * approval queue's `RISK_SCORER`): exported types + a validator + an
 * evaluator. Persistence lives on `agents.guardrails` (nullable
 * `simple-json`); enforcement lives in
 * `AgentApprovalsService.createProposal`.
 *
 * Design rules (additive-only feature):
 *   - No guardrails configured (`null`/`undefined`) ⇒ every proposal
 *     queues for human approval — EXACTLY the pre-guardrails behavior.
 *   - A blocked action type is rejected up-front, but still persisted
 *     as a `rejected` proposal row (durable audit trail, never a
 *     silent drop).
 *   - Autonomous mode only auto-approves actions the risk scorer left
 *     completely unflagged; any risk flag forces the human queue.
 */
export interface AgentGuardrails {
    /**
     * - `require_approval` — every proposal queues for a human decision
     *   (the default posture; same as having no guardrails at all,
     *   except `blockedActionTypes` still applies).
     * - `autonomous` — unflagged proposals are auto-approved, subject
     *   to the optional `autoApproveActionTypes` narrowing below.
     */
    mode: 'require_approval' | 'autonomous';
    /**
     * Optional narrowing for `autonomous` mode: when present, ONLY
     * these action types may auto-approve; every other type queues.
     * Omitted = all action types are eligible. An empty array is
     * valid and auto-approves nothing.
     */
    autoApproveActionTypes?: AgentActionProposalActionType[];
    /**
     * Action types this Agent may never take. A blocked proposal is
     * saved immediately as `rejected` with `decidedVia: 'guardrail'`.
     * Must not overlap with `autoApproveActionTypes`.
     */
    blockedActionTypes?: AgentActionProposalActionType[];
}

/** The two dispatch modes, exported for DTO `@IsIn` + UI option lists. */
export const AGENT_GUARDRAIL_MODES: ReadonlyArray<AgentGuardrails['mode']> = [
    'require_approval',
    'autonomous',
] as const;

/**
 * Outcome of evaluating a proposal against the Agent's guardrails:
 *   - `queue`        — persist as `pending`, wait for a human.
 *   - `auto_approve` — persist as `approved` with `decidedVia: 'guardrail'`.
 *   - `block`        — persist as `rejected` with `decidedVia: 'guardrail'`.
 */
export type GuardrailDecision = 'queue' | 'auto_approve' | 'block';

/**
 * Structural validation for an `AgentGuardrails` candidate (unknown
 * input from the API / import surfaces). Returns the FIRST violation
 * as a human-readable message, or `null` when the value is valid.
 *
 * Rules:
 *   1. Must be a plain object (not null / array / primitive).
 *   2. `mode` is required and must be one of {@link AGENT_GUARDRAIL_MODES}.
 *   3. `autoApproveActionTypes` / `blockedActionTypes` are optional;
 *      when present each must be an array of KNOWN action types
 *      ({@link AGENT_ACTION_PROPOSAL_ACTION_TYPES}) with no duplicates.
 *   4. The two lists must not overlap — an action type cannot be both
 *      auto-approved and blocked.
 */
export function validateGuardrails(value: unknown): string | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Guardrails must be an object.';
    }
    const candidate = value as Record<string, unknown>;

    const mode = candidate.mode;
    if (
        typeof mode !== 'string' ||
        !AGENT_GUARDRAIL_MODES.includes(mode as AgentGuardrails['mode'])
    ) {
        return `Guardrails mode must be one of: ${AGENT_GUARDRAIL_MODES.join(', ')}.`;
    }

    const listViolation =
        validateActionTypeList(candidate.autoApproveActionTypes, 'autoApproveActionTypes') ??
        validateActionTypeList(candidate.blockedActionTypes, 'blockedActionTypes');
    if (listViolation) {
        return listViolation;
    }

    const autoApprove = (candidate.autoApproveActionTypes ?? []) as AgentActionProposalActionType[];
    const blocked = (candidate.blockedActionTypes ?? []) as AgentActionProposalActionType[];
    const overlap = autoApprove.find((type) => blocked.includes(type));
    if (overlap) {
        return `Action type "${overlap}" cannot be both auto-approved and blocked.`;
    }

    return null;
}

/**
 * Decide what happens to a freshly proposed action.
 *
 * Decision table (first match wins):
 *   1. No guardrails (`null`/`undefined`)      → `queue` (legacy behavior).
 *   2. `blockedActionTypes` contains the type  → `block`.
 *   3. `mode === 'autonomous'` AND no risk flags AND
 *      (`autoApproveActionTypes` omitted OR contains the type)
 *                                              → `auto_approve`.
 *   4. Everything else                         → `queue`.
 *
 * Risk flags ALWAYS force the queue — an autonomous Agent never
 * self-approves a destructive / cross-scope / budget-override /
 * high-fanout action.
 */
export function evaluateGuardrails(
    guardrails: AgentGuardrails | null | undefined,
    actionType: AgentActionProposalActionType,
    riskFlags: readonly AgentActionRiskFlag[],
): GuardrailDecision {
    if (!guardrails) {
        return 'queue';
    }
    if (guardrails.blockedActionTypes?.includes(actionType)) {
        return 'block';
    }
    if (guardrails.mode === 'autonomous' && riskFlags.length === 0) {
        const allowList = guardrails.autoApproveActionTypes;
        if (!allowList || allowList.includes(actionType)) {
            return 'auto_approve';
        }
    }
    return 'queue';
}

function validateActionTypeList(value: unknown, field: string): string | null {
    if (value === undefined) {
        return null;
    }
    if (!Array.isArray(value)) {
        return `Guardrails ${field} must be an array of action types.`;
    }
    const seen = new Set<string>();
    for (const entry of value) {
        if (
            typeof entry !== 'string' ||
            !AGENT_ACTION_PROPOSAL_ACTION_TYPES.includes(entry as AgentActionProposalActionType)
        ) {
            return `Guardrails ${field} contains an unknown action type: ${String(entry)}. Allowed: ${AGENT_ACTION_PROPOSAL_ACTION_TYPES.join(', ')}.`;
        }
        if (seen.has(entry)) {
            return `Guardrails ${field} contains a duplicate action type: ${entry}.`;
        }
        seen.add(entry);
    }
    return null;
}
