import {
    getWorkCapabilities,
    RECIPIENT_EVENT_VISIBILITY,
    type IntegrationAgentDto,
    type IntegrationGoalDto,
    type IntegrationInboxItemDto,
    type IntegrationIdeaDto,
    type IntegrationMemberDto,
    type IntegrationMissionDto,
    type IntegrationOrganizationDto,
    type IntegrationTaskCommentDto,
    type IntegrationTaskDto,
    type IntegrationTeamDto,
    type IntegrationVisibility,
    type IntegrationWorkDto,
} from '@ever-works/contracts';
import { type EntityManager, In } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { ExternalIdentity } from '../entities/external-identity.entity';
import { Goal } from '../entities/goal.entity';
import { InboxItem } from '../entities/inbox-item.entity';
import { MissionGoal } from '../entities/mission-goal.entity';
import { Mission } from '../entities/mission.entity';
import { MissionWork } from '../entities/mission-work.entity';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { User } from '../entities/user.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';

/**
 * Integration DTO snapshots (integration contract v1, B.6) built from the
 * database with the caller's `EntityManager`, so an event's `data` reflects
 * the state its transaction is about to commit. The integration API (EW-P1-4)
 * serves the same builders, so an event's `data` and a GET of the same version
 * are identical.
 *
 * Tasks and agents carry their STORED record visibility (EW-P1-3,
 * `visibility` / `visibilityExplicit`): a `private` record's snapshot says
 * `private`, the recorder stores that on the event row, and the feed and
 * webhooks v2 never serve such an event (only the id-only
 * `*.visibility_changed` notice). Works carry no visibility column: theirs is
 * derived — `team` when the work sits on a team, else `organization`.
 */

/** A DTO plus the scope of the row it came from (the DTO has no tenant; personal rows have no org). */
export interface AggregateSnapshot<T> {
    readonly dto: T;
    readonly tenantId: string | null;
    readonly organizationId: string | null;
    /**
     * The event's `visibility` when the DTO carries none of its own (absent =
     * the DTO's `visibility`). `'private'` keeps the event out of the
     * integration feed and webhooks v2; in-process listeners still get it.
     */
    readonly visibility?: string | null;
}

const iso = (value: Date | string | null | undefined): string | null =>
    value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;
const isoRequired = (value: Date | string | null | undefined): string =>
    iso(value) ?? new Date(0).toISOString();

/** Public origin of the web app (`WEB_URL`), without a trailing slash; `null` when unset. */
export function webAppOrigin(): string | null {
    const value = process.env.WEB_URL?.trim();
    return value ? value.replace(/\/+$/, '') : null;
}

const webUrl = (path: string): string | null => {
    const origin = webAppOrigin();
    return origin ? `${origin}${path}` : null;
};

function derivedVisibility(teamIds: readonly string[]): IntegrationVisibility {
    return teamIds.length > 0 ? 'team' : 'organization';
}

/**
 * A record's stored visibility (EW-P1-3), or the derived value for a row read
 * before the column existed. `private` passes through (typed as the DTO's
 * visibility on purpose): it is what keeps the event out of the feed.
 */
function recordVisibility(
    row: { visibility?: string | null; visibilityExplicit?: boolean | null },
    teamIds: readonly string[],
): { visibility: IntegrationVisibility; visibilityExplicit: boolean } {
    const stored = row.visibility;
    if (stored === 'private' || stored === 'team' || stored === 'organization') {
        return {
            visibility: stored as IntegrationVisibility,
            visibilityExplicit: row.visibilityExplicit === true,
        };
    }
    return { visibility: derivedVisibility(teamIds), visibilityExplicit: false };
}

function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

/** The teams a resource is linked to through `team_resources`, oldest link first. */
export async function teamResourceIds(
    manager: EntityManager,
    resourceType: string,
    resourceId: string,
): Promise<string[]> {
    const rows = await manager.getRepository(TeamResource).find({
        where: { resourceType: resourceType as TeamResource['resourceType'], resourceId },
        order: { createdAt: 'ASC' },
    });
    return rows.map((row) => row.teamId);
}

