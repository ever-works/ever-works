import {
    ConflictException,
    Injectable,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { Task } from '../entities/task.entity';
import type { VisibilityAggregate } from '@ever-works/contracts';
import { RecordVisibilityService } from '../record-visibility/record-visibility.service';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, In, Repository } from 'typeorm';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { User } from '../entities/user.entity';
import { slugifyText } from '../utils/text.utils';
import { serializeOnSingleConnection } from '../database/repositories/single-connection-write-queue';
import {
    AddTeamMemberInput,
    CreateTeamInput,
    ORG_USER_DIRECTORY_LIMIT,
    OrgUserView,
    TEAM_HIERARCHY_WALK_LIMIT,
    TEAM_MAX_DEPTH,
    TeamMemberView,
    UpdateTeamInput,
} from './types';

/**
 * Teams & Prebuilt Companies — Team CRUD + roster
 * (`docs/specs/features/teams-and-companies/spec.md` §1.1, §3).
 *
 * Authorization happens BEFORE these methods run: every `:orgId` route is
 * behind `OrganizationOwnershipGuard` (fail-closed tenant-ownership, 404
 * posture). This service re-validates the *object graph* — that referenced
 * teams/agents/users actually belong to the same Organization/Tenant — so a
 * legitimate caller cannot link foreign rows by id (the EW-711 IDOR class).
 */
@Injectable()
export class TeamsService {
    constructor(
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(TeamMember)
        private readonly members: Repository<TeamMember>,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(User)
        private readonly users: Repository<User>,
        // Domain events (EW-P1-1 B2) — `team.*` recorded in the same
        // transaction as each write. Appended LAST + @Optional; absent, every
        // write runs exactly as before and records nothing.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
        // Record visibility (EW-P1-3) — automatic Team ↔ Organization scope when an
        // agent joins or leaves a Team, or a Team is deleted. @Optional(): absent
        // means no automatic change (today's behaviour).
        @Optional() private readonly visibility?: RecordVisibilityService,
    ) {}

    /** Run `write` (and `record`) in one transaction when events are wired; as today otherwise. */
    private async withTeamEvent<T>(
        write: (manager?: EntityManager) => Promise<T>,
        record: (
            publisher: DomainEventPublisher,
            manager: EntityManager,
            result: T,
        ) => Promise<unknown>,
    ): Promise<T> {
        const publisher = this.domainEvents;
        if (!publisher) return write(undefined);
        return publisher.transaction(async (manager) => {
            const result = await write(manager);
            await record(publisher, manager, result);
            return result;
        });
    }

    async list(orgId: string): Promise<Team[]> {
        return this.teams.find({ where: { organizationId: orgId }, order: { name: 'ASC' } });
    }

    async getOrThrow(orgId: string, teamId: string): Promise<Team> {
        const team = await this.teams.findOne({ where: { id: teamId, organizationId: orgId } });
        if (!team) {
            // 404-not-403 house contract — foreign/missing ids are indistinguishable.
            throw new NotFoundException(`Team ${teamId} not found`);
        }
        return team;
    }

    /**
     * `withinCreate` (T17a) runs right after the row is written, in the SAME
     * transaction as the row and its `team.created` event (when domain events
     * are wired): the integration API links the team to its `externalRef`
     * there, so both commit or roll back together. A throw undoes the create.
     */
    async create(
        userId: string,
        orgId: string,
        input: CreateTeamInput,
        options: {
            readonly withinCreate?: (team: Team, manager?: EntityManager) => Promise<void>;
        } = {},
    ): Promise<Team> {
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }

        const slug = this.normalizeSlug(input.slug ?? input.name);
        if (input.parentTeamId) {
            await this.assertValidParent(orgId, null, input.parentTeamId);
        }
        if (input.managerAgentId) {
            await this.assertAgentInOrg(org, input.managerAgentId);
        }

