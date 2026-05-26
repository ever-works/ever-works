import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import {
    AGENT_PERMISSIONS_DEFAULT,
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    type AgentPermissions,
    AgentScope,
    AgentStatus,
    type AgentTarget,
} from '../entities/agent.entity';
import { AgentRepository, type ListAgentsFilter } from '../database/repositories/agent.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { slugifyText } from '../utils/text.utils';
import { toAgentDto, type AgentDto } from './types';
import { computeNextHeartbeat } from './heartbeat-cron';

/**
 * Create-Agent input — writable subset of the entity. Validation
 * lives at the controller DTO layer (`CreateAgentDto` in apps/api).
 * Service enforces cross-field rules + uniqueness + permission
 * normalisation.
 */
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
    // FU-13 — per-Agent git committer identity. Both nullable; when
    // unset, the AGENT_GIT_FACADE binding falls back to the Agent's
    // name + a synthesized email (`<slug>@agents.ever.works`).
    committerName?: string | null;
    committerEmail?: string | null;
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
    committerName?: string | null;
    committerEmail?: string | null;
}

/**
 * Allowed status transitions (agents/spec.md §3.1 FR-5).
 * draft   → active
 * active ⇄ paused
 * active ⇄ running              (running set by dispatcher CAS-claim)
 * active  → error               (set by dispatcher after threshold)
 * error   → paused
 * paused  → active
 * *       → archived            (soft-delete)
 *
 * Note: `active → running` and `running → active` happen via the
 * repository CAS primitive, not through this service. Service
 * transitions are user-initiated.
 */
const USER_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
    [AgentStatus.DRAFT]: [AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ACTIVE]: [AgentStatus.PAUSED, AgentStatus.ARCHIVED],
    [AgentStatus.RUNNING]: [AgentStatus.ARCHIVED],
    [AgentStatus.PAUSED]: [AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ERROR]: [AgentStatus.PAUSED, AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ARCHIVED]: [],
};

/**
 * Core service for the Agents feature (agents/plan.md §2 services
 * row). Owns CRUD, scope-cascade validation, status transitions,
 * and the `tryClaimForRun → release/incrementError` lifecycle the
 * dispatcher calls.
 *
 * Cross-user reads return 404 (architecture/security §9): never
 * leak existence of another user's Agent via 403.
 */
@Injectable()
export class AgentsService {
    private readonly logger = new Logger(AgentsService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly memberships: AgentMembershipRepository,
        // Budget repo is here so `delete()` can clean up the per-Agent
        // budget row alongside (FK CASCADE handles it on DB but having
        // the call here keeps the service-level intent visible).
        private readonly budgets: AgentBudgetRepository,
    ) {}

    async list(
        userId: string,
        filter: ListAgentsFilter = {},
    ): Promise<{
        rows: AgentDto[];
        total: number;
    }> {
        const { rows, total } = await this.agents.findByUserIdScoped(userId, filter);
        return { rows: rows.map(toAgentDto), total };
    }