/** The task's integration DTO, or `null` when the row is gone. */
export async function buildTaskSnapshot(
    manager: EntityManager,
    taskId: string,
): Promise<AggregateSnapshot<IntegrationTaskDto> | null> {
    const task = await manager.getRepository(Task).findOne({ where: { id: taskId } });
    if (!task) return null;
    const [assignees, watchers, approvers, reviewers, blocks, relations, resourceTeams] =
        await Promise.all([
            manager.getRepository(TaskAssignee).find({ where: { taskId } }),
            manager.getRepository(TaskWatcher).find({ where: { taskId } }),
            manager.getRepository(TaskApprover).find({ where: { taskId } }),
            manager.getRepository(TaskReviewer).find({ where: { taskId } }),
            manager.getRepository(TaskBlock).find({ where: { taskId } }),
            manager.getRepository(TaskRelation).find({ where: { taskId } }),
            teamResourceIds(manager, 'task', taskId),
        ]);
    const teamIds = unique([...(task.teamId ? [task.teamId] : []), ...resourceTeams]);
    const createdByType = (task.createdByType as string) || 'user';
    const dto: IntegrationTaskDto = {
        id: task.id,
        organizationId: task.organizationId ?? '',
        version: Number(task.version) || 1,
        createdAt: isoRequired(task.createdAt),
        updatedAt: isoRequired(task.updatedAt),
        ...recordVisibility(task, teamIds),
        owner: { type: 'user', id: task.userId },
        createdBy: {
            type:
                createdByType === 'agent' || createdByType === 'integration'
                    ? createdByType
                    : 'user',
            id: task.createdById || task.userId,
        },
        externalLinks: [],
        teamIds,
        slug: task.slug,
        title: task.title,
        description: task.description ?? null,
        status: task.status as IntegrationTaskDto['status'],
        priority: task.priority as IntegrationTaskDto['priority'],
        labels: unique(task.labels ?? []),
        workId: task.workId ?? null,
        missionId: task.missionId ?? null,
        ideaId: task.ideaId ?? null,
        goalId: task.goalId ?? null,
        agentId: task.agentId ?? null,
        parentTaskId: task.parentTaskId ?? null,
        assignees: assignees.map((row) => ({
            type: row.assigneeType as 'user' | 'agent',
            id: row.assigneeId,
        })),
        watchers: unique(watchers.map((row) => row.userId)),
        approvers: approvers.map((row) => ({
            type: row.approverType as 'user' | 'agent',
            id: row.approverId,
            state: row.approvalState as 'pending' | 'approved' | 'rejected',
        })),
        reviewers: reviewers.map((row) => ({
            type: row.reviewerType as 'user' | 'agent',
            id: row.reviewerId,
            state: row.reviewState as 'pending' | 'requested-changes' | 'approved',
        })),
        blockedBy: unique(blocks.map((row) => row.blockedByTaskId)),
        relations: relations.map((row) => ({
            taskId: row.relatedTaskId,
            kind: row.kind as 'related' | 'duplicates' | 'follow-up',
        })),
        startedAt: iso(task.startedAt),
        completedAt: iso(task.completedAt),
        // EW-P2-3 — planning dates + estimate.
        dueAt: iso(task.dueAt),
        startAt: iso(task.startAt),
        estimateMinutes:
            task.estimateMinutes === null || task.estimateMinutes === undefined
                ? null
                : Number(task.estimateMinutes),
        isRecurringTemplate: !!task.isRecurring,
        hiddenFromBoard: !!task.hiddenFromBoard,
        runtime: {
            prUrl: task.prUrl ?? null,
            prState: (task.prState as string | null | undefined) ?? null,
            ciState: (task.ciState as string | null | undefined) ?? null,
            latestRunStatus: (task.latestRunStatus as string | null | undefined) ?? null,
        },
        webUrl: webUrl(`/tasks/${task.id}`),
    };
    return { dto, tenantId: task.tenantId ?? null, organizationId: task.organizationId ?? null };
}

