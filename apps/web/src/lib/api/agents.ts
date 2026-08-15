import 'server-only';
import type { AgentCapabilitiesPayload, MergePolicyOverride } from '@ever-works/contracts';
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
export type AgentAvatarMode = 'initials' | 'icon' | 'image';
export type AgentIdleBehavior = 'propose' | 'sleep' | 'self-improve';

export type AgentFileName = 'SOUL.md' | 'AGENTS.md' | 'HEARTBEAT.md' | 'TOOLS.md' | 'agent.yml';

// ── Agent Dispatch Guardrails ──
// Pure guardrail types + the action-type tuple live in a
// `server-only`-free module (`agents.shared.ts`) so `'use client'`
// components (e.g. AgentGuardrailsCard) can import them without pulling
// this server-only module into the client bundle. Re-exported here so
// server-side callers keep one import site.
export {
    AGENT_GUARDRAIL_ACTION_TYPES,
    type AgentGuardrailActionType,
    type AgentGuardrailsMode,
    type AgentGuardrails,
    type AgentAssignCandidate,
    type AgentPickerOption,
    type AgentStatus,
    type AgentRunSession,
    type AgentRunSessionStatus,
    type AgentRunTriggerKind,
    type ListRunSessionsQuery,
    type RunSteerResponse,
    type RunInterruptResponse,
    type RunResumeResponse,
    type AgentRunSessionDetail,
    type AgentRunTimelineEntry,
    type AgentRunTimelineEntryKind,
    type SessionDetailQuery,
    type AgentCollaboratorCandidate,
} from './agents.shared';
import type {
    AgentGuardrails,
    AgentStatus,
    AgentRunSession,
    AgentRunSessionDetail,
    ListRunSessionsQuery,
    RunSteerResponse,
    RunInterruptResponse,
    RunResumeResponse,
    SessionDetailQuery,
    AgentCollaboratorCandidate,
} from './agents.shared';

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

// Agent Scorecards increment 1 — mirrors `AgentScorecardMetric` /
// `AgentScorecardPeriod` on the agent entity. Quantified per-Agent
// goals; `current` is manually edited in this increment (auto-update
// from run output + the org-dashboard at-risk roll-up are follow-ups).
export type AgentScorecardPeriod = 'weekly' | 'monthly' | 'quarterly';

