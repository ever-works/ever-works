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

export type AgentFileName = 'SOUL.md' | 'AGENTS.md' | 'HEARTBEAT.md' | 'TOOLS.md' | 'agent.yml';

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

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6a. Per-Agent export
 * envelope (mirrors `AgentExportEnvelope` on the API side). Carried
 * as JSON in the response body of `GET /agents/:id/export` and as
 * the request body of `POST /agents/import`.
 */
export interface AgentExportEnvelope {
    version: 1;
    meta: {
        exportedAt: string;
        sourceAgentId: string;
        sourceUserId: string;
        appVersion?: string;
    };
    identity: {
        name: string;
        slug: string;
        title: string | null;
        capabilities: string | null;
        scope: AgentScope;
    };
    model: {
        aiProviderId: string | null;
        modelId: string | null;
        maxSkillContextTokens: number;
    };
    runtime: {
        permissions: AgentPermissions;
        targets: AgentTarget[] | null;
        heartbeatCadence: string | null;
        idleBehavior: AgentIdleBehavior;
        pauseAfterFailures: number;
    };
    avatar: {
        mode: AgentAvatarMode;
        icon: string | null;
        imageUploadId: string | null;
    };
    files: {
        soulMd: string | null;
        agentsMd: string | null;
        heartbeatMd: string | null;
        toolsMd: string | null;
        agentYml: string | null;
    };
    skillBindings: Array<{
        skillSlug: string;
        priority: number;
        overrides?: Record<string, unknown>;
    }>;
    budget: Array<{
        intervalUnit: string;
        intervalCount: number;
        capCents: number | null;
        currency: string;
    }>;
}

export type AgentImportConflictMode = 'skip' | 'overwrite' | 'rename';

export interface AgentImportOptions {
    onConflict?: AgentImportConflictMode;
    overrideScope?: AgentScope;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
}

export interface AgentImportResult {
    created: Agent;
    conflictResolution: 'none' | 'skipped' | 'overwritten' | 'renamed';
    originalSlug: string;
    finalSlug: string;
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

    async exportOne(id: string): Promise<AgentExportEnvelope> {
        return serverFetch<AgentExportEnvelope>(`/agents/${id}/export`, { method: 'GET' });
    },

    async importOne(
        envelope: AgentExportEnvelope,
        options: AgentImportOptions = {},
    ): Promise<AgentImportResult> {
        const params = new URLSearchParams();
        if (options.onConflict) params.set('onConflict', options.onConflict);
        if (options.overrideScope) params.set('scope', options.overrideScope);
        if (options.missionId) params.set('missionId', options.missionId);
        if (options.ideaId) params.set('ideaId', options.ideaId);
        if (options.workId) params.set('workId', options.workId);
        const qs = params.toString();
        return serverMutation<AgentImportResult>({
            endpoint: `/agents/import${qs ? `?${qs}` : ''}`,
            data: envelope as unknown as Record<string, unknown>,
            method: 'POST',
            wrapInData: false,
        });
    },

    // FU-2 + FU-4 — runtime surfaces.
    async listRuns(
        id: string,
        opts: { limit?: number; offset?: number } = {},
    ): Promise<{
        data: Array<{
            id: string;
            status: string;
            triggerKind: string;
            startedAt: string | null;
            finishedAt: string | null;
            durationMs: number | null;
            summary: string | null;
            errorMessage: string | null;
            taskId: string | null;
            createdAt: string;
        }>;
        meta: { total: number; limit: number; offset: number };
    }> {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', String(opts.limit));
        if (opts.offset) params.set('offset', String(opts.offset));
        const qs = params.toString();
        return serverFetch(`/agents/${id}/runs${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },

    async listSkills(id: string): Promise<{
        data: Array<{
            bindingId: string;
            priority: number;
            targetType: string;
            skill: { id: string; slug: string; title: string; version: string };
        }>;
    }> {
        return serverFetch(`/agents/${id}/skills`, { method: 'GET' });
    },

    async getBudget(id: string): Promise<{
        currentSpendCents: number;
        capCents: number | null;
        periodStart: string;
        periodEnd: string;
        currency: string;
    }> {
        return serverFetch(`/agents/${id}/budget`, { method: 'GET' });
    },

    async runNow(id: string): Promise<{ outcome: string; runId?: string; reason?: string }> {
        return serverMutation({
            endpoint: `/agents/${id}/run-now`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async cancelRun(
        id: string,
        runId: string,
    ): Promise<{ cancelled: boolean; previousStatus?: string }> {
        return serverMutation({
            endpoint: `/agents/${id}/runs/${runId}/cancel`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
