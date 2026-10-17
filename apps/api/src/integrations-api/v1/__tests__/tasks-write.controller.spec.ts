import {
    DuplicateExternalRefError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { TaskTransitionBlockedException } from '@ever-works/agent/tasks-domain';
import { IntegrationExceptionFilter } from '../integration-exception.filter';
import { IntegrationTasksWriteController } from '../tasks-write.controller';

/**
 * Task writes of `/api/integrations/v1` (EW-P1-4): Idempotency-Key, externalRef
 * de-duplication (200 with the existing task), If-Match, attribution and the
 * visibility rule — over doubles of the domain services.
 */
describe('IntegrationTasksWriteController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['tasks:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = (key: string | undefined = 'idem-1', body: unknown = {}) => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/tasks',
        body,
        headers: key ? { 'idempotency-key': key } : {},
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const tasks = {
            // As TasksService.create: `withinCreate` runs in the create's transaction (T17a).
            create: jest.fn(
                async (
                    _userId: string,
                    _input: unknown,
                    _scope: unknown,
                    options?: {
                        withinCreate?: (row: { id: string }, manager?: unknown) => Promise<void>;
                    },
                ) => {
                    const row = { id: 'task-1' };
                    if (options?.withinCreate) await options.withinCreate(row, 'tx-manager');
                    return row;
                },
            ),
            update: jest.fn().mockResolvedValue({}),
            remove: jest.fn().mockResolvedValue({ deleted: true }),
            addAssignee: jest.fn().mockResolvedValue({}),
            syncTransition: jest.fn().mockResolvedValue({ task: {}, from: 'backlog', path: [] }),
        };
        const teamResources = {
            attach: jest.fn(),
            detach: jest.fn(),
            // The task's current team_resources links (not teamIds minus its first).
            listTeamsForResource: jest.fn().mockResolvedValue([{ teamId: 'team-b' }]),
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
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const resources = {
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 3, teamIds: ['team-a', 'team-b'] },
                etag: '"3"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const visibility = { setVisibility: jest.fn().mockResolvedValue({}) };
        const controller = new IntegrationTasksWriteController(
            tasks as never,
            teamResources as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
            visibility as never,
        );
        return { controller, tasks, teamResources, links, idempotency, resources, visibility };
    };

    it('creates a backlog task attributed to the integration, linked to its externalRef', async () => {
        const { controller, tasks, links } = setup();
        const response = res();
        const body = await controller.create(
            user,
            {
                title: 'Ship it',
                teamIds: ['team-a', 'team-b'],
                assignees: [{ type: 'agent', id: 'agent-1' }],
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(tasks.create).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: 'Ship it',
                status: 'backlog',
                teamId: 'team-a',
                createdByType: 'integration',
                createdById: 'key-1',
            }),
            expect.anything(),
            expect.objectContaining({ withinCreate: expect.any(Function) }),
        );
        // T17a — linked inside the create's transaction (its manager).
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
            }),
            expect.objectContaining({ entityType: 'task', entityId: 'task-1', externalId: 'g-1' }),
            'tx-manager',
        );
        expect(tasks.addAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'agent',
            'agent-1',
            expect.anything(),
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toMatchObject({ id: 'task-1' });
    });

    it('answers 200 with the existing task when the externalRef is already linked', async () => {
        const { controller, tasks, links } = setup();
        links.findByExternal.mockResolvedValue({ entityId: 'task-existing' });
        const response = res();
        const body = await controller.create(
            user,
            { title: 'Ship it', externalRef: { source: 'gauzy', externalId: 'g-1' } },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(tasks.create).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'task-existing' });
    });

    it('a lost externalRef race rolls its create back (no undo call) and answers the winner', async () => {
        const { controller, tasks, links } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'task-winner' });
        links.create.mockRejectedValue(
            new DuplicateExternalRefError('external', 'task-winner', 'g-1'),
        );
        const response = res();
        const body = await controller.create(
            user,
            { title: 'Ship it', externalRef: { source: 'gauzy', externalId: 'g-1' } },
            undefined,
            req(),
            response,
        );
        // The link failed inside the create's transaction, so the task rolled
        // back with it: nothing is left to delete.
        expect(tasks.remove).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'task-winner' });
    });

    it('applies a hand-picked team / organization visibility on create and PATCH', async () => {
        const { controller, visibility } = setup();
        await controller.create(user, { title: 'x', visibility: 'team' }, undefined, req(), res());
        expect(visibility.setVisibility).toHaveBeenCalledWith('task', 'task-1', 'team');
        await controller.update(user, 'task-1', { visibility: 'organization' }, undefined, res());
        expect(visibility.setVisibility).toHaveBeenLastCalledWith('task', 'task-1', 'organization');
    });

    // Review 2026-10-17 F1: a child of a private task is private, so an integration
    // that cannot read the parent gets 404 before anything is written.
    it('refuses a parentTaskId the integration cannot read, on create and PATCH', async () => {
        const { controller, tasks, resources } = setup();
        const privateParent = (kind: string, _org: string, id: string) => {
            if (id === 'private-parent') throw new ResourceNotFoundError('task', id);
            return Promise.resolve({ dto: { id, version: 3, teamIds: [] }, etag: '"3"' });
        };
        resources.get.mockImplementation(privateParent as never);
        await expect(
            controller.create(
                user,
                { title: 'Child', parentTaskId: 'private-parent' },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(tasks.create).not.toHaveBeenCalled();

        await expect(
            controller.update(user, 'task-1', { parentTaskId: 'private-parent' }, undefined, res()),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
        expect(tasks.update).not.toHaveBeenCalled();

        await controller.create(
            user,
            { title: 'Child', parentTaskId: 'shared-parent' },
            undefined,
            req(),
            res(),
        );
        expect(tasks.create).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ parentTaskId: 'shared-parent' }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("refuses an externalRef of another integration's source", async () => {
        const { controller, tasks } = setup();
        await expect(
            controller.create(
                user,
                { title: 'x', externalRef: { source: 'jira', externalId: 'J-1' } },
                undefined,
                req(),
                res(),
            ),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('requires an Idempotency-Key, and refuses private visibility', async () => {
        const { controller } = setup();
        await expect(
            controller.create(user, { title: 'x' }, undefined, req(''), res()),
        ).rejects.toMatchObject({
            code: 'validation_failed',
        });
        await expect(
            controller.create(user, { title: 'x', visibility: 'private' }, undefined, req(), res()),
        ).rejects.toMatchObject({ code: 'domain_rule' });
    });

    it('PATCH honours If-Match and moves extra teams through team resources', async () => {
        const { controller, tasks, teamResources } = setup();
        await expect(
            controller.update(user, 'task-1', { title: 'New' }, '"2"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        expect(tasks.update).not.toHaveBeenCalled();

        const response = res();
        await controller.update(
            user,
            'task-1',
            { title: 'New', teamIds: ['team-a', 'team-c'] },
            '"3"',
            response,
        );
        expect(tasks.update).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            { title: 'New', teamId: 'team-a' },
            expect.anything(),
        );
        expect(teamResources.attach).toHaveBeenCalledWith(
            'owner-1',
            ORG,
            'team-c',
            { resourceType: 'task', resourceId: 'task-1' },
            { viewer: { kind: 'integration' } },
        );
        expect(teamResources.detach).toHaveBeenCalledWith(ORG, 'team-b', 'task', 'task-1');
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
        await expect(
            controller.update(user, 'task-1', {}, undefined, res()),
        ).rejects.toBeInstanceOf(IntegrationHttpException);
    });

    // EW-P2-3 — planning dates + estimate (contract v1 B.6).
    it('passes dueAt / startAt / estimateMinutes through create and PATCH (null clears)', async () => {
        const { controller, tasks } = setup();
        await controller.create(
            user,
            {
                title: 'Dated',
                dueAt: '2026-10-20T14:00:00.000Z',
                startAt: '2026-10-18T09:00:00.000Z',
                estimateMinutes: 90,
            },
            undefined,
            req(),
            res(),
        );
        expect(tasks.create).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                dueAt: new Date('2026-10-20T14:00:00.000Z'),
                startAt: new Date('2026-10-18T09:00:00.000Z'),
                estimateMinutes: 90,
            }),
            expect.anything(),
            // No externalRef: no link to write inside the create's transaction.
            {},
        );

        await controller.update(
            user,
            'task-1',
            { dueAt: null, estimateMinutes: 30 },
            undefined,
            res(),
        );
        expect(tasks.update).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            { dueAt: null, estimateMinutes: 30 },
            expect.anything(),
        );
    });

    it('DELETE honours If-Match and drops the task links', async () => {
        const { controller, tasks, links } = setup();
        await expect(controller.remove(user, 'task-1', 'W/"9"')).rejects.toBeInstanceOf(
            VersionMismatchError,
        );
        await controller.remove(user, 'task-1', undefined);
        expect(tasks.remove).toHaveBeenCalledWith('owner-1', 'task-1', expect.anything());
        expect(links.removeAllFor).toHaveBeenCalledWith(ORG, 'task', 'task-1');
    });

    it('transition walks the sync path without force and answers the moved task', async () => {
        const { controller, tasks } = setup();
        const response = res();
        const dto = await controller.transition(
            user,
            'task-1',
            { to: 'done' as never, mode: 'sync' },
            response,
        );
        expect(tasks.syncTransition).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'done',
            { force: false },
            expect.anything(),
        );
        expect(dto).toMatchObject({ id: 'task-1' });
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
    });

    it('a blocked sync walk keeps its transition_blocked code and details in the envelope', () => {
        const details = {
            from: 'todo',
            to: 'done',
            blockers: [{ taskId: 't-9', slug: 'T-9', title: 'Blocker', status: 'todo' }],
            pendingApprovers: [],
            path: ['in_progress', 'in_review', 'done'],
        };
        const envelope = new IntegrationExceptionFilter().toEnvelope(
            new TaskTransitionBlockedException('Blocked.', details as never),
        );
        expect(envelope).toMatchObject({ status: 409, code: 'transition_blocked', details });
    });
});