/**
 * A task chat message as the comment DTO. A message row is not always stamped
 * with its scope (raw routes run without one), so the parent task's
 * organization is the fallback.
 */
export function toTaskCommentDto(
    message: TaskChatMessage,
    taskOrganizationId?: string | null,
): IntegrationTaskCommentDto {
    const authorType = (message.authorType as string) || 'user';
    return {
        id: message.id,
        taskId: message.taskId,
        organizationId: message.organizationId ?? taskOrganizationId ?? '',
        authorType: authorType === 'agent' || authorType === 'integration' ? authorType : 'user',
        authorId: message.authorId,
        // EW-P1-2 — display attribution of an integration author (null otherwise).
        externalAuthor:
            authorType === 'integration' && message.externalAuthor
                ? {
                      name: message.externalAuthor.name,
                      avatarUrl: message.externalAuthor.avatarUrl ?? null,
                      source: message.externalAuthor.source,
                  }
                : null,
        body: message.body,
        mentions: (message.mentions ?? []).map((mention) => ({
            type: mention.type,
            id: mention.id ?? null,
            slug: mention.slug ?? null,
        })),
        editedAt: iso(message.editedAt),
        createdAt: isoRequired(message.createdAt),
        updatedAt: isoRequired(message.updatedAt),
        externalLinks: [],
    };
}

/** The tables of the team-resource types that carry a record visibility (EW-P1-3). */
const VISIBILITY_RESOURCE_ENTITIES = {
    task: Task,
    goal: Goal,
    mission: Mission,
    idea: WorkProposal,
    agent: Agent,
} as const;

/** `type:id` of the team resources whose record is `private`. */
async function privateTeamResources(
    manager: EntityManager,
    rows: readonly TeamResource[],
): Promise<Set<string>> {
    const hidden = new Set<string>();
    for (const [type, entity] of Object.entries(VISIBILITY_RESOURCE_ENTITIES)) {
        const ids = rows.filter((row) => row.resourceType === type).map((row) => row.resourceId);
        if (ids.length === 0) continue;
        const found = await manager.getRepository<{ id: string; visibility: string }>(entity).find({
            where: { id: In(ids), visibility: 'private' },
            select: { id: true },
        });
        for (const row of found) hidden.add(`${type}:${row.id}`);
    }
    return hidden;
}

/** The team's integration DTO (members and resources embedded), or `null` when gone. */
export async function buildTeamSnapshot(
    manager: EntityManager,
    teamId: string,
): Promise<AggregateSnapshot<IntegrationTeamDto> | null> {
    const team = await manager.getRepository(Team).findOne({ where: { id: teamId } });
    if (!team) return null;
    const [members, linked] = await Promise.all([
        manager.getRepository(TeamMember).find({ where: { teamId }, order: { createdAt: 'ASC' } }),
        manager
            .getRepository(TeamResource)
            .find({ where: { teamId }, order: { createdAt: 'ASC' } }),
    ]);
    // Review 2026-10-17 F4: a record made private keeps its `team_resources` row, but
    // its id never goes to an integration (nor can a full-set PUT detach it).
    const hidden = await privateTeamResources(manager, linked);
    const resources = linked.filter((row) => !hidden.has(`${row.resourceType}:${row.resourceId}`));
    const dto: IntegrationTeamDto = {
        id: team.id,
        organizationId: team.organizationId ?? '',
        version: Number(team.version) || 1,
        createdAt: isoRequired(team.createdAt),
        updatedAt: isoRequired(team.updatedAt),
        visibility: 'organization',
        visibilityExplicit: false,
        owner: { type: 'user', id: team.userId },
        createdBy: { type: 'user', id: team.userId },
        externalLinks: [],
        name: team.name,
        slug: team.slug,
        description: team.description ?? null,
        parentTeamId: team.parentTeamId ?? null,
        managerAgentId: team.managerAgentId ?? null,
        avatarIcon: team.avatarIcon ?? null,
        members: members.map((row) => ({
            memberType: row.memberType as 'user' | 'agent',
            memberId: row.memberId,
            role: row.role as 'lead' | 'member',
        })),
        resources: resources.map((row) => ({
            resourceType: row.resourceType,
            resourceId: row.resourceId,
        })),
        webUrl: webUrl(`/teams/${team.id}`),
    };
    return { dto, tenantId: team.tenantId ?? null, organizationId: team.organizationId ?? null };
}

