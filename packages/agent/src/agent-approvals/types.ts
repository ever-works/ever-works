import type {
    AgentActionProposal,
    AgentActionProposalActionType,
    AgentActionProposalDecidedVia,
    AgentActionProposalPayload,
    AgentActionProposalStatus,
    AgentActionRiskFlag,
} from '../entities/agent-action-proposal.entity';

/**
 * Wire-format projection of `AgentActionProposal` returned by
 * `AgentApprovalsService`. Dates serialize to ISO strings on the wire
 * (NestJS `JSON.stringify` default) — the web client declares them as
 * strings, same posture as `AgentDto`.
 */
export interface AgentActionProposalDto {
    id: string;
    userId: string;
    agentId: string;
    runId: string | null;
    actionType: AgentActionProposalActionType;
    title: string;
    payload: AgentActionProposalPayload;
    riskFlags: AgentActionRiskFlag[];
    status: AgentActionProposalStatus;
    decidedById: string | null;
    decidedAt: Date | null;
    decidedVia: AgentActionProposalDecidedVia | null;
    tenantId: string | null;
    organizationId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export function toAgentActionProposalDto(row: AgentActionProposal): AgentActionProposalDto {
    return {
        id: row.id,
        userId: row.userId,
        agentId: row.agentId,
        runId: row.runId ?? null,
        actionType: row.actionType,
        title: row.title,
        payload: row.payload ?? {},
        riskFlags: row.riskFlags ?? [],
        status: row.status,
        decidedById: row.decidedById ?? null,
        decidedAt: row.decidedAt ?? null,
        decidedVia: row.decidedVia ?? null,
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
