import { DuplicateExternalRefError } from '@ever-works/agent/integrations-api';
// The `@ever-works/agent/missions` barrel pulls in the whole agent graph (work module ->
// subscriptions -> api notifications/auth -> ESM-only better-auth, website-generator
// config), which this jest environment cannot load. The controller only needs these
// classes as DI tokens and the spec hands it fakes: stub the barrel, as the other api
// specs do.
jest.mock('@ever-works/agent/missions', () => ({
    MissionsService: class MissionsService {},
}));

import { IntegrationMissionsController } from '../missions.controller';

/**
 * Missions of `/api/integrations/v1` (EW-P2-5): creates go through
 * `createExternal` (paused), PATCH can pause / complete but never set active,
 * the Goal and Work link sets — over doubles of the domain services.
 */
describe('IntegrationMissionsController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['missions:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/missions',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = (
        status = 'paused',
        goals: Array<{ goalId: string; isPrimary: boolean }> = [],
    ) => {
        const missions = {
            // As MissionsService.createExternal: `withinCreate` runs in the create's transaction
            // (T17a pattern), and its throw rolls the Mission back.
            createExternal: jest.fn(
                async (
                    _userId: string,
                    _input: unknown,
                    _scope: unknown,
                    options?: {
                        withinCreate?: (row: { id: string }, manager: unknown) => Promise<void>;
                    },
                ) => {
                    if (options?.withinCreate)
                        await options.withinCreate({ id: 'mission-1' }, 'tx-manager');
                    return { id: 'mission-1' };
                },
            ),
            update: jest.fn().mockResolvedValue({}),
            pause: jest.fn().mockResolvedValue({}),
            complete: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({ deleted: true }),
            getForUser: jest.fn().mockResolvedValue({ id: 'mission-1' }),
            setWorks: jest.fn().mockResolvedValue([]),
        };
        const goalService = {
            linkToMission: jest.fn().mockResolvedValue({}),
            unlinkFromMission: jest.fn().mockResolvedValue({ deleted: true }),
            // The links whose Goal is visible in scope (PUT goals builds its diff from it).
            listForMission: jest.fn().mockResolvedValue(goals),
            getForUser: jest.fn(async (_user: string, goalId: string) => ({ id: goalId })),
        };
        const visibility = { setTeams: jest.fn(), setVisibility: jest.fn() };
        const links = {
            findByExternal: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            removeAllFor: jest.fn().mockResolvedValue(1),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({ ...(await work()), replayed: false }),
            ),
        };
        const resources = {
            list: jest.fn(),
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 2, status, goals },
                etag: '"2"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationMissionsController(
            missions as never,
            goalService as never,
            visibility as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, missions, goalService, links };
    };

    it('creates through createExternal (paused) attributed to the key', async () => {
        const { controller, missions } = setup();
        const response = res();
        await controller.create(
            user,
            { title: 'Win SMB', description: 'From Gauzy.' },
            undefined,
            req(),
            response,
        );
        expect(missions.createExternal).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: 'Win SMB',
                createdBy: { type: 'integration', id: 'key-1' },
            }),
            { tenantId: 'tenant-1', organizationId: ORG },
            {},
        );
        expect(response.status).toHaveBeenCalledWith(201);
    });

    it('creates the Mission and its externalRef link in one transaction (T17a pattern)', async () => {
        const { controller, missions, links } = setup();
        const response = res();
        await controller.create(
            user,
            {
                ...{ title: 'Win SMB', description: 'From Gauzy.' },
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            } as never,
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(missions.createExternal).toHaveBeenCalledWith(
            'owner-1',
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
            }),
            expect.objectContaining({
                entityType: 'mission',
                entityId: 'mission-1',
                externalId: 'g-1',
            }),
            'tx-manager',
        );
        expect(response.status).toHaveBeenCalledWith(201);
    });

    it('a lost externalRef race rolls the create back (nothing to undo) and answers the winner', async () => {
        const { controller, missions, links } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'mission-w' });
        links.create.mockRejectedValue(
            new DuplicateExternalRefError('external', 'mission-w', 'g-1'),
        );
        const response = res();
        const body = await controller.create(
            user,
            {
                ...{ title: 'Win SMB', description: 'From Gauzy.' },
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            } as never,
            undefined,
            req(),
            response,
        );
        expect(missions.delete).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'mission-w' });
    });

    it('PATCH never sets a Mission active (422) and refuses an outcome without completing', async () => {
        const { controller, missions } = setup('paused');
        await expect(
            controller.update(user, 'mission-1', { status: 'active' }, undefined, res()),
        ).rejects.toMatchObject({ status: 422 });
        await expect(
            controller.update(user, 'mission-1', { outcome: 'cancelled' }, undefined, res()),
        ).rejects.toMatchObject({ status: 400 });
        expect(missions.pause).not.toHaveBeenCalled();
        expect(missions.complete).not.toHaveBeenCalled();
    });

    it('PATCH pauses an active Mission and completes a paused one with its outcome', async () => {
        const active = setup('active');
        await active.controller.update(user, 'mission-1', { status: 'paused' }, '"2"', res());
        expect(active.missions.pause).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            expect.anything(),
        );

        const paused = setup('paused');
        await paused.controller.update(
            user,
            'mission-1',
            { status: 'completed', outcome: 'cancelled' },
            undefined,
            res(),
        );
        expect(paused.missions.complete).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            'cancelled',
            expect.anything(),
        );
        // Already there: a no-op.
        await paused.controller.update(user, 'mission-1', { status: 'paused' }, undefined, res());
        expect(paused.missions.pause).not.toHaveBeenCalled();
    });

    it('PUT goals unlinks the missing, links the new (demotions before the primary), at most one primary', async () => {
        const { controller, goalService } = setup('paused', [
            { goalId: 'goal-old', isPrimary: true },
            { goalId: 'goal-keep', isPrimary: false },
        ]);
        await controller.putGoals(
            user,
            'mission-1',
            {
                goals: [
                    { goalId: 'goal-keep', isPrimary: false },
                    { goalId: 'goal-new', isPrimary: true },
                ],
            },
            undefined,
            res(),
        );
        expect(goalService.unlinkFromMission).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            'goal-old',
            expect.anything(),
        );
        expect(goalService.linkToMission).toHaveBeenCalledTimes(1);
        expect(goalService.linkToMission).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            'goal-new',
            true,
            expect.anything(),
        );
        await expect(
            controller.putGoals(
                user,
                'mission-1',
                {
                    goals: [
                        { goalId: 'a', isPrimary: true },
                        { goalId: 'b', isPrimary: true },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
    });

    it('PUT goals 404s on a foreign Goal before it unlinks or links anything', async () => {
        const { controller, goalService } = setup('paused', [
            { goalId: 'goal-old', isPrimary: true },
        ]);
        goalService.getForUser.mockImplementation(async (_user: string, goalId: string) => {
            if (goalId === 'goal-foreign') {
                throw Object.assign(new Error('Goal not found'), { status: 404 });
            }
            return { id: goalId };
        });
        await expect(
            controller.putGoals(
                user,
                'mission-1',
                { goals: [{ goalId: 'goal-foreign', isPrimary: true }] },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({ status: 404 });
        expect(goalService.unlinkFromMission).not.toHaveBeenCalled();
        expect(goalService.linkToMission).not.toHaveBeenCalled();
    });

    it('PATCH fails an active Mission through fail()', async () => {
        const { controller, missions } = setup('active');
        (missions as unknown as { fail: jest.Mock }).fail = jest.fn().mockResolvedValue({});
        await controller.update(user, 'mission-1', { status: 'failed' }, undefined, res());
        expect((missions as unknown as { fail: jest.Mock }).fail).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            expect.anything(),
        );
    });

    it('PUT works delegates the full set to setWorks', async () => {
        const { controller, missions } = setup();
        await controller.putWorks(
            user,
            'mission-1',
            { works: [{ workId: 'work-1', relation: 'improves' }] },
            undefined,
            res(),
        );
        expect(missions.setWorks).toHaveBeenCalledWith(
            'owner-1',
            'mission-1',
            [{ workId: 'work-1', relation: 'improves' }],
            expect.anything(),
        );
    });
});