/** The agent's integration DTO (team scope = its team memberships), or `null` when gone. */
export async function buildAgentSnapshot(
    manager: EntityManager,
    agentId: string,
): Promise<AggregateSnapshot<IntegrationAgentDto> | null> {
    const agent = await manager.getRepository(Agent).findOne({ where: { id: agentId } });
    if (!agent) return null;
    const memberships = await manager
        .getRepository(TeamMember)
        .find({ where: { memberType: 'agent' as TeamMember['memberType'], memberId: agentId } });
    const teamIds = unique(memberships.map((row) => row.teamId));
    const avatar = agent as unknown as { avatarMode?: string; avatarIcon?: string | null };
    const dto: IntegrationAgentDto = {
        id: agent.id,
        organizationId: agent.organizationId ?? '',
        version: Number(agent.version) || 1,
        createdAt: isoRequired(agent.createdAt),
        updatedAt: isoRequired(agent.updatedAt),
        ...recordVisibility(agent, teamIds),
        owner: { type: 'user', id: agent.userId },
        createdBy: { type: 'user', id: agent.userId },
        externalLinks: [],
        teamIds,
        name: agent.name,
        slug: agent.slug,
        title: agent.title ?? null,
        capabilities: agent.capabilities ?? null,
        status: agent.status as IntegrationAgentDto['status'],
        scope: agent.scope as IntegrationAgentDto['scope'],
        scopeTargetId: agent.scopeTargetId,
        reportsToAgentId: agent.reportsToAgentId ?? null,
        avatar: {
            mode: (avatar.avatarMode as 'initials' | 'icon' | 'image') || 'initials',
            icon: avatar.avatarIcon ?? null,
            url: null,
        },
        modelId: agent.modelId ?? null,
        lastRunAt: iso(agent.lastRunAt),
        webUrl: webUrl(`/agents/${agent.id}`),
    };
    return { dto, tenantId: agent.tenantId ?? null, organizationId: agent.organizationId ?? null };
}

/**
 * `createdBy` of a P2 aggregate (ideas, goals, missions, and works — a Project Work created
 * through the integration API, EW-P2-4): the stored author when an integration or agent
 * created it (`createdByType` / `createdById`, migrations 1795100000000 and 1795162200000),
 * else the owning user.
 */
function p2CreatedBy(row: {
    userId: string;
    createdByType?: string | null;
    createdById?: string | null;
}): IntegrationIdeaDto['createdBy'] {
    if ((row.createdByType === 'integration' || row.createdByType === 'agent') && row.createdById) {
        return { type: row.createdByType, id: row.createdById };
    }
    return { type: 'user', id: row.userId };
}

