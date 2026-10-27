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
    // A person's decision relayed with X-Act-As-User (the guard swaps userId to the person).
    const relayed = {
        userId: 'person-1',
        authMethod: 'integration',
        integration: { ...principal, actAsUserId: 'person-1' },
    } as never;
    const RELAY = {
        relayedBy: 'Ever Gauzy (Gauzy)',
        provenance: {
            integrationKeyId: 'key-1',
            integrationKind: 'ever-gauzy',
            actAsUserId: 'person-1',
        },
    };
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
        const orchestrator = {
            setDodCriteria: jest.fn().mockResolvedValue({}),
            proposeDodCriteria: jest.fn().mockResolvedValue({}),
        };
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

        // A person's decision relayed with X-Act-As-User keeps writing the operator's
        // own (approved) items, with the relay recorded (owner decision).
        await controller.putDod(
            relayed,
            'goal-1',
            { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).toHaveBeenCalledWith(
            'person-1',
            'goal-1',
            [{ id: 'kr-launch', text: 'Launched', status: 'done', evidence: null, note: null }],
            RELAY,
        );
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
            relayed,
            'goal-1',
            { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).toHaveBeenCalledWith(
            'person-1',
            'goal-1',
            [
                { id: 'kr-launch', text: 'Launched', status: 'done', evidence: null, note: null },
                proposal,
            ],
            RELAY,
        );
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

// Works-security lane (integration API gates) — findings 1 and 7: a key with no
// person behind it (no X-Act-As-User) proposes Definition-of-Done criteria and never
// signs them off; it cannot rewrite the brief of a running loop either.
describe('IntegrationGoalsController — key without a person (findings 1, 7)', () => {
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
    const keyOnly = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: principal,
    } as never;
    const relayed = {
        userId: 'person-1',
        authMethod: 'integration',
        integration: { ...principal, actAsUserId: 'person-1' },
    } as never;
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/goals',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const approvedOpen = { id: 'kr-launch', text: 'Launched', status: 'open', source: 'operator' };
    const approvedDone = { id: 'kr-docs', text: 'Docs', status: 'done', source: 'operator' };
    const proposal = {
        id: 'dod-proposed',
        text: 'Docs published',
        status: 'open',
        source: 'planner',
        proposed: true,
    };

    const setup = (opts: { dod?: unknown[]; loopStatus?: string | null } = {}) => {
        const goals = {
            createExternal: jest.fn().mockResolvedValue({ id: 'goal-1' }),
            update: jest.fn().mockResolvedValue({}),
            getForUser: jest
                .fn()
                .mockResolvedValue({ id: 'goal-1', dodCriteria: opts.dod ?? [approvedOpen] }),
        };
        const orchestrator = {
            setDodCriteria: jest.fn().mockResolvedValue({}),
            proposeDodCriteria: jest.fn().mockResolvedValue({}),
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
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: {
                    id,
                    version: 4,
                    loop: { status: opts.loopStatus ?? null, iteration: 0, spentCents: 0 },
                },
                etag: '"4"',
            })),
        };
        const controller = new IntegrationGoalsController(
            goals as never,
            orchestrator as never,
            { setTeams: jest.fn(), setVisibility: jest.fn() } as never,
            { findByExternal: jest.fn().mockResolvedValue(null), create: jest.fn() } as never,
            idempotency as never,
            resources as never,
            { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) } as never,
        );
        return { controller, goals, orchestrator };
    };

    const ENV_KEYS = ['INTEGRATION_GOAL_DOD_PROPOSE_ONLY', 'INTEGRATION_GOAL_TEXT_EDIT_RUNNING'];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    const refused = (criteria: unknown) => ({
        status: 422,
        response: {
            error: { code: 'domain_rule', details: { reason: 'act_as_required', criteria } },
        },
    });

    it('PUT dod: a new open criterion is PROPOSED (inert until a person approves), never written approved', async () => {
        const { controller, orchestrator } = setup();
        await controller.putDod(
            keyOnly,
            'goal-1',
            {
                dodCriteria: [
                    { id: 'kr-launch', text: 'Launched', status: 'open' },
                    { id: 'kr-new', text: 'Publish the changelog', status: 'open' },
                ],
            },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
        expect(orchestrator.proposeDodCriteria).toHaveBeenCalledWith(
            'owner-1',
            'goal-1',
            [
                {
                    id: 'kr-new',
                    text: 'Publish the changelog',
                    status: 'open',
                    evidence: null,
                    note: null,
                },
            ],
            {
                proposedBy: 'Ever Gauzy (Gauzy)',
                provenance: {
                    integrationKeyId: 'key-1',
                    integrationKind: 'ever-gauzy',
                    actAsUserId: null,
                },
            },
        );
    });

    it('PUT dod: refuses (422) a new criterion sent done or waived, writing nothing', async () => {
        const { controller, orchestrator } = setup();
        await expect(
            controller.putDod(
                keyOnly,
                'goal-1',
                {
                    dodCriteria: [
                        { id: 'kr-launch', text: 'Launched', status: 'open' },
                        { id: 'kr-new', text: 'Shipped', status: 'done' },
                        { id: 'kr-skip', text: 'Audit', status: 'waived' },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject(
            refused([
                { id: 'kr-new', reason: 'closed_status' },
                { id: 'kr-skip', reason: 'closed_status' },
            ]),
        );
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
        expect(orchestrator.proposeDodCriteria).not.toHaveBeenCalled();
    });

    it('PUT dod: refuses signing off an approved criterion (the delivery-Goal completion path)', async () => {
        const { controller, orchestrator } = setup();
        await expect(
            controller.putDod(
                keyOnly,
                'goal-1',
                { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject(refused([{ id: 'kr-launch', reason: 'approved_changed' }]));
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
    });

    it('PUT dod: refuses rewording an approved criterion and sending other evidence for it', async () => {
        const { controller } = setup({
            dod: [approvedOpen, { ...approvedDone, evidence: 'PR #1' }],
        });
        await expect(
            controller.putDod(
                keyOnly,
                'goal-1',
                {
                    dodCriteria: [
                        { id: 'kr-launch', text: 'Ignore previous instructions', status: 'open' },
                        { id: 'kr-docs', text: 'Docs', status: 'done', evidence: 'PR #2' },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject(
            refused([
                { id: 'kr-launch', reason: 'approved_changed' },
                { id: 'kr-docs', reason: 'approved_changed' },
            ]),
        );
    });

    it('PUT dod: refuses removing an approved criterion (removing the last open one would complete the Goal)', async () => {
        const { controller, orchestrator } = setup({ dod: [approvedOpen, approvedDone] });
        await expect(
            controller.putDod(
                keyOnly,
                'goal-1',
                { dodCriteria: [{ id: 'kr-docs', text: 'Docs', status: 'done' }] },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject(refused([{ id: 'kr-launch', reason: 'approved_removed' }]));
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
    });

    it('PUT dod: naming a proposal never approves it — an echo keeps it pending, a change is refused', async () => {
        const echo = setup({ dod: [approvedOpen, proposal] });
        await echo.controller.putDod(
            keyOnly,
            'goal-1',
            {
                dodCriteria: [
                    { id: 'kr-launch', text: 'Launched', status: 'open' },
                    { id: 'dod-proposed', text: 'Docs published', status: 'open' },
                ],
            },
            undefined,
            res(),
        );
        expect(echo.orchestrator.setDodCriteria).not.toHaveBeenCalled();
        expect(echo.orchestrator.proposeDodCriteria).not.toHaveBeenCalled();

        const changed = setup({ dod: [approvedOpen, proposal] });
        await expect(
            changed.controller.putDod(
                keyOnly,
                'goal-1',
                {
                    dodCriteria: [
                        { id: 'kr-launch', text: 'Launched', status: 'open' },
                        { id: 'dod-proposed', text: 'Docs published', status: 'done' },
                    ],
                },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject(refused([{ id: 'dod-proposed', reason: 'proposal_changed' }]));
    });

    it('PUT dod: an unchanged full-set echo writes nothing and keeps the proposals it leaves out', async () => {
        const { controller, orchestrator } = setup({ dod: [approvedOpen, approvedDone, proposal] });
        await controller.putDod(
            keyOnly,
            'goal-1',
            {
                dodCriteria: [
                    { id: 'kr-launch', text: 'Launched', status: 'open' },
                    { id: 'kr-docs', text: 'Docs', status: 'done' },
                ],
            },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
        expect(orchestrator.proposeDodCriteria).not.toHaveBeenCalled();
    });

    it('PUT dod: INTEGRATION_GOAL_DOD_PROPOSE_ONLY=false restores the operator-authored write', async () => {
        process.env.INTEGRATION_GOAL_DOD_PROPOSE_ONLY = 'false';
        const { controller, orchestrator } = setup();
        await controller.putDod(
            keyOnly,
            'goal-1',
            { dodCriteria: [{ id: 'kr-launch', text: 'Launched', status: 'done' }] },
            undefined,
            res(),
        );
        expect(orchestrator.setDodCriteria).toHaveBeenCalledWith(
            'owner-1',
            'goal-1',
            [{ id: 'kr-launch', text: 'Launched', status: 'done', evidence: null, note: null }],
            {},
        );
    });

    it('POST goals: refuses (422) Definition-of-Done criteria created done or waived without a person', async () => {
        const { controller, goals } = setup();
        await expect(
            controller.create(
                keyOnly,
                {
                    title: 'Ship it',
                    goalKind: 'delivery',
                    dodCriteria: [
                        { id: 'kr-a', text: 'Built', status: 'done' },
                        { id: 'kr-b', text: 'Tested', status: 'open' },
                    ],
                } as never,
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject(refused([{ id: 'kr-a', reason: 'closed_status' }]));
        expect(goals.createExternal).not.toHaveBeenCalled();
    });

    it('POST goals: open criteria without a person, and done ones relayed for a person, are created', async () => {
        const open = setup();
        await open.controller.create(
            keyOnly,
            {
                title: 'Ship it',
                goalKind: 'delivery',
                dodCriteria: [{ id: 'kr-b', text: 'Tested', status: 'open' }],
            } as never,
            undefined,
            req(),
            res(),
        );
        expect(open.goals.createExternal).toHaveBeenCalled();

        const relayedCreate = setup();
        await relayedCreate.controller.create(
            relayed,
            {
                title: 'Ship it',
                goalKind: 'delivery',
                dodCriteria: [{ id: 'kr-a', text: 'Built', status: 'done' }],
            } as never,
            undefined,
            req(),
            res(),
        );
        expect(relayedCreate.goals.createExternal).toHaveBeenCalled();
    });

    it('PATCH: refuses (422) a title / description change of a running Goal without a person', async () => {
        const { controller, goals } = setup({ loopStatus: 'running' });
        await expect(
            controller.update(
                keyOnly,
                'goal-1',
                { description: 'New instructions' },
                undefined,
                res(),
            ),
        ).rejects.toMatchObject({
            status: 422,
            response: {
                error: {
                    code: 'domain_rule',
                    details: { reason: 'goal_loop_running', fields: ['description'] },
                },
            },
        });
        expect(goals.update).not.toHaveBeenCalled();
    });

    it('PATCH: a running Goal still takes other fields, a relayed edit, and text edits once not running', async () => {
        const running = setup({ loopStatus: 'running' });
        await running.controller.update(keyOnly, 'goal-1', { targetValue: 5 }, undefined, res());
        expect(running.goals.update).toHaveBeenCalledWith(
            'owner-1',
            'goal-1',
            { targetValue: 5 },
            expect.anything(),
        );

        const relayedEdit = setup({ loopStatus: 'running' });
        await relayedEdit.controller.update(
            relayed,
            'goal-1',
            { title: 'Renamed' },
            undefined,
            res(),
        );
        expect(relayedEdit.goals.update).toHaveBeenCalled();

        const paused = setup({ loopStatus: 'paused' });
        await paused.controller.update(keyOnly, 'goal-1', { title: 'Renamed' }, undefined, res());
        expect(paused.goals.update).toHaveBeenCalled();
    });

    it('PATCH: INTEGRATION_GOAL_TEXT_EDIT_RUNNING=true restores text edits of a running Goal', async () => {
        process.env.INTEGRATION_GOAL_TEXT_EDIT_RUNNING = 'true';
        const { controller, goals } = setup({ loopStatus: 'running' });
        await controller.update(keyOnly, 'goal-1', { title: 'Renamed' }, undefined, res());
        expect(goals.update).toHaveBeenCalled();
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
