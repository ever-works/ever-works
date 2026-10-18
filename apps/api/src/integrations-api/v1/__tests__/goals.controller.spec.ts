import {
    DuplicateExternalRefError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IntegrationGoalsController, IntegrationUpdateGoalDto } from '../goals.controller';

/**
 * Goals of `/api/integrations/v1` (EW-P2-2): creates go through `createExternal`
 * (draft, external source by default), PATCH never carries a status, If-Match,
 * criteria / Definition of Done sets, external samples and the delete guard — over
 * doubles of the domain services.
 */
describe('IntegrationGoalsController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['goals:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = (key: string | undefined = 'idem-1') => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/goals',
        body: {},
        headers: key ? { 'idempotency-key': key } : {},
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = (loopStatus: string | null = null) => {
        const goals = {
            // As GoalsService.createExternal: `withinCreate` runs in the create's transaction
            // (T17a pattern), and its throw rolls the Goal back.
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
                        await options.withinCreate({ id: 'goal-1' }, 'tx-manager');
                    return { id: 'goal-1' };
                },
            ),
            update: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({ deleted: true }),
            getForUser: jest.fn().mockResolvedValue({ id: 'goal-1' }),
            recordExternalSample: jest.fn().mockResolvedValue({}),
        };
        const orchestrator = { setDodCriteria: jest.fn().mockResolvedValue({}) };
        const visibility = {
            setTeams: jest.fn().mockResolvedValue({}),
            setVisibility: jest.fn().mockResolvedValue({}),
        };
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
            list: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 4, loop: { status: loopStatus, iteration: 0, spentCents: 0 } },
                etag: '"4"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationGoalsController(
            goals as never,
            orchestrator as never,
            visibility as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, goals, orchestrator, visibility, links, resources };
    };

    it('creates a metric Goal on the external source by default, attributed to the key', async () => {
        const { controller, goals } = setup();
        const response = res();
        await controller.create(
            user,
            { title: 'Grow', comparator: 'gte', targetValue: 120, unit: 'customers' },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(goals.createExternal).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: 'Grow',
                goalKind: 'metric',
                metricSource: { pluginId: 'external', metricId: 'value' },
                window: 'point',
                createdBy: { type: 'integration', id: 'key-1' },
            }),
            { tenantId: 'tenant-1', organizationId: ORG },
            {},
        );
        expect(response.status).toHaveBeenCalledWith(201);
    });

    it('creates the Goal and its externalRef link in one transaction (T17a pattern)', async () => {
        const { controller, goals, links } = setup();
        const response = res();
        await controller.create(
            user,
            {
                ...{ title: 'Grow', comparator: 'gte', targetValue: 120, unit: 'customers' },
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            } as never,
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(goals.createExternal).toHaveBeenCalledWith(
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
            expect.objectContaining({ entityType: 'goal', entityId: 'goal-1', externalId: 'g-1' }),
            'tx-manager',
        );
        expect(response.status).toHaveBeenCalledWith(201);
    });

    it('a lost externalRef race rolls the create back (nothing to undo) and answers the winner', async () => {
        const { controller, goals, links } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'goal-w' });
        links.create.mockRejectedValue(new DuplicateExternalRefError('external', 'goal-w', 'g-1'));
        const response = res();
        const body = await controller.create(
            user,
            {
                ...{ title: 'Grow', comparator: 'gte', targetValue: 120, unit: 'customers' },
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            } as never,
            undefined,
            req(),
            response,
        );
        expect(goals.delete).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'goal-w' });
    });

    it('refuses a provider metric source (422) before creating anything', async () => {
        const { controller, goals } = setup();
        await expect(
            controller.create(
                user,
                {
                    title: 'Income',
                    metricSource: { pluginId: 'stripe', metricId: 'income' },
                    comparator: 'gte',
                    targetValue: 1,
                    unit: 'USD',
                },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
        expect(goals.createExternal).not.toHaveBeenCalled();
    });

    it('PATCH passes only content fields, teams and visibility; 412 on a stale If-Match', async () => {
        const { controller, goals, visibility } = setup();
        await controller.update(
            user,
            'goal-1',
            { targetValue: 150, deadline: null, teamIds: ['team-a'] },
            '"4"',
            res(),
        );
        expect(goals.update).toHaveBeenCalledWith(
            'owner-1',
            'goal-1',
            { targetValue: 150, deadline: null },
            expect.anything(),
        );
        expect(visibility.setTeams).toHaveBeenCalledWith('goal', 'goal-1', ['team-a'], 'owner-1');
        await expect(
            controller.update(user, 'goal-1', { title: 'x' }, '"3"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
    });

    it('PUT criteria refuses a provider source; PUT dod writes approved operator items', async () => {
        const { controller, goals, orchestrator } = setup();
        await expect(
            controller.putCriteria(
                user,
                'goal-1',
                {
                    criteria: [
                        {
                            id: 'kr',
                            name: 'Revenue',
                            weight: 1,
                            target: 10,
                            direction: 'gte',
                            metricSource: { pluginId: 'stripe', metricId: 'income' },
                        },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
        expect(goals.update).not.toHaveBeenCalled();

        await controller.putDod(
            user,
            'goal-1',
            { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).toHaveBeenCalledWith('owner-1', 'goal-1', [
            { id: 'kr-launch', text: 'Launched', status: 'done', evidence: null, note: null },
        ]);
    });

    it('PUT criteria refuses a criterion that inherits the Goal provider source (D9)', async () => {
        const { controller, goals } = setup();
        goals.getForUser.mockResolvedValue({
            id: 'goal-1',
            metricSource: { pluginId: 'stripe', metricId: 'income' },
        });
        await expect(
            controller.putCriteria(
                user,
                'goal-1',
                {
                    criteria: [
                        { id: 'kr', name: 'Revenue', weight: 1, target: 10, direction: 'gte' },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({ status: 422 });
        expect(goals.update).not.toHaveBeenCalled();
    });

    it('PATCH checks every Team before it writes anything', async () => {
        const { controller, goals, visibility, resources } = setup();
        resources.get.mockImplementation(async (kind: string, _org: string, id: string) => {
            if (kind === 'team') throw Object.assign(new Error('Not found'), { status: 404 });
            return { dto: { id, version: 1 } } as never;
        });
        await expect(
            controller.update(
                user,
                'goal-1',
                { title: 'Renamed', teamIds: ['foreign-team'] } as never,
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({ status: 404 });
        expect(goals.update).not.toHaveBeenCalled();
        expect(visibility.setTeams).not.toHaveBeenCalled();
    });

    it('PUT dod keeps the planner proposals it does not name (Gauzy CR-12)', async () => {
        const { controller, goals, orchestrator } = setup();
        const proposal = {
            id: 'dod-proposed',
            text: 'Docs published',
            status: 'open',
            evidence: null,
            note: null,
            source: 'planner',
            proposed: true,
        };
        goals.getForUser.mockResolvedValue({
            id: 'goal-1',
            dodCriteria: [
                { id: 'kr-launch', text: 'Launched', status: 'open', source: 'operator' },
                proposal,
            ],
        });
        await controller.putDod(
            user,
            'goal-1',
            { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).toHaveBeenCalledWith('owner-1', 'goal-1', [
            { id: 'kr-launch', text: 'Launched', status: 'done', evidence: null, note: null },
            proposal,
        ]);
    });

    it('a sample is recorded through recordExternalSample and answers the Goal', async () => {
        const { controller, goals } = setup();
        const response = res();
        const body = await controller.sample(
            user,
            'goal-1',
            { criterionId: 'kr-signups', value: 30, sampledAt: '2026-10-16T11:00:00.000Z' },
            req(),
            response,
        );
        expect(goals.recordExternalSample).toHaveBeenCalledWith(
            'owner-1',
            'goal-1',
            {
                criterionId: 'kr-signups',
                value: 30,
                sampledAt: new Date('2026-10-16T11:00:00.000Z'),
            },
            expect.anything(),
        );
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'goal-1' });
    });

    it('DELETE refuses a Goal whose loop is running (422) and removes the links otherwise', async () => {
        const running = setup('running');
        await expect(running.controller.remove(user, 'goal-1', undefined)).rejects.toMatchObject({
            status: 422,
        });
        expect(running.goals.delete).not.toHaveBeenCalled();

        const idle = setup(null);
        await idle.controller.remove(user, 'goal-1', '"4"');
        expect(idle.goals.delete).toHaveBeenCalledWith('owner-1', 'goal-1', expect.anything());
        expect(idle.links.removeAllFor).toHaveBeenCalledWith(ORG, 'goal', 'goal-1');
    });
});

// Review 2026-10-17 F39: `null` only where the contract allows it (else 400 validation_failed,
// not a NOT NULL write or a `.trim()` on null answering 500).
describe('IntegrationUpdateGoalDto null fields', () => {
    const properties = async (body: Record<string, unknown>) =>
        (await validate(plainToInstance(IntegrationUpdateGoalDto, body))).map(
            (error) => error.property,
        );

    it('refuses null on the fields the contract does not make nullable', async () => {
        for (const field of [
            'title',
            'comparator',
            'targetValue',
            'unit',
            'window',
            'teamIds',
            'visibility',
        ]) {
            expect(await properties({ [field]: null })).toContain(field);
        }
    });

    it('still takes null on the nullable ones, and never validates an absent field', async () => {
        for (const field of ['description', 'baselineValue', 'deadline']) {
            expect(await properties({ [field]: null })).not.toContain(field);
        }
        expect(await properties({})).toEqual([]);
    });
});
