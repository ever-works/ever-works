import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Agent Action Approval Queue — web client mirroring the agent-side
 * `AgentActionProposalDto` (`packages/agent/src/agent-approvals/types.ts`).
 * Kept in lockstep manually so apps/web has no runtime dep on the agent
 * package for a DTO. Wire dates are ISO strings.
 */

export type AgentActionProposalActionType =
    | 'spawn_agent'
    | 'schedule_task'
    | 'send_message'
    | 'budget_override'
    | 'other';

export type AgentActionProposalStatus = 'pending' | 'approved' | 'rejected';

export type AgentActionRiskFlag = 'budget_override' | 'destructive' | 'cross_scope' | 'high_fanout';

export interface AgentActionProposal {
    id: string;
    userId: string;
    agentId: string;
    runId: string | null;
    actionType: AgentActionProposalActionType;
    title: string;
    payload: Record<string, unknown>;
    riskFlags: AgentActionRiskFlag[];
    status: AgentActionProposalStatus;
    decidedById: string | null;
    decidedAt: string | null;
    tenantId: string | null;
    organizationId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListAgentApprovalsQuery {
    status?: AgentActionProposalStatus;
    organizationId?: string;
    limit?: number;
    offset?: number;
}

export interface ListAgentApprovalsResponse {
    data: AgentActionProposal[];
    meta: { total: number; limit: number; offset: number };
}

export interface ApproveAllAgentApprovalsResult {
    approved: number;
    skipped: number;
}

function buildQuery(q: ListAgentApprovalsQuery = {}): string {
    const params = new URLSearchParams();
    if (q.status) params.set('status', q.status);
    if (q.organizationId) params.set('organizationId', q.organizationId);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.offset !== undefined) params.set('offset', String(q.offset));
    const s = params.toString();
    return s ? `?${s}` : '';
}

export const agentApprovalsAPI = {
    async list(query: ListAgentApprovalsQuery = {}): Promise<ListAgentApprovalsResponse> {
        return serverFetch<ListAgentApprovalsResponse>(`/agent-approvals${buildQuery(query)}`, {
            method: 'GET',
        });
    },

    async get(id: string): Promise<AgentActionProposal | null> {
        try {
            return await serverFetch<AgentActionProposal>(`/agent-approvals/${id}`, {
                method: 'GET',
            });
        } catch {
            return null;
        }
    },

    async approve(id: string): Promise<AgentActionProposal> {
        return serverMutation<AgentActionProposal>({
            endpoint: `/agent-approvals/${id}/approve`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async reject(id: string): Promise<AgentActionProposal> {
        return serverMutation<AgentActionProposal>({
            endpoint: `/agent-approvals/${id}/reject`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Bulk-approve pending proposals in ONE API call (one throttle hit
     * instead of one per row). Omitting `ids` approves every pending
     * proposal; already-decided rows are skipped server-side.
     */
    async approveAll(ids?: string[]): Promise<ApproveAllAgentApprovalsResult> {
        return serverMutation<ApproveAllAgentApprovalsResult>({
            endpoint: '/agent-approvals/approve-all',
            data: ids ? { ids } : {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
