import type {
    Agent,
    AgentAvatarMode,
    AgentHaltDetail,
    AgentHaltReason,
    AgentIdleBehavior,
    AgentPermissions,
    AgentScope,
    AgentScorecardMetric,
    AgentStatus,
    AgentTarget,
} from '../entities/agent.entity';
import type { AgentBudget, AgentBudgetIntervalUnit } from '../entities/agent-budget.entity';
import type { AgentRun, AgentRunStatus, AgentRunTriggerKind } from '../entities/agent-run.entity';
import type { AgentGuardrails } from './guardrails';

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
    tenantId: string | null;
    organizationId: string | null;
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
    /**
     * Environments (Settings → Environments) — assigned runtime
     * Environment id; null = platform default runtime.
     */
    environmentId: string | null;
    maxSkillContextTokens: number;
    /** Memory recall injection toggle (memory upgrades M2) — on by default. */
    memoryRecallEnabled: boolean;
    status: AgentStatus;
    permissions: AgentPermissions;
    targets: AgentTarget[] | null;
    guardrails: AgentGuardrails | null;
    heartbeatCadence: string | null;
    idleBehavior: AgentIdleBehavior;
    nextHeartbeatAt: Date | null;
    lastRunAt: Date | null;
    lastRunStatus: string | null;
    errorCount: number;
    pauseAfterFailures: number;
    // ── Halt reason (AW-23) — why this agent is not working ──
    // Additive fields on an existing DTO. Every one is `null` for an
    // agent that has never halted, and for every agent that was already
    // paused when this shipped: no backfill invented a timestamp.
    //
    // 🛑 `haltDetail` is a display name and a coarse kind. It never
    // carries a credential, a token fragment or a raw provider error.
    haltReason: AgentHaltReason | null;
    haltNote: string | null;
    haltedAt: Date | null;
    haltedByUserId: string | null;
    haltedRunId: string | null;
    haltDetail: AgentHaltDetail | null;
    /** Consecutive halts for the same reason; `2` is what the card reports. */
    haltRepeatCount: number;
    avatarMode: AgentAvatarMode;
    avatarIcon: string | null;
    avatarImageUploadId: string | null;
    // FU-13 — git committer identity. Surfaced on the dashboard so an
    // operator can override the defaults (Agent.name + synthesized
    // email) without dropping into the database.
    committerName: string | null;
    committerEmail: string | null;
    /** Direct manager for the Org Chart (teams-and-companies spec §1.2). */
    reportsToAgentId: string | null;
    // Agent Scorecards increment 1 — quantified per-Agent goals.
    scorecard: AgentScorecardMetric[] | null;
    /**
     * Capabilities tab — per-Agent init script (advisory v1: stored +
     * surfaced; consumed at session/workspace bootstrap where the
     * runtime supports it).
     */
    initScript: string | null;
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
        tenantId: agent.tenantId ?? null,
        organizationId: agent.organizationId ?? null,
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
        environmentId: agent.environmentId ?? null,
        maxSkillContextTokens: agent.maxSkillContextTokens,
        // `?? true` — recall is on by default; rows created before the
        // memory-upgrades migration (or sqlite test fixtures) surface
        // as enabled, matching the runtime `!== false` gate.
        memoryRecallEnabled: agent.memoryRecallEnabled ?? true,
        status: agent.status,
        permissions: agent.permissions,
        targets: agent.targets ?? null,
        guardrails: agent.guardrails ?? null,
        heartbeatCadence: agent.heartbeatCadence ?? null,
        idleBehavior: agent.idleBehavior,
        nextHeartbeatAt: agent.nextHeartbeatAt ?? null,
        lastRunAt: agent.lastRunAt ?? null,
        lastRunStatus: agent.lastRunStatus ?? null,
        errorCount: agent.errorCount,
        pauseAfterFailures: agent.pauseAfterFailures,
        haltReason: agent.haltReason ?? null,
        haltNote: agent.haltNote ?? null,
        haltedAt: agent.haltedAt ?? null,
        haltedByUserId: agent.haltedByUserId ?? null,
        haltedRunId: agent.haltedRunId ?? null,
        haltDetail: agent.haltDetail ?? null,
        // `?? 0` — rows written before the halt columns existed read as
        // "never halted twice", which is the truth about them.
        haltRepeatCount: agent.haltRepeatCount ?? 0,
        avatarMode: agent.avatarMode,
        avatarIcon: agent.avatarIcon ?? null,
        avatarImageUploadId: agent.avatarImageUploadId ?? null,
        committerName: agent.committerName ?? null,
        committerEmail: agent.committerEmail ?? null,
        reportsToAgentId: agent.reportsToAgentId ?? null,
        scorecard: agent.scorecard ?? null,
        initScript: agent.initScript ?? null,
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
