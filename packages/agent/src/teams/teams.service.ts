import {
    ConflictException,
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { User } from '../entities/user.entity';
import { slugifyText } from '../utils/text.utils';
import {
    AddTeamMemberInput,
    CreateTeamInput,
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
    ) {}

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

    async create(userId: string, orgId: string, input: CreateTeamInput): Promise<Team> {
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
            return await this.teams.save(team);
        } catch (error) {
            if (this.isUniqueViolation(error)) {
                throw new ConflictException(`A team with slug "${slug}" already exists in this organization`);
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

        if (input.name !== undefined) team.name = input.name.trim();
        if (input.description !== undefined) team.description = input.description;
        if (input.parentTeamId !== undefined) team.parentTeamId = input.parentTeamId;
        if (input.managerAgentId !== undefined) team.managerAgentId = input.managerAgentId;
        if (input.avatarIcon !== undefined) team.avatarIcon = input.avatarIcon;

        return this.teams.save(team);
    }

    /**
     * Delete a team. Children are re-parented to the deleted team's parent
     * (never deleted with it — spec §3); roster rows cascade at the DB level.
     * Re-parent + delete run in ONE transaction so a mid-flight failure can't
     * leave children pointing at a deleted parent (PR #1647 review).
     */
    async remove(orgId: string, teamId: string): Promise<void> {
        const team = await this.getOrThrow(orgId, teamId);
        await this.teams.manager.transaction(async (em) => {
            await em.getRepository(Team).update(
                { parentTeamId: teamId, organizationId: orgId },
                { parentTeamId: team.parentTeamId ?? null },
            );
            await em.getRepository(Team).delete({ id: teamId });
        });
    }

    // ── Roster ──

    async listMembers(orgId: string, teamId: string): Promise<TeamMemberView[]> {
        await this.getOrThrow(orgId, teamId);
        const rows = await this.members.find({ where: { teamId }, order: { createdAt: 'ASC' } });
        return this.resolveMemberViews(rows);
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
            const saved = await this.members.save(row);
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
        const result = await this.members.delete({ teamId, memberType, memberId });
        if (!result.affected) {
            throw new NotFoundException('Team member not found');
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
            agentIds.length ? this.agents.find({ where: { id: In(agentIds) } }) : Promise.resolve([]),
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
            title: r.memberType === 'agent' ? (agentsById.get(r.memberId)?.title ?? null) : undefined,
            createdAt: r.createdAt,
        }));
    }
}
