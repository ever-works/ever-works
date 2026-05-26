import type {
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentPermissions,
    AgentScope,
    AgentStatus,
    AgentTarget,
} from '../entities/agent.entity';
import type { AgentBudget, AgentBudgetIntervalUnit } from '../entities/agent-budget.entity';
import type { AgentRun, AgentRunStatus, AgentRunTriggerKind } from '../entities/agent-run.entity';

/**
 * Wire-format projection of `Agent` returned by `AgentsService`.
 * Excludes the large inline file-body TEXT columns (those have
 * their own endpoint at `GET /agents/:id/files/:name`); the
 * `hasInlineFiles` flag tells the UI whether to show "stored in
 * your account" vs "stored in Git repo" footnote on the
 * Instructions tab.
 */
export interface AgentDto {
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
    nextHeartbeatAt: Date | null;
    lastRunAt: Date | null;
    lastRunStatus: string | null;
    errorCount: number;
    pauseAfterFailures: number;
    avatarMode: AgentAvatarMode;
    avatarIcon: string | null;
    avatarImageUploadId: string | null;
    // FU-13 — git committer identity. Surfaced on the dashboard so an
    // operator can override the defaults (Agent.name + synthesized
    // email) without dropping into the database.
    committerName: string | null;
    committerEmail: string | null;
    hasInlineFiles: boolean;
    contentHash: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export function toAgentDto(agent: Agent): AgentDto {
    const hasInlineFiles = Boolean(
        agent.soulMd || agent.agentsMd || agent.heartbeatMd || agent.toolsMd || agent.agentYml,
    );
    return {
        id: agent.id,
        userId: agent.userId,
        scope: agent.scope,
        missionId: agent.missionId ?? null,
        ideaId: agent.ideaId ?? null,
        workId: agent.workId ?? null,
        name: agent.name,
        slug: agent.slug,
        title: agent.title ?? null,
        capabilities: agent.capabilities ?? null,
        aiProviderId: agent.aiProviderId ?? null,
        modelId: agent.modelId ?? null,
        maxSkillContextTokens: agent.maxSkillContextTokens,
        status: agent.status,
        permissions: agent.permissions,
        targets: agent.targets ?? null,
        heartbeatCadence: agent.heartbeatCadence ?? null,
        idleBehavior: agent.idleBehavior,
        nextHeartbeatAt: agent.nextHeartbeatAt ?? null,
        lastRunAt: agent.lastRunAt ?? null,
        lastRunStatus: agent.lastRunStatus ?? null,
        errorCount: agent.errorCount,
        pauseAfterFailures: agent.pauseAfterFailures,
        avatarMode: agent.avatarMode,
        avatarIcon: agent.avatarIcon ?? null,
        avatarImageUploadId: agent.avatarImageUploadId ?? null,
        committerName: agent.committerName ?? null,
        committerEmail: agent.committerEmail ?? null,
        hasInlineFiles,
        contentHash: agent.contentHash ?? null,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
    };
}

export interface AgentBudgetDto {
    id: string;
    agentId: string;
    intervalUnit: AgentBudgetIntervalUnit;
    intervalAnchor: Date | null;
    capCents: number;
    currency: string;
    allowOverage: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export function toAgentBudgetDto(b: AgentBudget): AgentBudgetDto {
    return {
        id: b.id,
        agentId: b.agentId,
        intervalUnit: b.intervalUnit,
        intervalAnchor: b.intervalAnchor ?? null,
        capCents: b.capCents,
        currency: b.currency,
        allowOverage: b.allowOverage,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
    };
}

export interface AgentRunDto {
    id: string;
    agentId: string;
    userId: string;
    triggerKind: AgentRunTriggerKind;
    status: AgentRunStatus;
    triggerRunId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    durationMs: number | null;
    errorMessage: string | null;
    summary: string | null;
    taskId: string | null;
    chatMessageId: string | null;
    createdAt: Date;
}

export function toAgentRunDto(r: AgentRun): AgentRunDto {
    return {
        id: r.id,
        agentId: r.agentId,
        userId: r.userId,
        triggerKind: r.triggerKind,
        status: r.status,
        triggerRunId: r.triggerRunId ?? null,
        startedAt: r.startedAt ?? null,
        finishedAt: r.finishedAt ?? null,
        durationMs: r.durationMs ?? null,
        errorMessage: r.errorMessage ?? null,
        summary: r.summary ?? null,
        taskId: r.taskId ?? null,
        chatMessageId: r.chatMessageId ?? null,
        createdAt: r.createdAt,
    };
}