/** The Idea's (work_proposals) integration DTO, or `null` when the row is gone (EW-P2-1). */
export async function buildIdeaSnapshot(
    manager: EntityManager,
    ideaId: string,
): Promise<AggregateSnapshot<IntegrationIdeaDto> | null> {
    const idea = await manager.getRepository(WorkProposal).findOne({ where: { id: ideaId } });
    if (!idea) return null;
    const teamIds = unique(await teamResourceIds(manager, 'idea', ideaId));
    const dto: IntegrationIdeaDto = {
        id: idea.id,
        organizationId: idea.organizationId ?? '',
        version: Number(idea.version) || 1,
        createdAt: isoRequired(idea.generatedAt),
        updatedAt: isoRequired(idea.updatedAt ?? idea.generatedAt),
        ...recordVisibility(idea, teamIds),
        owner: { type: 'user', id: idea.userId },
        createdBy: p2CreatedBy(idea),
        externalLinks: [],
        teamIds,
        title: idea.title,
        description: idea.description,
        status: idea.status as IntegrationIdeaDto['status'],
        source: idea.source as IntegrationIdeaDto['source'],
        missionId: idea.missionId ?? null,
        targetWorkId: idea.targetWorkId ?? null,
        acceptedWorkId: idea.acceptedWorkId ?? null,
        failureMessage: idea.failureMessage ?? null,
        webUrl: webUrl(`/ideas/${idea.id}`),
    };
    return { dto, tenantId: idea.tenantId ?? null, organizationId: idea.organizationId ?? null };
}

/**
 * EW's 0..100 progress view of a Goal (plan 01 §6, mapped to the Gauzy Goal's
 * `progress`): the weighted score when the Goal has criteria and was scored; for a
 * metric Goal the baseline → current → target ratio; for a delivery Goal the share
 * of its approved Definition of Done that is closed. `null` when nothing is known.
 */
export function goalProgress(goal: Goal): number | null {
    const clamp = (ratio: number) => Math.max(0, Math.min(100, Math.round(ratio * 100)));
    if (goal.goalKind === 'delivery') {
        const approved = (Array.isArray(goal.dodCriteria) ? goal.dodCriteria : []).filter(
            (criterion) => criterion.proposed !== true,
        );
        if (approved.length === 0) return null;
        const closed = approved.filter(
            (criterion) => criterion.status === 'done' || criterion.status === 'waived',
        ).length;
        return clamp(closed / approved.length);
    }
    if (Array.isArray(goal.criteria) && goal.criteria.length > 0 && goal.resolvedScore) {
        const score = Number(goal.resolvedScore.score);
        return Number.isFinite(score) ? clamp(score) : null;
    }
    const current = goal.currentValue;
    const target = goal.targetValue;
    if (typeof current !== 'number' || typeof target !== 'number') return null;
    const baseline = typeof goal.baselineValue === 'number' ? goal.baselineValue : 0;
    if (target === baseline)
        return clamp(
            goal.comparator === 'lte' ? (current <= target ? 1 : 0) : current >= target ? 1 : 0,
        );
    return clamp((current - baseline) / (target - baseline));
}

