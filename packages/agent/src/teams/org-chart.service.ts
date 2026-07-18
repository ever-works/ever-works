import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { Organization } from '../entities/organization.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import { OrgChartPayload } from './types';

/**
 * Teams & Prebuilt Companies — flat Org Chart payload
 * (`docs/specs/features/teams-and-companies/spec.md` §5).
 *
 * The server stays flat (teams + agents + members with parent/reportsTo
 * edges and teamIds projections); the tree layout is a pure client-side
 * function. Runs behind `OrganizationOwnershipGuard`.
 */
@Injectable()
export class OrgChartService {
    constructor(
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(Tenant)
        private readonly tenants: Repository<Tenant>,
        @InjectRepository(User)
        private readonly users: Repository<User>,
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(TeamMember)
        private readonly members: Repository<TeamMember>,
        @InjectRepository(Agent)
        private readonly agents: Repository<Agent>,
    ) {}

    async build(orgId: string): Promise<OrgChartPayload> {
        const org = await this.organizations.findOne({ where: { id: orgId } });
        if (!org) {
            throw new NotFoundException(`Organization ${orgId} not found`);
        }

        const [teams, memberRows, orgAgents, tenantAgents] = await Promise.all([
            this.teams.find({ where: { organizationId: orgId }, order: { name: 'ASC' } }),
            this.members.find({ where: { organizationId: orgId } }),
            this.agents.find({ where: { organizationId: orgId } }),
            // Agents stamped with the tenant but not (yet) with any Org —
            // pre-Org rows and tenant-wide agents. Shown so the chart never
            // hides an agent the user expects to organize (spec §5); once an
            // agent is org-stamped elsewhere it appears only in that org.
            org.tenantId
                ? this.agents.find({ where: { tenantId: org.tenantId, organizationId: IsNull() } })
                : Promise.resolve([]),
        ]);

        const agentRows = [...orgAgents, ...tenantAgents];
        const teamIdsByAgent = new Map<string, string[]>();
        const teamIdsByUser = new Map<string, string[]>();
        for (const m of memberRows) {
            const bucket = m.memberType === 'agent' ? teamIdsByAgent : teamIdsByUser;
            const list = bucket.get(m.memberId) ?? [];
            list.push(m.teamId);
            bucket.set(m.memberId, list);
        }

        // Humans: the tenant owner (v1's only guaranteed member) + everyone
        // on a roster. Deduped by user id.
        const humanIds = new Set<string>(teamIdsByUser.keys());
        if (org.tenantId) {
            const tenant = await this.tenants.findOne({ where: { id: org.tenantId } });
            if (tenant?.ownerUserId) {
                humanIds.add(tenant.ownerUserId);
            }
        }
        const humans = humanIds.size
            ? await this.users.find({ where: { id: In([...humanIds]) } })
            : [];

        return {
            organization: { id: org.id, slug: org.slug, displayName: org.displayName },
            teams: teams.map((t) => ({
                id: t.id,
                slug: t.slug,
                name: t.name,
                avatarIcon: t.avatarIcon ?? null,
                parentTeamId: t.parentTeamId ?? null,
                managerAgentId: t.managerAgentId ?? null,
            })),
            agents: agentRows.map((a) => ({
                id: a.id,
                name: a.name,
                title: a.title ?? null,
                status: a.status,
                avatarIcon: a.avatarIcon ?? null,
                reportsToAgentId: a.reportsToAgentId ?? null,
                teamIds: teamIdsByAgent.get(a.id) ?? [],
            })),
            members: humans.map((u) => ({
                userId: u.id,
                name: u.username ?? null,
                avatarUrl: u.avatar ?? null,
                teamIds: teamIdsByUser.get(u.id) ?? [],
            })),
        };
    }
}