    async getOne(userId: string, id: string): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);
        return toAgentDto(agent);
    }

    async create(userId: string, input: CreateAgentInput): Promise<AgentDto> {
        this.validateScopeOwnership(input);

        const slug = slugifyText(input.name);
        if (!slug) {
            throw new BadRequestException(
                'Agent name must contain at least one alphanumeric character.',
            );
        }

        const conflict = await this.agents.findByUserIdAndSlug(userId, input.scope, slug, {
            missionId: input.scope === AgentScope.MISSION ? (input.missionId ?? null) : null,
            ideaId: input.scope === AgentScope.IDEA ? (input.ideaId ?? null) : null,
            workId: input.scope === AgentScope.WORK ? (input.workId ?? null) : null,
        });
        if (conflict) {
            throw new ConflictException(
                `An Agent named "${input.name}" already exists in this scope.`,
            );
        }

        const permissions: AgentPermissions = {
            ...AGENT_PERMISSIONS_DEFAULT,
            ...(input.permissions ?? {}),
        };
        // Refine: openPullRequests requires canCommitToRepo.
        if (permissions.canOpenPullRequests && !permissions.canCommitToRepo) {
            permissions.canCommitToRepo = true;
        }

        const avatarMode = input.avatarMode ?? AgentAvatarMode.INITIALS;
        this.validateAvatarFields(
            avatarMode,
            input.avatarIcon ?? null,
            input.avatarImageUploadId ?? null,
        );

        const created = await this.agents.create({
            userId,
            scope: input.scope,
            missionId: input.scope === AgentScope.MISSION ? (input.missionId ?? null) : null,
            ideaId: input.scope === AgentScope.IDEA ? (input.ideaId ?? null) : null,
            workId: input.scope === AgentScope.WORK ? (input.workId ?? null) : null,
            name: input.name,
            slug,
            title: input.title ?? null,
            capabilities: input.capabilities ?? null,
            aiProviderId: input.aiProviderId ?? null,
            modelId: input.modelId ?? null,
            maxSkillContextTokens: input.maxSkillContextTokens ?? 4000,
            status: AgentStatus.DRAFT,
            permissions,
            targets: input.targets ?? null,
            heartbeatCadence: input.heartbeatCadence ?? null,
            idleBehavior: input.idleBehavior ?? AgentIdleBehavior.PROPOSE,
            pauseAfterFailures: input.pauseAfterFailures ?? 3,
            errorCount: 0,
            avatarMode,
            avatarIcon: avatarMode === AgentAvatarMode.ICON ? (input.avatarIcon ?? null) : null,
            avatarImageUploadId:
                avatarMode === AgentAvatarMode.IMAGE ? (input.avatarImageUploadId ?? null) : null,
            // FU-13 — committer identity. Empty strings normalise to
            // null so a blank picker field doesn't accidentally persist
            // a no-op commit identity.
            committerName: input.committerName?.trim() ? input.committerName.trim() : null,
            committerEmail: input.committerEmail?.trim() ? input.committerEmail.trim() : null,
        });

        // Materialize tenant-Agent memberships into the join table for
        // indexed lookup from the per-target tabs.
        if (input.scope === AgentScope.TENANT && input.targets && input.targets.length > 0) {
            await this.memberships.replaceForAgent(
                created.id,
                input.targets
                    .filter((t) => t.type !== 'wildcard')
                    .map((t) => ({
                        targetType: t.type,
                        targetId: t.id ?? null,
                    })),
            );
        }

        return toAgentDto(created);
    }

    async update(userId: string, id: string, input: UpdateAgentInput): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);

        const patch: Partial<Agent> = {};

        if (input.name !== undefined) {
            const slug = slugifyText(input.name);
            if (!slug) {
                throw new BadRequestException(
                    'Agent name must contain at least one alphanumeric character.',
                );
            }
            if (slug !== agent.slug) {
                const conflict = await this.agents.findByUserIdAndSlug(userId, agent.scope, slug, {
                    missionId: agent.missionId ?? null,
                    ideaId: agent.ideaId ?? null,
                    workId: agent.workId ?? null,
                });
                if (conflict && conflict.id !== agent.id) {
                    throw new ConflictException(
                        `An Agent named "${input.name}" already exists in this scope.`,
                    );
                }
                patch.slug = slug;
            }
            patch.name = input.name;
        }

        if (input.title !== undefined) patch.title = input.title;
        if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
        if (input.aiProviderId !== undefined) patch.aiProviderId = input.aiProviderId;
        if (input.modelId !== undefined) patch.modelId = input.modelId;
        if (input.maxSkillContextTokens !== undefined)
            patch.maxSkillContextTokens = input.maxSkillContextTokens;
        if (input.heartbeatCadence !== undefined) patch.heartbeatCadence = input.heartbeatCadence;
        if (input.idleBehavior !== undefined) patch.idleBehavior = input.idleBehavior;
        if (input.pauseAfterFailures !== undefined)
            patch.pauseAfterFailures = input.pauseAfterFailures;

        if (input.permissions !== undefined) {
            const merged: AgentPermissions = { ...agent.permissions, ...input.permissions };
            if (merged.canOpenPullRequests && !merged.canCommitToRepo) {
                merged.canCommitToRepo = true;
            }
            patch.permissions = merged;
        }

        if (input.targets !== undefined) {
            patch.targets = input.targets;
        }

        if (
            input.avatarMode !== undefined ||
            input.avatarIcon !== undefined ||
            input.avatarImageUploadId !== undefined
        ) {
            const mode = input.avatarMode ?? agent.avatarMode;
            const icon =
                input.avatarIcon !== undefined ? input.avatarIcon : (agent.avatarIcon ?? null);
            const upload =
                input.avatarImageUploadId !== undefined
                    ? input.avatarImageUploadId
                    : (agent.avatarImageUploadId ?? null);
            this.validateAvatarFields(mode, icon, upload);
            patch.avatarMode = mode;
            patch.avatarIcon = mode === AgentAvatarMode.ICON ? icon : null;
            patch.avatarImageUploadId = mode === AgentAvatarMode.IMAGE ? upload : null;
        }

        // FU-13 — committer identity (each field independent so an
        // operator can override just the email without re-typing the
        // name). Empty-string normalises to null.
        if (input.committerName !== undefined) {
            const trimmed = input.committerName?.trim() ?? '';
            patch.committerName = trimmed.length > 0 ? trimmed : null;
        }
        if (input.committerEmail !== undefined) {
            const trimmed = input.committerEmail?.trim() ?? '';
            patch.committerEmail = trimmed.length > 0 ? trimmed : null;
        }

        await this.agents.updateById(id, patch);

        // Reconcile memberships if targets changed.
        if (input.targets !== undefined && agent.scope === AgentScope.TENANT) {
            await this.memberships.replaceForAgent(
                id,
                (input.targets ?? [])
                    .filter((t) => t.type !== 'wildcard')
                    .map((t) => ({ targetType: t.type, targetId: t.id ?? null })),
            );
        }

        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after update');
        return toAgentDto(refreshed);
    }

    async transition(userId: string, id: string, to: AgentStatus): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);
        const allowed = USER_TRANSITIONS[agent.status] ?? [];
        if (!allowed.includes(to)) {
            throw new BadRequestException(`Cannot transition Agent from ${agent.status} to ${to}.`);
        }
        const ok = await this.agents.transitionStatus(id, agent.status, to);
        if (!ok) {
            throw new ConflictException('Agent status changed between read and write — retry.');
        }
        // Activating from draft schedules first heartbeat.
        // Review-fix I17: compute the FIRST cadence slot via
        // `computeNextHeartbeat` instead of setting it to `now`. The
        // previous behavior fired the first heartbeat ~immediately on
        // activation regardless of cadence (e.g. an Agent on
        // `0 9 * * *` activated at 14:30 would fire a stray run at
        // 14:30, then again the next morning at 09:00). Now the first
        // scheduled fire genuinely respects the configured cadence.
        // Fallback to `now` if the cadence is unparseable so a
        // misconfigured Agent doesn't get stuck without scheduling.
        if (
            to === AgentStatus.ACTIVE &&
            agent.heartbeatCadence &&
            agent.heartbeatCadence !== 'manual'
        ) {
            const next = computeNextHeartbeat(agent.heartbeatCadence, new Date()) ?? new Date();
            await this.agents.updateById(id, { nextHeartbeatAt: next });
        }
        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after transition');
        return toAgentDto(refreshed);
    }

    async pause(userId: string, id: string): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.PAUSED);
    }

    async resume(userId: string, id: string): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.ACTIVE);
    }

    async archive(userId: string, id: string): Promise<{ archived: true }> {
        await this.requireOwned(userId, id);
        await this.agents.archiveById(id);
        return { archived: true };
    }

    async deleteHard(userId: string, id: string): Promise<{ deleted: true }> {
        await this.requireOwned(userId, id);
        await this.budgets.deleteByAgentId(id).catch(() => undefined); // FK CASCADE handles it; tolerate
        await this.memberships.deleteByAgentId(id).catch(() => undefined);
        await this.agents.deleteById(id);
        return { deleted: true };
    }

    // ── internals ─────────────────────────────────────────────────

    private async requireOwned(userId: string, id: string): Promise<Agent> {
        const agent = await this.agents.findByIdAndUser(id, userId);
        if (!agent) {
            // 404 (not 403) — don't leak existence.
            throw new NotFoundException(`Agent ${id} not found.`);
        }
        return agent;
    }

    private validateScopeOwnership(
        input: Pick<CreateAgentInput, 'scope' | 'missionId' | 'ideaId' | 'workId'>,
    ): void {
        const popCount = [input.missionId, input.ideaId, input.workId].filter(Boolean).length;
        switch (input.scope) {
            case AgentScope.TENANT:
                if (popCount > 0) {
                    throw new BadRequestException(
                        'Tenant-scoped Agents must not have missionId/ideaId/workId.',
                    );
                }
                break;
            case AgentScope.MISSION:
                if (!input.missionId || popCount !== 1) {
                    throw new BadRequestException(
                        'Mission-scoped Agents require missionId (and only missionId).',
                    );
                }
                break;
            case AgentScope.IDEA:
                if (!input.ideaId || popCount !== 1) {
                    throw new BadRequestException(
                        'Idea-scoped Agents require ideaId (and only ideaId).',
                    );
                }
                break;
            case AgentScope.WORK:
                if (!input.workId || popCount !== 1) {
                    throw new BadRequestException(
                        'Work-scoped Agents require workId (and only workId).',
                    );
                }
                break;
            default:
                throw new BadRequestException(`Unknown scope: ${input.scope}`);
        }
    }

    private validateAvatarFields(
        mode: AgentAvatarMode,
        icon: string | null,
        uploadId: string | null,
    ): void {
        if (mode === AgentAvatarMode.ICON && !icon) {
            throw new BadRequestException('avatarIcon required when avatarMode=icon');
        }
        if (mode === AgentAvatarMode.IMAGE && !uploadId) {
            throw new BadRequestException('avatarImageUploadId required when avatarMode=image');
        }
    }

    /**
     * Authorization helper for "Agent X assigns work to Agent Y" —
     * enforces the cross-scope rules in architecture §3. Used by the
     * tools-catalog `createTask` tool gate. Returns silently when OK,
     * throws ForbiddenException otherwise.
     *
     * Exported so other services (TaskTransitionService, mention
     * dispatch) can reuse it.
     */
    async assertCanAssignAcrossScope(actor: Agent, target: Agent): Promise<void> {
        if (actor.userId !== target.userId) {
            throw new ForbiddenException('Cross-user task assignment is not allowed.');
        }
        switch (actor.scope) {
            case AgentScope.TENANT:
                return; // Tenant can assign to any Agent the user owns.
            case AgentScope.MISSION:
                if (target.scope === AgentScope.MISSION && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.IDEA && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.WORK && target.missionId === actor.missionId)
                    return;
                throw new ForbiddenException(
                    'Mission-scoped Agents can only assign within their Mission.',
                );
            case AgentScope.IDEA:
                if (target.scope === AgentScope.IDEA && target.ideaId === actor.ideaId) return;
                if (target.scope === AgentScope.MISSION && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.WORK && target.ideaId === actor.ideaId) return;
                throw new ForbiddenException(
                    'Idea-scoped Agents can only assign within their Idea.',
                );
            case AgentScope.WORK:
                if (target.scope === AgentScope.WORK && target.workId === actor.workId) return;
                throw new ForbiddenException(
                    'Work-scoped Agents can only assign within their Work.',
                );
        }
    }
}