/** The Goal's integration DTO (teams and mission links embedded), or `null` when gone (EW-P2-2). */
export async function buildGoalSnapshot(
    manager: EntityManager,
    goalId: string,
): Promise<AggregateSnapshot<IntegrationGoalDto> | null> {
    const goal = await manager.getRepository(Goal).findOne({ where: { id: goalId } });
    if (!goal) return null;
    const [resourceTeams, missionLinks] = await Promise.all([
        teamResourceIds(manager, 'goal', goalId),
        manager.getRepository(MissionGoal).find({ where: { goalId }, order: { createdAt: 'ASC' } }),
    ]);
    const teamIds = unique(resourceTeams);
    const primary = missionLinks.find((link) => link.isPrimary) ?? null;
    const dto: IntegrationGoalDto = {
        id: goal.id,
        organizationId: goal.organizationId ?? '',
        version: Number(goal.version) || 1,
        createdAt: isoRequired(goal.createdAt),
        updatedAt: isoRequired(goal.updatedAt ?? goal.createdAt),
        ...recordVisibility(goal, teamIds),
        owner: { type: 'user', id: goal.userId },
        createdBy: p2CreatedBy(goal),
        externalLinks: [],
        teamIds,
        title: goal.title,
        description: goal.description ?? null,
        goalKind: goal.goalKind === 'delivery' ? 'delivery' : 'metric',
        status: goal.status as IntegrationGoalDto['status'],
        outcome: (goal.outcome ?? null) as IntegrationGoalDto['outcome'],
        metricSource: goal.metricSource ?? null,
        comparator: goal.comparator ?? null,
        targetValue: goal.targetValue ?? null,
        unit: goal.unit ?? null,
        window: goal.window,
        baselineValue: goal.baselineValue ?? null,
        currentValue: goal.currentValue ?? null,
        currentValueAt: iso(goal.currentValueAt),
        deadline: iso(goal.deadline),
        criteria: goal.criteria ?? null,
        resolvedScore: goal.resolvedScore ?? null,
        dodCriteria: (goal.dodCriteria ?? null) as IntegrationGoalDto['dodCriteria'],
        progress: goalProgress(goal),
        missionIds: unique(missionLinks.map((link) => link.missionId)),
        primaryMissionId: primary?.missionId ?? null,
        assignedAgentId: goal.assignedAgentId ?? null,
        activeAgentId: goal.activeAgentId ?? null,
        loop: {
            status: goal.loopStatus ?? null,
            iteration: Number(goal.iteration) || 0,
            spentCents: Number(goal.spentCents) || 0,
        },
        archivedAt: iso(goal.archivedAt),
        webUrl: webUrl(`/goals/${goal.id}`),
    };
    return { dto, tenantId: goal.tenantId ?? null, organizationId: goal.organizationId ?? null };
}

/**
 * The Mission's integration DTO (plan D3b: a Gauzy Strategic Initiative) with its
 * Teams, Goal links (primary first) and typed Work links, or `null` when gone (EW-P2-5).
 */
export async function buildMissionSnapshot(
    manager: EntityManager,
    missionId: string,
): Promise<AggregateSnapshot<IntegrationMissionDto> | null> {
    const mission = await manager.getRepository(Mission).findOne({ where: { id: missionId } });
    if (!mission) return null;
    const [resourceTeams, goalLinks, workLinks] = await Promise.all([
        teamResourceIds(manager, 'mission', missionId),
        manager
            .getRepository(MissionGoal)
            .find({ where: { missionId }, order: { createdAt: 'ASC' } }),
        manager
            .getRepository(MissionWork)
            .find({ where: { missionId }, order: { createdAt: 'ASC' } }),
    ]);
    const teamIds = unique(resourceTeams);
    const goals = [...goalLinks]
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        .map((link) => ({ goalId: link.goalId, isPrimary: link.isPrimary === true }));
    const dto: IntegrationMissionDto = {
        id: mission.id,
        organizationId: mission.organizationId ?? '',
        version: Number(mission.version) || 1,
        createdAt: isoRequired(mission.createdAt),
        updatedAt: isoRequired(mission.updatedAt ?? mission.createdAt),
        ...recordVisibility(mission, teamIds),
        owner: { type: 'user', id: mission.userId },
        createdBy: p2CreatedBy(mission),
        externalLinks: [],
        teamIds,
        title: mission.title,
        description: mission.description,
        type: mission.type as IntegrationMissionDto['type'],
        status: mission.status as IntegrationMissionDto['status'],
        outcome: (mission.outcome ?? null) as IntegrationMissionDto['outcome'],
        completedAt: iso(mission.completedAt),
        schedule: mission.schedule ?? null,
        autoBuildWorks: mission.autoBuildWorks === true,
        goals,
        works: workLinks.map((link) => ({
            workId: link.workId,
            relation: link.relation as IntegrationMissionDto['works'][number]['relation'],
        })),
        sourceMissionId: mission.sourceMissionId ?? null,
        webUrl: webUrl(`/missions/${mission.id}`),
    };
    return {
        dto,
        tenantId: mission.tenantId ?? null,
        organizationId: mission.organizationId ?? null,
    };
}

