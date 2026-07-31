import type { SubAgentDelegationRequest, SubAgentDelegationResult } from '@ever-works/contracts';

/**
 * The seam that turns a VALIDATED delegation request into an actual
 * child run (judgment layer G9).
 *
 * A PORT, not a class: the thing that can actually start an agent run
 * lives behind the job runtime, and `SubAgentDelegationService` must
 * stay runtime-free so it can be unit-tested and reused from the
 * worker. Bound by the api-side @Global() module with the same
 * `@Optional()` posture as every other dispatch seam here — unbound,
 * a delegation is REFUSED with `no-runner` rather than silently
 * dropped.
 *
 * Contract for implementors: the request handed here has ALREADY been
 * validated and narrowed (`validateSubAgentDelegationRequest`), so the
 * scope on it is the effective scope. Never re-widen it.
 */
export interface SubAgentDelegationRunner {
    run(request: SubAgentDelegationRequest): Promise<SubAgentDelegationResult>;
}

export const SUB_AGENT_DELEGATION_RUNNER = 'SUB_AGENT_DELEGATION_RUNNER' as const;

/**
 * Resolves the TRUE delegation depth of a request from server-side state
 * (judgment layer G9).
 *
 * Why this exists: `validateSubAgentDelegationRequest` checks
 * `request.depth >= maxDepth`, but `request.depth` is declared by the
 * CALLER. A caller that declares `0` on every hop recurses forever and
 * the cap never fires — which is exactly the state this port fixes.
 *
 * The implementation walks server-written provenance instead: every
 * delegated child IS a Task row whose `delegationDepth` the delegation
 * runner stamped itself, so the depth of the delegation being issued is
 * the persisted depth of the Task whose run is issuing it.
 *
 * Contract for implementors:
 *
 *  - Return `null` when the depth cannot be determined (no parent Task,
 *    no matching run). The declared value then stands — this port only
 *    ever RAISES a depth, never lowers one, so an unresolvable request
 *    is no weaker than it is today.
 *  - Read nothing but the integer. The lookup is not user-scoped (the
 *    service is deliberately runtime-free and has no `userId`), so
 *    returning anything richer would be an unscoped read.
 *  - Never throw: a resolver outage must not turn a delegation into an
 *    error. Return `null` and let the declared value stand.
 */
export interface SubAgentDelegationDepthResolver {
    resolveDepth(request: SubAgentDelegationRequest): Promise<number | null>;
}

export const SUB_AGENT_DELEGATION_DEPTH_RESOLVER = 'SUB_AGENT_DELEGATION_DEPTH_RESOLVER' as const;
