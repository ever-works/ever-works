// Public surface of the agent-side Agent Action Approval Queue module.
export * from './agent-approvals.module';
export * from './agent-approvals.service';
export * from './risk-scorer';
export * from './types';
// Re-export the entity types so api callers don't need a deep import.
export {
    AgentActionProposal,
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    AGENT_ACTION_PROPOSAL_STATUSES,
    type AgentActionProposalActionType,
    type AgentActionProposalDecidedVia,
    type AgentActionProposalStatus,
    type AgentActionProposalPayload,
    type AgentActionRiskFlag,
} from '../entities/agent-action-proposal.entity';