/** The work's integration DTO (members and repositories embedded), or `null` when gone. */
export async function buildWorkSnapshot(
    manager: EntityManager,
    workId: string,
): Promise<AggregateSnapshot<IntegrationWorkDto> | null> {
    const work = await manager.getRepository(Work).findOne({ where: { id: workId } });
    if (!work) return null;
    const [members, teamIds] = await Promise.all([
        manager.getRepository(WorkMember).find({ where: { workId }, order: { createdAt: 'ASC' } }),
        teamResourceIds(manager, 'work', workId),
    ]);
    const repos = getWorkCapabilities(work.kind).repos;
    const repoUrls: string[] = [];
    const host = (work.gitProvider || 'github') === 'github' ? 'https://github.com' : null;
    const roles: Array<'work' | 'data' | 'website'> = ['work', 'data', 'website'];
    for (const role of roles) {
        if (!repos[role] || !host) continue;
        const repo =
            role === 'work'
                ? work.getMainRepo()
                : role === 'data'
                  ? work.getDataRepo()
                  : work.getWebsiteRepo();
        const owner = work.getRepoOwner(role);
        if (owner && repo) repoUrls.push(`${host}/${owner}/${repo}`);
    }
    const memberRefs = [
        { userId: work.userId, role: 'owner' as const },
        ...members
            .filter((row) => row.userId !== work.userId)
            .map((row) => ({
                userId: row.userId,
                role: row.role as 'manager' | 'editor' | 'viewer',
            })),
    ];
    const dto: IntegrationWorkDto = {
        id: work.id,
        organizationId: work.organizationId ?? '',
        version: Number(work.version) || 1,
        createdAt: isoRequired(work.createdAt),
        updatedAt: isoRequired(work.updatedAt),
        visibility: derivedVisibility(teamIds),
        visibilityExplicit: false,
        owner: { type: 'user', id: work.userId },
        createdBy: p2CreatedBy(work),
        externalLinks: [],
        teamIds,
        name: work.name,
        slug: work.slug,
        description: work.description ?? null,
        kind: work.kind ?? 'default',
        status: (work.status ?? 'active') as IntegrationWorkDto['status'],
        website: work.website || null,
        repoUrls: unique(repoUrls),
        members: memberRefs,
        webUrl: webUrl(`/works/${work.id}`),
    };
    return { dto, tenantId: work.tenantId ?? null, organizationId: work.organizationId ?? null };
}

/** The organization's integration DTO, or `null` when gone. */
export async function buildOrganizationSnapshot(
    manager: EntityManager,
    organizationId: string,
): Promise<AggregateSnapshot<IntegrationOrganizationDto> | null> {
    const org = await manager
        .getRepository(Organization)
        .findOne({ where: { id: organizationId } });
    if (!org) return null;
    const dto: IntegrationOrganizationDto = {
        id: org.id,
        tenantId: org.tenantId,
        slug: org.slug,
        displayName: org.displayName,
        legalName: org.legalName ?? null,
        countryCode: org.countryCode ?? null,
        version: Number(org.version) || 1,
        createdAt: isoRequired(org.createdAt),
        updatedAt: isoRequired(org.updatedAt),
        webUrl: webUrl(`/${org.slug}/dashboard`),
    };
    return { dto, tenantId: org.tenantId ?? null, organizationId: org.id };
}

/** One roster row as the member DTO, or `null` when the user is gone. */
export async function buildMemberSnapshot(
    manager: EntityManager,
    member: Pick<
        OrganizationMember,
        'organizationId' | 'userId' | 'role' | 'joinedAt' | 'updatedAt'
    >,
): Promise<IntegrationMemberDto | null> {
    const user = await manager.getRepository(User).findOne({ where: { id: member.userId } });
    if (!user) return null;
    const identities = await manager
        .getRepository(ExternalIdentity)
        .find({ where: { userId: member.userId } });
    return {
        organizationId: member.organizationId,
        userId: member.userId,
        username: user.username,
        // EW-P2-6 — the optional `users.displayName` (null = the username).
        displayName: user.displayName ?? null,
        email: user.email ?? null,
        emailVerified: !!user.emailVerified,
        avatarUrl: user.avatar || null,
        role: (member.role as string) || 'member',
        isActive: !!user.isActive,
        joinedAt: isoRequired(member.joinedAt),
        updatedAt: isoRequired(member.updatedAt ?? member.joinedAt),
        everIdSubjects: identities.map((row) => ({ issuer: row.issuer, subject: row.subject })),
    };
}

