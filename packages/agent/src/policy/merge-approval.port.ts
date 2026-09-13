import type { MergeRefusalCode } from '@ever-works/contracts';

/**
 * Merge approval (self-build slice AE, EW-805) — injection token +
 * contract for the "is there a real, current, human approval for THIS
 * merge?" question.
 *
 * Token + contract only (leaf file, type-only imports — the same
 * circular-dep dodge as `merge-policy.enforcer.ts` and the other agent
 * injection tokens). `GitFacadeService` consumes it via
 * `@Optional() @Inject(...)`; `MergeApprovalModule` binds it to
 * `MergeApprovalService`.
 *
 * Why a PORT and not a boolean argument: before this landed, the facade
 * took `humanApproved` from its CALLER, and the only production caller
 * passed the literal `false`. A caller-supplied boolean is not an
 * approval — it is a claim, and the whole point of the gate is that the
 * thing being gated cannot make the claim. So the facade now asks this
 * port, which answers from the durable record.
 *
 * FAIL-CLOSED when unbound. `GitFacadeService` treats an absent verifier
 * as "no approval exists": a runtime that cannot look one up must not
 * merge on a policy that requires one. This is the opposite of the
 * `@Optional()` convention elsewhere in the package, and deliberately so
 * — a merge is irreversible.
 */

/** WHICH merge is being asked about. Every field is required. */
export interface MergeApprovalQuery {
    /** The Task the pull request belongs to. */
    taskId: string;
    /** Provider pull-request number. */
    prNumber: number;
    /**
     * The head commit as read from the provider MOMENTS AGO — not from a
     * cache, and not from the caller's memory of what it pushed. This is
     * the value the recorded approval must name.
     */
    headSha: string;
}

/** What the verifier found. */
export interface MergeApprovalVerdict {
    /** True only when a real, current, human, entitled approval exists. */
    approved: boolean;
    /** Stable refusal code when `approved` is false. */
    code?: MergeRefusalCode;
    /** Human-readable reason naming what was found instead. */
    reason?: string;
    /** `agent_action_proposals.id` of the consumed approval. */
    approvalId?: string;
    /** The human who approved (`users.id`). Never an agent or a bot. */
    approvedById?: string;
    approvedAt?: Date;
}

export interface MergeApprovalVerifier {
    /**
     * Is there a recorded human approval for exactly this pull request at
     * exactly this head commit, still inside its validity window, given by
     * somebody entitled to approve for this Task's scope?
     *
     * Implementations MUST NOT throw for "no" — a refusal is a verdict.
     * They may throw for genuine faults (the store is unreachable), and
     * the caller treats a throw as a refusal.
     */
    verifyMergeApproval(query: MergeApprovalQuery): Promise<MergeApprovalVerdict>;
}

export const MERGE_APPROVAL_VERIFIER = 'MERGE_APPROVAL_VERIFIER' as const;
