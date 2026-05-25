import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5 web client mirroring the
 * agent-side `AgentDto` (`packages/agent/src/agents/types.ts`).
 * Kept in lockstep manually: the API contract is what the page
 * consumes and we don't want a runtime dep on the agent package
 * from apps/web for a DTO.
 *
 * Wire dates are ISO strings (NestJS class-transformer default).
 * The web keeps them as strings until a renderer formats them.
 */

export type AgentScope = 'tenant' | 'mission' | 'work' | 'idea';
export type AgentStatus = 'draft' | 'active' | 'paused' | 'running' | 'error' | 'archived';
export type AgentAvatarMode = 'initials' | 'icon' | 'image';
export type AgentIdleBehavior = 'propose' | 'sleep' | 'self-improve';

export type AgentFileName =
    | 'SOUL.md'
    | 'AGENTS.md'
    | 'HEARTBEAT.md'
    | 'TOOLS.md'
    | 'agent.yml';

export interface AgentPermissions {
    canCreateAgents: boolean;
    canAssignTasks: boolean;
    canEditSkills: boolean;
    canEditAgentFiles: boolean;
    canSpend: boolean;
    canCommitToRepo: boolean;
    canOpenPullRequests: boolean;
    canCallExternalTools: boolean;
}

export interface AgentTarget {
    type: 'mission' | 'work' | 'idea';
    id: string;
}

export interface Agent {
    id: string;
    userId: string;
    scope: AgentScope;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
    name: string;
    slug: string;
    title: string | null;
    capabilities: string | null;
    aiProviderId: string | null;
    modelId: string | null;
    maxSkillContextTokens: number;
    status: AgentStatus;
    permissions: AgentPermissions;
    targets: AgentTarget[] | null;
    heartbeatCadence: string | null;
    idleBehavior: AgentIdleBehavior;
    nextHeartbeatAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    errorCount: number;
    pauseAfterFailures: number;
    avatarMode: AgentAvatarMode;
    avatarIcon: string | null;
    avatarImageUploadId: string | null;
    contentHash: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListAgentsQuery {
    scope?: AgentScope;
    status?: AgentStatus;
    missionId?: string;
    ideaId?: string;
    workId?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

export interface ListAgentsResponse {
    data: Agent[];
    meta: { total: number; limit: number; offset: number };
}

export interface CreateAgentInput {
    scope: AgentScope;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    name: string;
    title?: string | null;
    capabilities?: string | null;
    aiProviderId?: string | null;
    modelId?: string | null;
    maxSkillContextTokens?: number;
    heartbeatCadence?: string | null;
    idleBehavior?: AgentIdleBehavior;
    pauseAfterFailures?: number;
    permissions?: Partial<AgentPermissions>;
    targets?: AgentTarget[] | null;
    avatarMode?: AgentAvatarMode;
    avatarIcon?: string | null;
    avatarImageUploadId?: string | null;
}

export interface UpdateAgentInput {
    name?: string;
    title?: string | null;
    capabilities?: string | null;
    aiProviderId?: string | null;
    modelId?: string | null;
    maxSkillContextTokens?: number;
    heartbeatCadence?: string | null;
    idleBehavior?: AgentIdleBehavior;
    pauseAfterFailures?: number;
    permissions?: Partial<AgentPermissions>;
    targets?: AgentTarget[] | null;
    avatarMode?: AgentAvatarMode;
    avatarIcon?: string | null;
    avatarImageUploadId?: string | null;
}

export interface AgentFileBody {
    name: AgentFileName;
    body: string;
    hash: string;
    storage: 'git' | 'db';
}

function buildQuery(q: ListAgentsQuery = {}): string {
    const params = new URLSearchParams();
    if (q.scope) params.set('scope', q.scope);
    if (q.status) params.set('status', q.status);
    if (q.missionId) params.set('missionId', q.missionId);
    if (q.ideaId) params.set('ideaId', q.ideaId);
    if (q.workId) params.set('workId', q.workId);
    if (q.search) params.set('search', q.search);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.offset !== undefined) params.set('offset', String(q.offset));
    const s = params.toString();
    return s ? `?${s}` : '';
}

export const agentsAPI = {
    async list(query: ListAgentsQuery = {}): Promise<ListAgentsResponse> {
        return serverFetch<ListAgentsResponse>(`/agents${buildQuery(query)}`, { method: 'GET' });
    },

    async get(id: string): Promise<Agent | null> {
        try {
            return await serverFetch<Agent>(`/agents/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async create(input: CreateAgentInput): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: '/agents',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(id: string, input: UpdateAgentInput): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async archive(id: string): Promise<{ archived?: true; deleted?: true }> {
        return serverMutation<{ archived?: true; deleted?: true }>({
            endpoint: `/agents/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async deleteHard(id: string): Promise<{ archived?: true; deleted?: true }> {
        return serverMutation<{ archived?: true; deleted?: true }>({
            endpoint: `/agents/${id}?hard=true`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async pause(id: string): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/pause`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async resume(id: string): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/resume`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async readFile(id: string, name: AgentFileName): Promise<AgentFileBody> {
        return serverFetch<AgentFileBody>(`/agents/${id}/files/${name}`, { method: 'GET' });
    },

    async writeFile(
        id: string,
        name: AgentFileName,
        body: string,
        expectedHash?: string,
    ): Promise<{ newHash: string }> {
        return serverMutation<{ newHash: string }>({
            endpoint: `/agents/${id}/files/${name}`,
            data: { body, expectedHash },
            method: 'PUT',
            wrapInData: false,
        });
    },
};