/**
 * EW-P3-1 — one inbox row as the integration DTO (`inbox.item.*` event
 * `data`, `GET /inbox/items[/:id]`). Pure: the GET and the event of the same
 * version are built by this one mapper, so they are identical. `sourceMeta`
 * (fleet provenance: node names, branches, mount directories) is not exposed.
 */
export function toIntegrationInboxItemDto(row: InboxItem): IntegrationInboxItemDto {
    const options = Array.isArray(row.options)
        ? row.options.map((option) => {
              const out: {
                  id: string;
                  label: string;
                  description?: string;
                  recommended?: boolean;
              } = { id: option.id, label: option.label };
              if (typeof option.description === 'string') out.description = option.description;
              if (typeof option.recommended === 'boolean') out.recommended = option.recommended;
              return out;
          })
        : null;
    return {
        id: row.id,
        organizationId: row.organizationId ?? null,
        version: Number(row.version) || 1,
        createdAt: isoRequired(row.createdAt),
        updatedAt: isoRequired(row.updatedAt ?? row.createdAt),
        recipientUserId: row.userId,
        kind: row.kind,
        title: row.title,
        body: row.body,
        options,
        sourceType: row.sourceType,
        status: row.status,
        unread: !!row.unread,
        answeredAt: iso(row.answeredAt),
        answerText: row.answerText ?? null,
        answerOptionId: row.answerOptionId ?? null,
        agentId: row.agentId ?? null,
        agentRunId: row.agentRunId ?? null,
        taskId: row.taskId ?? null,
        workId: row.workId ?? null,
        escalationId: row.escalationId ?? null,
        proposalId: row.proposalId ?? null,
        // The Inbox deep link the bell and channel messages use (`/inbox?id=`).
        webUrl: webUrl(`/inbox?id=${encodeURIComponent(row.id)}`),
    };
}

/**
 * EW-P3-1 — `inbox_item` snapshot. The tenant is the row's own, else its
 * organization's (inbox rows written before tenancy stamping carry only the
 * organization), else `null` (a personal-scope message: recorded for
 * in-process listeners, never served to integrations).
 *
 * Recorded `recipient` ({@link RECIPIENT_EVENT_VISIBILITY}): an inbox item is
 * ONE person's message (the question an agent asked them, their approval, their
 * answer). An ordinary organization event would reach every key with
 * `events:read` on the organization and every webhook on it. A `recipient`
 * event reaches only an integration key that also holds `inbox:read` (the
 * scope that reads every recipient's messages through `GET /inbox/items`), and
 * never a user-owned webhook subscription; in-process listeners get them all.
 * (It was recorded `private` until those routes existed, #2644.)
 */
export async function buildInboxItemSnapshot(
    manager: EntityManager,
    id: string,
): Promise<AggregateSnapshot<IntegrationInboxItemDto> | null> {
    const row = await manager.getRepository(InboxItem).findOne({ where: { id } });
    if (!row) return null;
    let tenantId = row.tenantId ?? null;
    if (!tenantId && row.organizationId) {
        const org = await manager
            .getRepository(Organization)
            .findOne({ where: { id: row.organizationId } });
        tenantId = org?.tenantId ?? null;
    }
    return {
        dto: toIntegrationInboxItemDto(row),
        tenantId,
        organizationId: row.organizationId ?? null,
        visibility: RECIPIENT_EVENT_VISIBILITY,
    };
}
