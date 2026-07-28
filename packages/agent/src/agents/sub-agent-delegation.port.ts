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
