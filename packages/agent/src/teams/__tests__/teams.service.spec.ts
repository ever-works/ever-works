import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Organization } from '../../entities/organization.entity';
import type { Team } from '../../entities/team.entity';
import type { TeamMember } from '../../entities/team-member.entity';
import { OrgChartService } from '../org-chart.service';
import { TeamsService } from '../teams.service';

/**
 * Teams & Prebuilt Companies — TeamsService/OrgChartService unit specs
 * (spec §2/§3): slug + tenant/org stamping, cycle + depth guards, roster
 * IDOR validation, 404-not-403 posture, child re-parenting on delete.
 */

type RepoMock = {
    find: jest.Mock;
    findOne: jest.Mock;
    findByIds: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
};

function repoMock(): RepoMock {
    return {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([]),
        create: jest.fn((x: unknown) => x),
        save: jest.fn(async (x: object) => ({ id: 'team-new', ...x })),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
}

const ORG: Partial<Organization> = {
    id: 'org-1',
    tenantId: 'ten-1',
    slug: 'acme',
    displayName: 'Acme',
};

function makeTeam(overrides: Partial<Team> = {}): Team {
    return {
        id: 'team-1',
        userId: 'u1',
        name: 'Engineering',
        slug: 'engineering',
        description: null,
        parentTeamId: null,
        managerAgentId: null,
        avatarIcon: null,
        metadata: null,
        tenantId: 'ten-1',
        organizationId: 'org-1',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...overrides,
    } as Team;
}

function build() {
    const teams = repoMock();
    const members = repoMock();
    const agents = repoMock();
    const organizations = repoMock();
    const users = repoMock();
    organizations.findOne.mockResolvedValue(ORG);
    // remove() wraps re-parent + delete in a transaction; the mock hands the
    // same repo back so the assertions keep observing teams.update/delete.
    (teams as { manager?: unknown }).manager = {
        transaction: async (fn: (em: unknown) => Promise<unknown>) =>
            fn({ getRepository: () => teams }),
    };
    const service = new TeamsService(
        teams as unknown as Repository<Team>,
        members as unknown as Repository<TeamMember>,
        agents as never,
        organizations as never,
        users as never,
    );
    return { service, teams, members, agents, organizations, users };
}

describe('TeamsService', () => {
    describe('create', () => {
        it('derives the slug and stamps tenantId/organizationId from the org row', async () => {
            const { service, teams } = build();
            const created = await service.create('u1', 'org-1', { name: 'Growth Team' });
            expect(teams.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    name: 'Growth Team',
                    slug: 'growth-team',
                    tenantId: 'ten-1',
                    organizationId: 'org-1',
                }),
            );
            expect(created.id).toBe('team-new');
        });

        it('maps a unique violation to 409', async () => {
            const { service, teams } = build();
            teams.save.mockRejectedValue({ code: '23505' });
            await expect(service.create('u1', 'org-1', { name: 'Engineering' })).rejects.toThrow(
                ConflictException,
            );
        });

        it('404s when the org does not exist (guard posture)', async () => {
            const { service, organizations } = build();
            organizations.findOne.mockResolvedValue(null);
            await expect(service.create('u1', 'missing', { name: 'X' })).rejects.toThrow(
                NotFoundException,
            );
        });

        it('rejects a name that produces no slug', async () => {
            const { service } = build();
            await expect(service.create('u1', 'org-1', { name: '---' })).rejects.toThrow(
                UnprocessableEntityException,
            );
        });

        it('404s a parent team from another org (no existence leak)', async () => {
            const { service, teams } = build();
            teams.findOne.mockResolvedValue(null); // parent lookup is org-filtered
            await expect(
                service.create('u1', 'org-1', { name: 'Sub', parentTeamId: 'foreign-team' }),
            ).rejects.toThrow(NotFoundException);
            expect(teams.findOne).toHaveBeenCalledWith({
                where: { id: 'foreign-team', organizationId: 'org-1' },
            });
        });

        it('404s a manager agent from another tenant', async () => {
            const { service, agents } = build();
            agents.findOne.mockResolvedValue({ id: 'ag-x', tenantId: 'OTHER' });
            await expect(
                service.create('u1', 'org-1', { name: 'T', managerAgentId: 'ag-x' }),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('update / hierarchy guards', () => {
        it('rejects making a team its own parent', async () => {
            const { service, teams } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            await expect(
                service.update('org-1', 'team-1', { parentTeamId: 'team-1' }),
            ).rejects.toThrow(ConflictException);
        });

        it('rejects a re-parent that closes a cycle (child becomes parent)', async () => {
            const { service, teams } = build();
            const parent = makeTeam();
            const child = makeTeam({ id: 'team-2', slug: 'child', parentTeamId: 'team-1' });
            teams.findOne.mockImplementation(async ({ where }: { where: { id: string } }) =>
                where.id === 'team-1' ? parent : where.id === 'team-2' ? child : null,
            );
            await expect(
                service.update('org-1', 'team-1', { parentTeamId: 'team-2' }),
            ).rejects.toThrow(ConflictException);
        });
    });

    describe('remove', () => {
        it("re-parents children to the deleted team's parent before deleting", async () => {
            const { service, teams } = build();
            teams.findOne.mockResolvedValue(makeTeam({ parentTeamId: 'team-root' }));
            await service.remove('org-1', 'team-1');
            expect(teams.update).toHaveBeenCalledWith(
                { parentTeamId: 'team-1', organizationId: 'org-1' },
                { parentTeamId: 'team-root' },
            );
            expect(teams.delete).toHaveBeenCalledWith({ id: 'team-1' });
        });
    });

    describe('roster', () => {
        it('adds a same-tenant agent and stamps scope columns', async () => {
            const { service, teams, members, agents } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            agents.findOne.mockResolvedValue({
                id: 'ag-1',
                name: 'CEO',
                title: null,
                tenantId: 'ten-1',
            });
            agents.find.mockResolvedValue([{ id: 'ag-1', name: 'CEO', title: null }]);
            members.save.mockImplementation(async (x: object) => ({
                id: 'tm-1',
                createdAt: new Date(),
                ...x,
            }));
            const view = await service.addMember('u1', 'org-1', 'team-1', {
                memberType: 'agent',
                memberId: 'ag-1',
            });
            expect(members.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    teamId: 'team-1',
                    memberType: 'agent',
                    memberId: 'ag-1',
                    role: 'member',
                    tenantId: 'ten-1',
                    organizationId: 'org-1',
                }),
            );
            expect(view.name).toBe('CEO');
        });

        it('404s a cross-tenant agent (IDOR guard)', async () => {
            const { service, teams, agents } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            agents.findOne.mockResolvedValue({ id: 'ag-2', tenantId: 'OTHER' });
            await expect(
                service.addMember('u1', 'org-1', 'team-1', {
                    memberType: 'agent',
                    memberId: 'ag-2',
                }),
            ).rejects.toThrow(NotFoundException);
        });

        it('404s a cross-tenant user', async () => {
            const { service, teams, users } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            users.findOne.mockResolvedValue({ id: 'u9', tenantId: 'OTHER' });
            await expect(
                service.addMember('u1', 'org-1', 'team-1', { memberType: 'user', memberId: 'u9' }),
            ).rejects.toThrow(NotFoundException);
        });

        it('maps duplicate membership to 409', async () => {
            const { service, teams, agents, members } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            agents.findOne.mockResolvedValue({ id: 'ag-1', tenantId: 'ten-1' });
            members.save.mockRejectedValue({ message: 'UNIQUE constraint failed: team_members' });
            await expect(
                service.addMember('u1', 'org-1', 'team-1', {
                    memberType: 'agent',
                    memberId: 'ag-1',
                }),
            ).rejects.toThrow(ConflictException);
        });

        it('404s removal of a non-member', async () => {
            const { service, teams, members } = build();
            teams.findOne.mockResolvedValue(makeTeam());
            members.delete.mockResolvedValue({ affected: 0 });
            await expect(
                service.removeMember('org-1', 'team-1', 'agent', 'ag-nope'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    it('getOrThrow 404s a team of another org', async () => {
        const { service, teams } = build();
        teams.findOne.mockResolvedValue(null);
        await expect(service.getOrThrow('org-1', 'foreign')).rejects.toThrow(NotFoundException);
        expect(teams.findOne).toHaveBeenCalledWith({
            where: { id: 'foreign', organizationId: 'org-1' },
        });
    });
});

describe('OrgChartService', () => {
    it('builds the flat payload with teamIds projections and the tenant owner as member', async () => {
        const teams = repoMock();
        const members = repoMock();
        const agents = repoMock();
        const organizations = repoMock();
        const tenants = repoMock();
        const users = repoMock();
        organizations.findOne.mockResolvedValue(ORG);
        tenants.findOne.mockResolvedValue({ id: 'ten-1', ownerUserId: 'u1' });
        teams.find.mockResolvedValue([makeTeam()]);
        members.find.mockResolvedValue([
            { teamId: 'team-1', memberType: 'agent', memberId: 'ag-1' },
            { teamId: 'team-1', memberType: 'user', memberId: 'u1' },
        ]);
        // org-stamped agents + tenant-stamped org-less agents
        agents.find
            .mockResolvedValueOnce([
                {
                    id: 'ag-1',
                    name: 'CTO',
                    title: 'CTO',
                    status: 'active',
                    reportsToAgentId: 'ag-2',
                },
            ])
            .mockResolvedValueOnce([
                { id: 'ag-2', name: 'CEO', title: null, status: 'draft', reportsToAgentId: null },
            ]);
        users.find.mockResolvedValue([{ id: 'u1', username: 'ruslan' }]);

        const service = new OrgChartService(
            organizations as never,
            tenants as never,
            users as never,
            teams as never,
            members as never,
            agents as never,
        );
        const chart = await service.build('org-1');

        expect(chart.organization).toEqual({ id: 'org-1', slug: 'acme', displayName: 'Acme' });
        expect(chart.teams).toHaveLength(1);
        expect(chart.agents).toEqual([
            expect.objectContaining({ id: 'ag-1', reportsToAgentId: 'ag-2', teamIds: ['team-1'] }),
            expect.objectContaining({ id: 'ag-2', reportsToAgentId: null, teamIds: [] }),
        ]);
        expect(chart.members).toEqual([
            expect.objectContaining({ userId: 'u1', name: 'ruslan', teamIds: ['team-1'] }),
        ]);
    });
});
