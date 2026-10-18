import { IntegrationTaskSetsController } from '../tasks-sets.controller';

/**
 * PUT-set routes of a task (EW-P1-4): the full set in, the difference out —
 * only the edges that change go through the TasksService edge methods.
 */
describe('IntegrationTaskSetsController', () => {
    const user = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: { keyId: 'key-1', integrationKind: 'ever-gauzy' },
    } as never;
    const res = () => ({ setHeader: jest.fn() });

    const setup = () => {
        const tasks = {
            getOne: jest.fn().mockResolvedValue({ id: 'task-1', isRecurring: false }),
            addAssignee: jest.fn(),
            removeAssignee: jest.fn(),
            listWatchers: jest.fn().mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-2' }]),
            addWatcher: jest.fn(),
            removeWatcher: jest.fn(),
            addBlocker: jest.fn(),
            removeBlocker: jest.fn(),
            addRelation: jest.fn(),
            removeRelation: jest.fn(),
        };
        const resources = {
            get: jest.fn().mockResolvedValue({ dto: { id: 'task-1', version: 4 }, etag: '"4"' }),
        };
        const scope = { getScope: () => ({ tenantId: 't-1', organizationId: 'org-1' }) };
        const assignees = {
            findByTaskId: jest.fn().mockResolvedValue([
                { id: 'a-1', assigneeType: 'user', assigneeId: 'u-1' },
                { id: 'a-2', assigneeType: 'agent', assigneeId: 'ag-1' },
            ]),
        };
        const blocks = {
            findByTaskId: jest.fn().mockResolvedValue([{ id: 'b-1', blockedByTaskId: 't-9' }]),
        };
        const relations = {
            findByTaskId: jest
                .fn()
                .mockResolvedValue([{ id: 'r-1', relatedTaskId: 't-5', kind: 'related' }]),
        };
        const controller = new IntegrationTaskSetsController(
            tasks as never,
            resources as never,
            scope as never,
            assignees as never,
            blocks as never,
            relations as never,
        );
        return { controller, tasks };
    };

    // Review 2026-10-17 F36: a stale If-Match answers 412 and changes nothing.
    it('every PUT-set refuses a stale If-Match with 412 before any change', async () => {
        const { controller, tasks } = setup();
        const stale = '"3"'; // the task is at version 4
        await expect(
            controller.assignees(user, 'task-1', { assignees: [] }, res(), stale),
        ).rejects.toMatchObject({ expected: 3, current: 4 });
        await expect(
            controller.watchers(user, 'task-1', { userIds: [] }, res(), stale),
        ).rejects.toMatchObject({ expected: 3, current: 4 });
        await expect(
            controller.blocks(user, 'task-1', { blockedBy: [] }, res(), stale),
        ).rejects.toMatchObject({ expected: 3, current: 4 });
        await expect(
            controller.relations(user, 'task-1', { relations: [] }, res(), stale),
        ).rejects.toMatchObject({ expected: 3, current: 4 });
        expect(tasks.removeAssignee).not.toHaveBeenCalled();
        expect(tasks.removeWatcher).not.toHaveBeenCalled();
        expect(tasks.removeBlocker).not.toHaveBeenCalled();
        expect(tasks.removeRelation).not.toHaveBeenCalled();
        // The current version passes.
        await controller.assignees(user, 'task-1', { assignees: [] }, res(), '"4"');
        expect(tasks.removeAssignee).toHaveBeenCalledTimes(2);
    });

    it('assignees: removes the dropped, adds the new, keeps the rest', async () => {
        const { controller, tasks } = setup();
        const response = res();
        const dto = await controller.assignees(
            user,
            'task-1',
            {
                assignees: [
                    { type: 'agent', id: 'ag-1' },
                    { type: 'user', id: 'u-3' },
                ],
            },
            response,
        );
        expect(tasks.removeAssignee).toHaveBeenCalledTimes(1);
        expect(tasks.removeAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'a-1',
            expect.anything(),
        );
        expect(tasks.addAssignee).toHaveBeenCalledTimes(1);
        expect(tasks.addAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'user',
            'u-3',
            expect.anything(),
        );
        expect(dto).toEqual({ id: 'task-1', version: 4 });
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"4"');
    });

    // Works-security lane 3a — the agent assignees of a recurring template are
    // who runs at every future fire: an integration may not change them.
    it('refuses changing the agent assignees of a recurring template (422), user assignees stay open', async () => {
        const { controller, tasks } = setup();
        tasks.getOne.mockResolvedValue({ id: 'task-1', isRecurring: true });
        await expect(
            controller.assignees(
                user,
                'task-1',
                {
                    assignees: [
                        { type: 'agent', id: 'ag-2' },
                        { type: 'user', id: 'u-1' },
                    ],
                },
                res(),
            ),
        ).rejects.toMatchObject({
            code: 'domain_rule',
            response: { error: { details: { reason: 'recurring_template' } } },
        });
        expect(tasks.addAssignee).not.toHaveBeenCalled();
        expect(tasks.removeAssignee).not.toHaveBeenCalled();
        // Same agents, a different user: allowed, and the template is not even read.
        tasks.getOne.mockClear();
        await controller.assignees(
            user,
            'task-1',
            {
                assignees: [
                    { type: 'agent', id: 'ag-1' },
                    { type: 'user', id: 'u-3' },
                ],
            },
            res(),
        );
        expect(tasks.getOne).not.toHaveBeenCalled();
        expect(tasks.addAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'user',
            'u-3',
            expect.anything(),
        );
    });

    it('lets an integration change the agent assignees of an ordinary Task', async () => {
        const { controller, tasks } = setup();
        await controller.assignees(
            user,
            'task-1',
            { assignees: [{ type: 'agent', id: 'ag-2' }] },
            res(),
        );
        expect(tasks.addAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'agent',
            'ag-2',
            expect.anything(),
        );
    });

    it('watchers, blocks and relations apply only the difference', async () => {
        const { controller, tasks } = setup();
        await controller.watchers(user, 'task-1', { userIds: ['u-2', 'u-3'] }, res());
        expect(tasks.removeWatcher).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'u-1',
            expect.anything(),
        );
        expect(tasks.addWatcher).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'u-3',
            expect.anything(),
        );

        await controller.blocks(user, 'task-1', { blockedBy: ['t-9'] }, res());
        expect(tasks.removeBlocker).not.toHaveBeenCalled();
        expect(tasks.addBlocker).not.toHaveBeenCalled();

        await controller.relations(
            user,
            'task-1',
            { relations: [{ taskId: 't-5', kind: 'duplicates' }] },
            res(),
        );
        // Same task, another kind: the old relation goes, the new one comes.
        expect(tasks.removeRelation).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'r-1',
            expect.anything(),
        );
        expect(tasks.addRelation).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            't-5',
            'duplicates',
            expect.anything(),
        );
    });
});
