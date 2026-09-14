import type {
    AgentActionProposalActionType,
    AgentActionProposalDecidedVia,
    AgentActionProposalPayload,
} from '../entities/agent-action-proposal.entity';

/**
 * Fired by `AgentApprovalsService` after a person decides a PENDING
 * proposal — one event per proposal, from `decide()` and from each row
 * `approveAll()` approves.
 *
 * Before this existed a decision was a durable record only: whatever the
 * proposal stood for had to be re-checked by whoever cared. A listener lets
 * the thing that raised the proposal act on the answer, so approving from
 * the approvals queue and approving from the surface the proposal came from
 * do the same work exactly once (agent email drafts are the first consumer).
 *
 * Emitted AFTER the row is saved, fire-and-forget. A listener failure never
 * un-decides the proposal; listeners must be idempotent against the record
 * they act on.
 */
export class AgentActionProposalDecidedEvent {
    static readonly EVENT_NAME = 'agent-approvals.proposal-decided';

    constructor(
        public readonly proposalId: string,
        /** Owner of the proposal (and of the Agent). */
        public readonly userId: string,
        public readonly agentId: string,
        public readonly actionType: AgentActionProposalActionType,
        public readonly status: 'approved' | 'rejected',
        public readonly decidedById: string | null,
        public readonly decidedVia: AgentActionProposalDecidedVia | null,
        public readonly payload: AgentActionProposalPayload,
    ) {}
}
