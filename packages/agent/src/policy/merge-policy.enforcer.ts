import type { GateStatus, MergeDecision, MergeMethod } from '@ever-works/contracts';

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — injection token +
 * contract for the enforcement half.
 *
 * Token + contract only (leaf file, type-only imports — the same
 * circular-dep dodge as the other agent injection tokens, see
 * `docs/architecture/agent-injection-tokens.md`). `GitFacadeService`
 * consumes it via `@Optional() @Inject(...)`; `PolicyModule` binds it to
 * `MergePolicyService`. Left unbound (unit tests, runtimes without the
 * policy module) the facade behaves exactly as before the feature landed.
 */

/** Everything the decision point needs, in one call. */
export interface MergePolicyDecisionInput {
    /** Most specific scope. Its Work/org/tenant are discovered from the row. */
    agentId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
    /** Latest quality-gate verdict for the work being merged. */
    gateStatus?: GateStatus | null;
    /** Whether a human approval is on record for this merge. */
    humanApproved?: boolean;
    /** Base branch of the pull request; unknown fails closed when branches are protected. */
    targetBranch?: string | null;
    /** Requested strategy; `undefined` evaluates as the provider default (`merge`). */
    mergeMethod?: MergeMethod | null;
}

export interface MergePolicyEnforcer {
    /**
     * The single decision point: may THIS agent land THIS pull request?
     * Implementations resolve the policy chain themselves and must never
     * throw for policy reasons — a refusal is `{ allowed: false, reason }`.
     */
    canAgentMerge(input: MergePolicyDecisionInput): Promise<MergeDecision>;
}

export const MERGE_POLICY_ENFORCER = 'MERGE_POLICY_ENFORCER' as const;
