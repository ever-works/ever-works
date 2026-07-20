import type {
    AgentActionProposalActionType,
    AgentActionProposalPayload,
    AgentActionRiskFlag,
} from '../entities/agent-action-proposal.entity';

/**
 * Input the pure risk scorer needs — the proposed action's type plus
 * its payload. Kept deliberately narrow so the scorer stays a pure,
 * side-effect-free function that's trivial to unit test.
 */
export interface RiskScorerInput {
    actionType: AgentActionProposalActionType;
    payload?: AgentActionProposalPayload | null;
}

/**
 * Canonical order the flags are emitted in, so the resulting array is
 * stable regardless of which rules fire (nicer for snapshot tests +
 * deterministic badge ordering in the UI).
 */
const FLAG_ORDER: readonly AgentActionRiskFlag[] = [
    'budget_override',
    'destructive',
    'cross_scope',
    'high_fanout',
] as const;

/** Fan-out depth at/above which a `spawn_agent` action is high-risk. */
export const HIGH_FANOUT_DEPTH = 3;

/**
 * Pure risk scorer for a proposed side-effectful Agent action. Returns
 * the set of {@link AgentActionRiskFlag}s that apply, in a stable
 * order. No I/O, no clock, no randomness — same input always yields the
 * same output.
 *
 * Rules (agents approval-queue spec):
 *   - `budget_override` — the action itself is a budget override.
 *   - `destructive`     — `payload.destructive` is truthy.
 *   - `cross_scope`     — the action reaches into another scope, i.e.
 *                         `payload.crossScope === true` OR a non-null
 *                         `sourceScope`/`targetScope` pair that differs.
 *   - `high_fanout`     — `payload.spawnDepth >= HIGH_FANOUT_DEPTH`.
 */
export function RISK_SCORER(input: RiskScorerInput): AgentActionRiskFlag[] {
    const payload = input.payload ?? {};
    const flags = new Set<AgentActionRiskFlag>();

    if (input.actionType === 'budget_override') {
        flags.add('budget_override');
    }

    if (payload.destructive) {
        flags.add('destructive');
    }

    if (isCrossScope(payload)) {
        flags.add('cross_scope');
    }

    if (typeof payload.spawnDepth === 'number' && payload.spawnDepth >= HIGH_FANOUT_DEPTH) {
        flags.add('high_fanout');
    }

    return FLAG_ORDER.filter((flag) => flags.has(flag));
}

function isCrossScope(payload: AgentActionProposalPayload): boolean {
    if (payload.crossScope === true) {
        return true;
    }
    const { sourceScope, targetScope } = payload;
    return (
        sourceScope != null && targetScope != null && String(sourceScope) !== String(targetScope)
    );
}