        const team = this.teams.create({
            userId,
            name: input.name.trim(),
            slug,
            description: input.description ?? null,
            parentTeamId: input.parentTeamId ?? null,
            managerAgentId: input.managerAgentId ?? null,
            avatarIcon: input.avatarIcon ?? null,
            metadata: input.metadata ?? null,
            // Explicit stamp (not left to the ALS subscriber): raw
            // `/api/organizations/:orgId/...` routes run with EMPTY_SCOPE,
            // so the ambient scope may not carry this org.
            tenantId: org.tenantId,
            organizationId: org.id,
        });

        try {
            return await this.withTeamEvent(
                async (manager) => {
                    const saved = await (manager ? manager.getRepository(Team) : this.teams).save(
                        team,
                    );
                    if (options.withinCreate) await options.withinCreate(saved, manager);
                    return saved;
                },
                (publisher, manager, saved) =>
                    publisher.created(manager, 'team', saved.id, 'team.created'),
            );
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                throw new ConflictException(
                    `A team with slug "${slug}" already exists in this organization`,
                );
            }
            throw error;
        }
    }

    async update(orgId: string, teamId: string, input: UpdateTeamInput): Promise<Team> {
        const team = await this.getOrThrow(orgId, teamId);
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }

        if (input.parentTeamId !== undefined && input.parentTeamId !== null) {
            await this.assertValidParent(orgId, teamId, input.parentTeamId);
        }
        if (input.managerAgentId !== undefined && input.managerAgentId !== null) {
            await this.assertAgentInOrg(org, input.managerAgentId);
        }

        const previous: Record<string, unknown> = {};
        const note = (
            field: 'name' | 'description' | 'parentTeamId' | 'managerAgentId' | 'avatarIcon',
            next: unknown,
        ) => {
            if ((team[field] ?? null) !== (next ?? null)) previous[field] = team[field] ?? null;
        };
        if (input.name !== undefined) note('name', input.name.trim());
        if (input.description !== undefined) note('description', input.description);
        if (input.parentTeamId !== undefined) note('parentTeamId', input.parentTeamId);
        if (input.managerAgentId !== undefined) note('managerAgentId', input.managerAgentId);
        if (input.avatarIcon !== undefined) note('avatarIcon', input.avatarIcon);

        if (input.name !== undefined) team.name = input.name.trim();
        if (input.description !== undefined) team.description = input.description;
        if (input.parentTeamId !== undefined) team.parentTeamId = input.parentTeamId;
        if (input.managerAgentId !== undefined) team.managerAgentId = input.managerAgentId;
        if (input.avatarIcon !== undefined) team.avatarIcon = input.avatarIcon;

        return this.withTeamEvent(
            (manager) => (manager ? manager.getRepository(Team) : this.teams).save(team),
            async (publisher, manager, saved) => {
                const version = await publisher.changed(manager, 'team', saved.id, 'team.updated', {
                    changedFields: Object.keys(previous),
                    previous,
                });
                // The bump is a SQL increment the saved entity did not see.
                if (version !== null) saved.version = version;
            },
        );
    }

    /**
     * Delete a team. Children are re-parented to the deleted team's parent
     * (never deleted with it — spec §3); roster rows cascade at the DB level.
     * Re-parent + delete run in ONE transaction so a mid-flight failure can't
     * leave children pointing at a deleted parent (PR #1647 review).
     */
    async remove(orgId: string, teamId: string): Promise<void> {
        const team = await this.getOrThrow(orgId, teamId);
        // Record visibility (EW-P1-3): the Team's records lose it with the delete
        // (team_resources / team_members cascade, tasks.teamId is SET NULL), so
        // collect them first and widen the ones left with no Team afterwards.
        const affected = this.visibility ? await this.visibility.recordsOfTeam(teamId) : [];
        const removeIn = async (em: EntityManager) => {
            await em
                .getRepository(Team)
                .update(
                    { parentTeamId: teamId, organizationId: orgId },
                    { parentTeamId: team.parentTeamId ?? null },
                );
            await em.getRepository(Team).delete({ id: teamId });
            // `tasks.teamId` is ON DELETE SET NULL; clear it here too so the automatic
            // visibility below sees the same state on every dialect (EW-P1-3).
            await em
                .getRepository(Task)
                .update({ teamId, organizationId: orgId }, { teamId: null });
        };
        const publisher = this.domainEvents;
        if (!publisher) {
            // Queued on single-connection drivers, like every other transaction that can
            // overlap a queued one there.
            await serializeOnSingleConnection(this.teams.manager, () =>
                this.teams.manager.transaction(removeIn),
            );
            await this.recomputeVisibilityOf(affected);
            return;
        }
        await publisher.transaction(async (em) => {
            const tombstone = await publisher.beforeDelete(em, 'team', teamId);
            // What the delete changes beyond the team itself (EW-P1-1 B2): child
            // teams are re-parented, and the roster rows and resource links go
            // with it, so agents, tasks and works lose this team from `teamIds`.
            const [children, agentMembers, links] = await Promise.all([
                em.getRepository(Team).find({
                    where: { parentTeamId: teamId, organizationId: orgId },
                    select: ['id'],
                }),
                em.getRepository(TeamMember).find({
                    where: { teamId, memberType: 'agent' as TeamMember['memberType'] },
                    select: ['memberId'],
                }),
                em.getRepository(TeamResource).find({
                    where: { teamId },
                    select: ['resourceType', 'resourceId'],
                }),
            ]);
            await removeIn(em);
            // The database cascades these rows; delete them here too, so the
            // side events below snapshot the state after the delete on every
            // dialect (better-sqlite3 runs with foreign keys off in places).
            await em.getRepository(TeamMember).delete({ teamId });
            await em.getRepository(TeamResource).delete({ teamId });
            await publisher.deleted(em, tombstone, 'team.deleted');
            // Record visibility (EW-P1-3): widen what lost its last Team BEFORE the side
            // events below snapshot it. Records those events re-snapshot need no extra
            // notice; the others (e.g. tasks whose teamId the delete clears) get one.
            const resnapshotted = new Set<string>([
                ...agentMembers.map((row) => `agent:${row.memberId}`),
                ...links
                    .filter(
                        (link) =>
                            link.resourceType === 'task' ||
                            link.resourceType === 'idea' ||
                            link.resourceType === 'goal' ||
                            link.resourceType === 'mission',
                    )
                    .map((link) => `${link.resourceType}:${link.resourceId}`),
            ]);
            for (const record of affected) {
                await this.visibility?.recomputeAutomaticIn(em, record.aggregate, record.id, {
                    recordEvent: !resnapshotted.has(`${record.aggregate}:${record.id}`),
                });
            }
            for (const child of children) {
                await publisher.changed(em, 'team', child.id, 'team.updated', {
                    changedFields: ['parentTeamId'],
                    previous: { parentTeamId: teamId },
                });
            }
            for (const agentId of new Set(agentMembers.map((row) => row.memberId))) {
                await publisher.changed(em, 'agent', agentId, 'agent.updated', {
                    changedFields: ['teamIds'],
                });
            }
            for (const link of links) {
                if (
                    link.resourceType === 'task' ||
                    link.resourceType === 'work' ||
                    link.resourceType === 'idea' ||
                    link.resourceType === 'goal' ||
                    link.resourceType === 'mission'
                ) {
                    await publisher.changed(
                        em,
                        link.resourceType,
                        link.resourceId,
                        `${link.resourceType}.updated`,
                        { changedFields: ['teamIds'] },
                    );
                }
            }
        });
        await this.recomputeVisibilityOf(affected);
    }

    /** Record visibility (EW-P1-3): re-apply D11 to the records a Team change touched. */
    private async recomputeVisibilityOf(
        records: ReadonlyArray<{ aggregate: VisibilityAggregate; id: string }>,
    ): Promise<void> {
        for (const record of records) {
            await this.visibility?.recomputeAutomatic(record.aggregate, record.id);
        }
    }

    // ── Roster ──

    async listMembers(orgId: string, teamId: string): Promise<TeamMemberView[]> {
        await this.getOrThrow(orgId, teamId);
        const rows = await this.members.find({ where: { teamId }, order: { createdAt: 'ASC' } });
        return this.resolveMemberViews(rows);
    }

    /**
     * The org-internal people directory, for the Teams "add a human member"
     * picker.
     *
     * Membership in an Organization is expressed through its TENANT, not a
     * join table: `addMember` accepts a user when `user.tenantId` matches the
     * org, so the pickable set is exactly "users of this org's tenant". This
     * method returns that same set, which keeps the picker and the write path
     * from disagreeing — a directory that offers someone the API then refuses
     * is worse than no directory.
     *
     * Authorization is the CONTROLLER's job: this sits behind
     * `OrganizationOwnershipGuard`, which requires the caller to already be a
     * member of `orgId` and 404s (never 403s) otherwise, so the endpoint
     * cannot be used to probe which organizations exist.
     */
    async listOrgUsers(orgId: string): Promise<OrgUserView[]> {
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }
        if (!org.tenantId) {
            return [];
        }

        const rows = await this.users.find({
            where: {
                tenantId: org.tenantId,
                // Guests and deactivated accounts are in the Tenant but are not
                // people you can staff a team with. `addMember` only checks the
                // Tenant, so this filter is the only thing keeping them out of
                // the picker.
                isAnonymous: false,
                isActive: true,
            },
            // EXPLICIT select — never a bare find(). This crosses a trust
            // boundary (one user listing others) and `User` holds
            // `password`, `emailVerificationToken`, `passwordResetToken` and
            // `magicLinkToken`. An allowlist cannot leak a column added later.
            select: ['id', 'username', 'email', 'avatar'],
            order: { username: 'ASC' },
            take: ORG_USER_DIRECTORY_LIMIT,
        });

        return rows.map((user) => ({
            id: user.id,
            username: user.username,
            email: user.email ?? null,
            avatar: user.avatar ?? null,
        }));
    }

    async addMember(
        userId: string,
        orgId: string,
        teamId: string,
        input: AddTeamMemberInput,
    ): Promise<TeamMemberView> {
        await this.getOrThrow(orgId, teamId);
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }

        if (input.memberType === 'agent') {
            await this.assertAgentInOrg(org, input.memberId);
        } else {
            // Human member: must belong to the org's tenant (v1 that is the
            // tenant owner; the check stays correct once multi-member orgs land).
            const user = await this.users.findOne({ where: { id: input.memberId } });
            if (!user || (user.tenantId && user.tenantId !== org.tenantId)) {
                throw new NotFoundException(`User ${input.memberId} not found`);
            }
            if (!user.tenantId) {
                // A user with no tenant cannot belong to any organization yet.
                throw new NotFoundException(`User ${input.memberId} not found`);
            }
        }

        const row = this.members.create({
            teamId,
            memberType: input.memberType,
            memberId: input.memberId,
            role: input.role ?? 'member',
            addedById: userId,
            tenantId: org.tenantId,
            organizationId: org.id,
        });

        try {
            const saved = await this.withTeamEvent(
                (manager) => (manager ? manager.getRepository(TeamMember) : this.members).save(row),
                async (publisher, manager, member) => {
                    await publisher.child(
                        manager,
                        'team',
                        teamId,
                        'team.member.added',
                        {
                            teamId,
                            memberType: member.memberType,
                            memberId: member.memberId,
                            role: member.role,
                        },
                        { changedFields: ['members'] },
                    );
                    // An agent's team scope is its team memberships (`teamIds`).
                    if (member.memberType === 'agent') {
                        // Record visibility (EW-P1-3): the snapshot below carries the
                        // automatic team / organization change.
                        await this.visibility?.recomputeAutomaticIn(
                            manager,
                            'agent',
                            member.memberId,
                            { recordEvent: false },
                        );
                        await publisher.changed(
                            manager,
                            'agent',
                            member.memberId,
                            'agent.updated',
                            {
                                changedFields: ['teamIds'],
                            },
                        );
                    }
                },
            );
            if (input.memberType === 'agent') {
                await this.visibility?.recomputeAutomatic('agent', input.memberId);
            }
            const [view] = await this.resolveMemberViews([saved]);
            return view;
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                throw new ConflictException('Already a member of this team');
            }
            throw error;
        }
    }

    async removeMember(
        orgId: string,
        teamId: string,
        memberType: TeamMember['memberType'],
        memberId: string,
    ): Promise<void> {
        await this.getOrThrow(orgId, teamId);
        const existing = this.domainEvents
            ? await this.members.findOne({ where: { teamId, memberType, memberId } })
            : null;
        const result = await this.withTeamEvent(
            (manager) =>
                (manager ? manager.getRepository(TeamMember) : this.members).delete({
                    teamId,
                    memberType,
                    memberId,
                }),
            async (publisher, manager, deleted) => {
                if (!deleted.affected) return;
                await publisher.child(
                    manager,
                    'team',
                    teamId,
                    'team.member.removed',
                    {
                        teamId,
                        memberType,
                        memberId,
                        role: existing?.role ?? 'member',
                        deleted: true,
                    },
                    { changedFields: ['members'] },
                );
                if (memberType === 'agent') {
                    await this.visibility?.recomputeAutomaticIn(manager, 'agent', memberId, {
                        recordEvent: false,
                    });
                    await publisher.changed(manager, 'agent', memberId, 'agent.updated', {
                        changedFields: ['teamIds'],
                    });
                }
            },
        );
        if (!result.affected) {
            throw new NotFoundException('Team member not found');
        }
        if (memberType === 'agent') {
            await this.visibility?.recomputeAutomatic('agent', memberId);
        }
    }

    async childTeamIds(teamId: string): Promise<string[]> {
        const rows = await this.teams.find({ where: { parentTeamId: teamId }, select: ['id'] });
        return rows.map((r) => r.id);
    }

    // ── Validation helpers ──

    /**
     * Parent must exist in the same org, must not create a cycle (walking
     * up from the proposed parent must never reach `teamId`), and the
     * COMBINED depth — ancestors of the new parent plus the height of the
     * subtree being moved — must stay within TEAM_MAX_DEPTH (PR #1647
     * review: parent-chain depth alone let a deep subtree exceed the cap).
     * Ancestor lookups are org-filtered (defense-in-depth; parents are
     * same-org by construction at every write).
     */
    private async assertValidParent(
        orgId: string,
        teamId: string | null,
        parentTeamId: string,
    ): Promise<void> {
        if (teamId && parentTeamId === teamId) {
            throw new ConflictException('A team cannot be its own parent');
        }
        const parent = await this.teams.findOne({
            where: { id: parentTeamId, organizationId: orgId },
        });
        if (!parent) {
            throw new NotFoundException(`Team ${parentTeamId} not found`);
        }

        let depth = 1;
        let cursor: Team | null = parent;
        for (let i = 0; cursor && i < TEAM_HIERARCHY_WALK_LIMIT; i++) {
            if (teamId && cursor.id === teamId) {
                throw new ConflictException('Moving the team here would create a cycle');
            }
            if (!cursor.parentTeamId) {
                cursor = null;
                break;
            }
            cursor = await this.teams.findOne({
                where: { id: cursor.parentTeamId, organizationId: orgId },
            });
            depth++;
        }
        const subtreeHeight = teamId ? await this.subtreeHeight(orgId, teamId) : 1;
        if (cursor !== null || depth + subtreeHeight > TEAM_MAX_DEPTH) {
            throw new UnprocessableEntityException(
                `Team hierarchy exceeds the maximum depth of ${TEAM_MAX_DEPTH}`,
            );
        }
    }

    /** Height (in levels, >= 1) of the subtree rooted at `teamId`. BFS via the
     *  parentTeamId index, bounded by TEAM_MAX_DEPTH so it can never run away. */
    private async subtreeHeight(orgId: string, teamId: string): Promise<number> {
        let frontier = [teamId];
        let height = 1;
        while (frontier.length > 0 && height <= TEAM_MAX_DEPTH) {
            const children = await this.teams.find({
                where: { parentTeamId: In(frontier), organizationId: orgId },
                select: ['id'],
            });
            if (children.length === 0) break;
            frontier = children.map((c) => c.id);
            height++;
        }
        return height;
    }

    /**
     * The referenced Agent must belong to the same Tenant as the org (agents
     * are stamped with tenantId; org-stamp may be NULL for pre-Org agents —
     * tenant equality is the IDOR boundary that matters). An agent stamped
     * for a DIFFERENT org of the same tenant is rejected too (PR #1647
     * review): it belongs on that org's chart, not this one's.
     */
    private async assertAgentInOrg(org: Organization, agentId: string): Promise<Agent> {
        const agent = await this.agents.findOne({ where: { id: agentId } });
        if (!agent || (agent.tenantId && agent.tenantId !== org.tenantId)) {
            throw new NotFoundException(`Agent ${agentId} not found`);
        }
        if (agent.organizationId && agent.organizationId !== org.id) {
            throw new NotFoundException(`Agent ${agentId} not found`);
        }
        if (!agent.tenantId) {
            // Pre-backfill rows: fall back to owner equality via the org's
            // tenant owner is not resolvable here without another lookup, so
            // reject — the agents backfill runs on first Org creation, making
            // this branch practically unreachable.
            throw new NotFoundException(`Agent ${agentId} not found`);
        }
        return agent;
    }

    private normalizeSlug(raw: string): string {
        const slug = slugifyText(raw);
        if (!slug || slug === '-') {
            throw new UnprocessableEntityException('Team name does not produce a valid slug');
        }
        return slug.slice(0, 100);
    }

    /** Postgres 23505 / sqlite SQLITE_CONSTRAINT unique-violation detection. */
    private isUniqueViolation(error: unknown): boolean {
        const e = error as { code?: string; message?: string };
        return (
            e?.code === '23505' ||
            (typeof e?.message === 'string' && e.message.includes('UNIQUE constraint failed'))
        );
    }

    private async resolveMemberViews(rows: TeamMember[]): Promise<TeamMemberView[]> {
        const agentIds = rows.filter((r) => r.memberType === 'agent').map((r) => r.memberId);
        const userIds = rows.filter((r) => r.memberType === 'user').map((r) => r.memberId);
        const [agentRows, userRows] = await Promise.all([
            agentIds.length
                ? this.agents.find({ where: { id: In(agentIds) } })
                : Promise.resolve([]),
            userIds.length ? this.users.find({ where: { id: In(userIds) } }) : Promise.resolve([]),
        ]);
        const agentsById = new Map(agentRows.map((a) => [a.id, a]));
        const usersById = new Map(userRows.map((u) => [u.id, u]));
        return rows.map((r) => ({
            id: r.id,
            memberType: r.memberType,
            memberId: r.memberId,
            role: r.role,
            name:
                r.memberType === 'agent'
                    ? (agentsById.get(r.memberId)?.name ?? null)
                    : (usersById.get(r.memberId)?.username ?? null),
            title:
                r.memberType === 'agent' ? (agentsById.get(r.memberId)?.title ?? null) : undefined,
            createdAt: r.createdAt,
        }));
    }
}
