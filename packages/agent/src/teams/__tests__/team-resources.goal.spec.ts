import { NotFoundException } from '@nestjs/common';
import { TeamResourcesService } from '../team-resources.service';

/**
 * `team_resources` type `goal` (EW-P1-3): Goals sit on Teams like every other
 * resource, so the goal form can show and edit a Goal's Teams and the access policy
 * can treat a Goal on a Team as team-scoped.
 */
describe('TeamResourcesService — goal resources (EW-P1-3)', () => {
    const org = { id: 'org-1', tenantId: 'tenant-1' };
    const team = { id: 'team-1', organizationId: 'org-1', tenantId: 'tenant-1' };

    function repo(rows: Array<Record<string, unknown>> = []) {
        return {
            findOne: jest.fn(
                async ({ where }: { where: Record<string, unknown> }) =>
                    rows.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ??
                    null,
            ),
            find: jest.fn(async () => rows),
            create: jest.fn((value: Record<string, unknown>) => ({ id: 'tr-1', ...value })),
            save: jest.fn(async (value: Record<string, unknown>) => value),
            delete: jest.fn(async () => ({ affected: 1 })),
        };
    }

    function build(
        goals: Array<Record<string, unknown>>,
        resources = repo(),
        visibility?: { recomputeAutomatic: jest.Mock },
    ) {
        const service = new TeamResourcesService(
            resources as never,
            repo([team]) as never,
            repo([org]) as never,
            repo() as never,
            repo() as never,
            repo() as never,
            repo() as never,
            repo() as never,
            undefined, // domain-event publisher (EW-P1-1 B2)
            repo(goals) as never,
            visibility as never,
        );
        return { service, resources };
    }

    it('attaches a Goal of the same org and resolves its title', async () => {
        const { service } = build([
            { id: 'goal-1', title: 'Grow MRR', tenantId: 'tenant-1', organizationId: 'org-1' },
        ]);
        const item = await service.attach('user-1', 'org-1', 'team-1', {
            resourceType: 'goal',
            resourceId: 'goal-1',
        });
        expect(item).toEqual(
            expect.objectContaining({
                resourceType: 'goal',
                resourceId: 'goal-1',
                name: 'Grow MRR',
            }),
        );
    });

    it('refuses a Goal of another org (404, the EW-711 IDOR posture)', async () => {
        const { service } = build([
            { id: 'goal-2', title: 'Theirs', tenantId: 'tenant-1', organizationId: 'org-2' },
        ]);
        await expect(
            service.attach('user-1', 'org-1', 'team-1', {
                resourceType: 'goal',
                resourceId: 'goal-2',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lists a Team’s Goals in their own group', async () => {
        const resources = repo([
            {
                id: 'tr-1',
                teamId: 'team-1',
                resourceType: 'goal',
                resourceId: 'goal-1',
                addedById: 'user-1',
                createdAt: new Date('2026-10-16T00:00:00Z'),
            },
        ]);
        const { service } = build(
            [{ id: 'goal-1', title: 'Grow MRR', tenantId: 'tenant-1', organizationId: 'org-1' }],
            resources,
        );
        const grouped = await service.listForTeam('org-1', 'team-1');
        expect(Object.keys(grouped)).toEqual(['work', 'task', 'agent', 'mission', 'idea', 'goal']);
        expect(grouped.goal).toEqual([
            expect.objectContaining({ resourceId: 'goal-1', name: 'Grow MRR', slug: null }),
        ]);
    });

    it('re-applies automatic visibility after an attach and a detach (EW-P1-3)', async () => {
        const visibility = { recomputeAutomatic: jest.fn().mockResolvedValue(undefined) };
        const { service } = build(
            [{ id: 'goal-1', title: 'Grow MRR', tenantId: 'tenant-1', organizationId: 'org-1' }],
            repo(),
            visibility,
        );
        await service.attach('user-1', 'org-1', 'team-1', {
            resourceType: 'goal',
            resourceId: 'goal-1',
        });
        await service.detach('org-1', 'team-1', 'goal', 'goal-1');
        expect(visibility.recomputeAutomatic.mock.calls).toEqual([
            ['goal', 'goal-1'],
            ['goal', 'goal-1'],
        ]);
    });
});