export interface AgentScorecardMetric {
    key: string;
    label: string;
    target: number;
    current: number;
    floor?: number | null;
    stretch?: number | null;
    unit?: string | null;
    period: AgentScorecardPeriod;
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
    /**
     * Teams & Companies spec §1.2 — direct-manager edge for the org
     * chart (additive, descriptive-only in v1; same-org enforced by
     * the API service).
     */
    reportsToAgentId: string | null;
    guardrails: AgentGuardrails | null;
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
    scorecard: AgentScorecardMetric[] | null;
    /**
     * Merge-policy matrix (Wave 3, D4) — the Agent-scoped PARTIAL override,
     * the MOST specific scope. Omitted fields inherit Work → organization →
     * tenant → platform default; `null` clears the Agent override.
     */
    mergePolicy?: MergePolicyOverride | null;
    /**
     * Capabilities tab — per-Agent init script (advisory v1: stored +
     * surfaced; consumed at session/workspace bootstrap where the
     * runtime supports it).
     */
    initScript: string | null;
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
    /**
     * Agents ASSIGNED to this Work (their `targets` include
     * it) — as opposed to `workId`, which matches Agents pinned to the
     * Work by scope. The Work header's Agents dropdown unions the two.
     */
    assignedWorkId?: string;
    /**
     * The Idea counterpart of `assignedWorkId` — Agents ASSIGNED to this
     * Idea through their `targets`, as opposed to `ideaId`, which matches
     * Agents pinned to the Idea by scope. The Idea detail rail unions the
     * two.
     */
    assignedIdeaId?: string;
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
    /** Teams & Companies spec §3 — additive PATCH field (null clears the manager edge). */
    reportsToAgentId?: string | null;
    scorecard?: AgentScorecardMetric[] | null;
    /** Merge-policy matrix (Wave 3, D4) — PARTIAL; `null` clears the override. */
    mergePolicy?: MergePolicyOverride | null;
    /** Capabilities tab — init script; `null` (or blank) clears it. */
    initScript?: string | null;
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

/**
 * Wave 10 prebuilt agent-template catalog row as served by
 * `GET /api/agents/templates` (in-code marketing/sales/ops presets).
 * Wave 11 consumes `suggestedRoles` to surface 2-3 suggestions on the
 * onboarding "What do you do" step.
 */
export interface AgentTemplateSummary {
    slug: string;
    name: string;
    title: string;
    category: string;
    description: string;
    capabilities: string;
    suggestedSkills: string[];
    suggestedPipeline: string | null;
    suggestedRoles: string[];
}

function buildQuery(q: ListAgentsQuery = {}): string {
    const params = new URLSearchParams();
    if (q.scope) params.set('scope', q.scope);
    if (q.status) params.set('status', q.status);
    if (q.missionId) params.set('missionId', q.missionId);
    if (q.ideaId) params.set('ideaId', q.ideaId);
    if (q.workId) params.set('workId', q.workId);
    if (q.assignedWorkId) params.set('assignedWorkId', q.assignedWorkId);
    if (q.assignedIdeaId) params.set('assignedIdeaId', q.assignedIdeaId);
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

    /** Wave 10 — list the prebuilt agent-template catalog. */
    async listTemplates(): Promise<{ data: AgentTemplateSummary[] }> {
        return serverFetch<{ data: AgentTemplateSummary[] }>('/agents/templates', {
            method: 'GET',
        });
    },

    /**
     * Wave 10 — create MY Agent from a prebuilt template (DRAFT,
     * review-before-act guardrails). Body fields are optional placement
     * overrides; the onboarding suggestion flow passes none.
     */
    async createFromTemplate(slug: string): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/from-template/${encodeURIComponent(slug)}`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
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

    /**
     * Assign an existing Agent to a Mission / Idea / Work.
     * Idempotent, and single-target on purpose so the caller never has to
     * read-modify-write the Agent's whole `targets` array.
     */
    async addTarget(id: string, target: { type: 'mission' | 'idea' | 'work'; id: string }) {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/targets`,
            data: target,
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Inverse of `addTarget` — also idempotent. */
    async removeTarget(id: string, target: { type: 'mission' | 'idea' | 'work'; id: string }) {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/targets/${target.type}/${target.id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * PUT semantics — replaces the whole guardrails policy;
     * `null` clears back to the default queue-everything posture.
     */
    async updateGuardrails(id: string, guardrails: AgentGuardrails | null): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/guardrails`,
            data: { guardrails },
            method: 'PUT',
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

    /** Inverse of `archive` — restores an archived Agent as PAUSED. */
    async unarchive(id: string): Promise<Agent> {
        return serverMutation<Agent>({
            endpoint: `/agents/${id}/unarchive`,
            data: {},
            method: 'POST',
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

    /**
     * Run orchestration (Wave 4 M4) — the Sessions list: every AgentRun
     * of the acting user across all Agents/Works, filterable + paginated
     * (`GET /api/agents/runs`). Rows carry telemetry (currentActivity /
     * totalTokens / costCents), quality-gate columns (gateStatus /
     * resolvedChecks / checkResults) and terminal lifecycle columns for
     * the attach link.
     */
    async listSessions(query: ListRunSessionsQuery = {}): Promise<{
        data: AgentRunSession[];
        meta: { total: number; limit: number; offset: number };
    }> {
        const params = new URLSearchParams();
        if (query.status) params.set('status', query.status);
        if (query.workId) params.set('workId', query.workId);
        if (query.agentId) params.set('agentId', query.agentId);
        if (query.taskId) params.set('taskId', query.taskId);
        if (query.kind) params.set('kind', query.kind);
        if (query.limit != null) params.set('limit', String(query.limit));
        if (query.offset != null) params.set('offset', String(query.offset));
        const qs = params.toString();
        return serverFetch(`/agents/runs${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },

    /**
     * Session detail (Feature K) — the drill-in behind each Sessions row
     * (`GET /api/agents/runs/:runId/detail`): full session projection +
     * message/tool-call/file counts + one cursor page of the captured
     * timeline + the touched-file list. Addressed by runId alone; the
     * API scopes by the acting user (cross-user runs 404).
     */
    async getSessionDetail(
        runId: string,
        query: SessionDetailQuery = {},
    ): Promise<AgentRunSessionDetail> {
        const params = new URLSearchParams();
        if (query.cursor) params.set('cursor', query.cursor);
        if (query.limit != null) params.set('limit', String(query.limit));
        const qs = params.toString();
        return serverFetch(`/agents/runs/${runId}/detail${qs ? `?${qs}` : ''}`, {
            method: 'GET',
        });
    },

    // ── Agent Collaborators — sub-agent delegation allow-list ──

    /**
     * Every OTHER agent of the owner as a collaborator candidate, each
     * carrying its configured/enabled allow-list state for this parent.
     */
    async listCollaborators(id: string): Promise<{ data: AgentCollaboratorCandidate[] }> {
        return serverFetch<{ data: AgentCollaboratorCandidate[] }>(`/agents/${id}/collaborators`, {
            method: 'GET',
        });
    },

    /** Idempotent upsert of one collaborator rule's `enabled` toggle. */
    async setCollaborator(
        id: string,
        collaboratorAgentId: string,
        enabled: boolean,
    ): Promise<{ agentId: string; collaboratorAgentId: string; enabled: boolean }> {
        return serverMutation({
            endpoint: `/agents/${id}/collaborators/${collaboratorAgentId}`,
            data: { enabled },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /** Remove the rule entirely (back to unconfigured). Idempotent. */
    async removeCollaborator(
        id: string,
        collaboratorAgentId: string,
    ): Promise<{ removed: boolean }> {
        return serverMutation({
            endpoint: `/agents/${id}/collaborators/${collaboratorAgentId}`,
            data: {},
            method: 'DELETE',
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
        if (opts.limit != null) params.set('limit', String(opts.limit));
        if (opts.offset != null) params.set('offset', String(opts.offset));
        const qs = params.toString();
        return serverFetch(`/agents/${id}/runs${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },

    // Lifecycle events (paused / resumed / created / …) for the
    // activity feed — interleaved with runs client-side.
    async listEvents(
        id: string,
        opts: { limit?: number; offset?: number } = {},
    ): Promise<{
        data: Array<{
            id: string;
            actionType: string;
            details: Record<string, unknown> | null;
            createdAt: string;
        }>;
        meta: { total: number; limit: number; offset: number };
    }> {
        const params = new URLSearchParams();
        if (opts.limit != null) params.set('limit', String(opts.limit));
        if (opts.offset != null) params.set('offset', String(opts.offset));
        const qs = params.toString();
        return serverFetch(`/agents/${id}/events${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },

    // FU-4 follow-up — full run detail incl. the structured step logs
    // written to `agent_run_logs` during the run (previously write-only).
    async getRun(
        id: string,
        runId: string,
    ): Promise<{
        id: string;
        status: string;
        triggerKind: string;
        startedAt: string | null;
        finishedAt: string | null;
        durationMs: number | null;
        summary: string | null;
        errorMessage: string | null;
        taskId: string | null;
        chatMessageId: string | null;
        memorySessionId: string | null;
        createdAt: string;
        logs: Array<{
            id: string;
            level: 'INFO' | 'WARN' | 'ERROR';
            step: string;
            message: string;
            metadata: Record<string, unknown> | null;
            createdAt: string;
        }>;
    }> {
        return serverFetch(`/agents/${id}/runs/${runId}`, { method: 'GET' });
    },

    /**
     * Capabilities tab — the composed read behind `/agents/[id]/capabilities`:
     * tool catalog + resolved tool-grant chain + effective per-tool decision
     * + permissions + init script, in one request.
     */
    async getCapabilities(id: string): Promise<AgentCapabilitiesPayload> {
        return serverFetch<AgentCapabilitiesPayload>(`/agents/${id}/capabilities`, {
            method: 'GET',
        });
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

    // ── Run controls (Wave 4 M5) ──
    // steer / interrupt / resume. "Stop" is the existing `cancelRun` above —
    // deliberately not duplicated here.

    async steerRun(id: string, runId: string, message: string): Promise<RunSteerResponse> {
        return serverMutation({
            endpoint: `/agents/${id}/runs/${runId}/steer`,
            data: { message },
            method: 'POST',
            wrapInData: false,
        });
    },

    async interruptRun(id: string, runId: string): Promise<RunInterruptResponse> {
        return serverMutation({
            endpoint: `/agents/${id}/runs/${runId}/interrupt`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    async resumeRun(
        id: string,
        runId: string,
        message?: string | null,
    ): Promise<RunResumeResponse> {
        return serverMutation({
            endpoint: `/agents/${id}/runs/${runId}/resume`,
            data: message && message.trim().length > 0 ? { message: message.trim() } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Agent attachment surface — list/add/remove `AgentAttachment` rows.
    // Mirrors `missionsAPI.{list,add,remove}Attachment` and
    // `workProposalsAPI.{list,add,remove}Attachment` so the
    // PromptComposer-driven creates can attach uniformly.
    async listAttachments(id: string): Promise<AgentAttachmentRow[]> {
        return serverFetch<AgentAttachmentRow[]>(`/agents/${id}/attachments`, {
            method: 'GET',
        });
    },

    async addAttachment(id: string, uploadId: string): Promise<AgentAttachmentRow> {
        return serverMutation<AgentAttachmentRow>({
            endpoint: `/agents/${id}/attachments`,
            data: { uploadId },
            method: 'POST',
            wrapInData: false,
        });
    },

    async removeAttachment(id: string, attachmentId: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/agents/${id}/attachments/${attachmentId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

/** Row shape returned by `/agents/:id/attachments`. */
export interface AgentAttachmentRow {
    readonly id: string;
    readonly agentId: string;
    readonly uploadId: string;
    readonly createdAt: string;
    // Joined `user_uploads` metadata — present on list responses (the
    // API enriches rows server-side) so attachment tiles can render
    // type-aware icons after a refresh; absent on add responses, where
    // the client already knows the file it just uploaded.
    readonly filename?: string | null;
    readonly mimeType?: string | null;
    readonly sizeBytes?: number | null;
    /** API-routed serve URL (`/api/uploads/<userId>/<hash>.<ext>`). */
    readonly url?: string | null;
}
