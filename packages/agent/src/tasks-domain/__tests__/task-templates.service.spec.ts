import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DEFAULT_TEMPLATE_SLUG, TaskTemplatesService } from '../task-templates.service';
import { Task, TaskStatus } from '../../entities/task.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskBlock } from '../../entities/task-block.entity';

/**
 * Fake EntityManager: `create` tags rows with their entity class,
 * `save` assigns ids and records everything, so the specs can assert
 * the exact tree the transaction wrote.
 */
function makeManager() {
    let nextId = 1;
    const saved: Array<{ entity: unknown; row: any }> = [];
    const manager = {
        create: jest.fn((entity: unknown, data: Record<string, unknown>) => ({
            __entity: entity,
            ...data,
        })),
        save: jest.fn(async (row: any) => {
            if (!row.id) row.id = `row-${nextId++}`;
            saved.push({ entity: row.__entity, row });
            return row;
        }),
    };
    return { manager, saved };
}

function makeTemplatesRepo() {
    return {
        findByUserId: jest.fn().mockResolvedValue([]),
        countByUserId: jest.fn().mockResolvedValue(1),
        findByIdAndUser: jest.fn().mockResolvedValue(null),
        findBySlugAndUser: jest.fn().mockResolvedValue(null),
        findStepsByTemplateId: jest.fn().mockResolvedValue([]),
        findStepsByTemplateIds: jest.fn().mockResolvedValue(new Map()),
        createWithSteps: jest.fn(),
        updateById: jest.fn(),
        replaceSteps: jest.fn(),
        deleteById: jest.fn(),
        withTransaction: jest.fn(),
    };
}

describe('TaskTemplatesService', () => {
    let templates: ReturnType<typeof makeTemplatesRepo>;
    let counter: any;
    let agents: any;
    let works: any;
    let svc: TaskTemplatesService;

    beforeEach(() => {
        templates = makeTemplatesRepo();
        let slug = 100;
        counter = { nextSlug: jest.fn().mockImplementation(async () => ++slug) };
        agents = { findByIdAndUser: jest.fn().mockResolvedValue({ id: 'agent-1' }) };
        works = { findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'u1' }) };
        svc = new TaskTemplatesService(templates as never, counter, agents, works, undefined);
    });

    describe('seeding', () => {
        it('seeds the default Compound Engineering Workflow on first list', async () => {
            templates.countByUserId.mockResolvedValueOnce(0);
            templates.createWithSteps.mockResolvedValueOnce({ id: 'tpl-1' });

            await svc.list('u1');

            expect(templates.createWithSteps).toHaveBeenCalledTimes(1);
            const [tpl, steps] = templates.createWithSteps.mock.calls[0];
            expect(tpl.slug).toBe(DEFAULT_TEMPLATE_SLUG);
            expect(steps).toHaveLength(9);
            // Steps 0+1 gate on approval; the chain is linear via dependsOn.
            expect(steps[0].requiresApproval).toBe(true);
            expect(steps[1].requiresApproval).toBe(true);
            expect(steps[1].dependsOn).toEqual([0]);
            expect(steps[8].dependsOn).toEqual([7]);
            expect(steps[8].agentTemplateSlug).toBeNull();
            expect(steps[0].agentTemplateSlug).toBe('starter-spec-writer');
        });

        it('does not seed when the user already has templates', async () => {
            templates.countByUserId.mockResolvedValueOnce(2);
            await svc.list('u1');
            expect(templates.createWithSteps).not.toHaveBeenCalled();
        });

        it('a lost seed race (unique violation) does not fail the list', async () => {
            templates.countByUserId.mockResolvedValueOnce(0);
            templates.createWithSteps.mockRejectedValueOnce(
                new Error('UNIQUE constraint failed: task_templates.slug'),
            );
            await expect(svc.list('u1')).resolves.toEqual([]);
        });
    });

    describe('CRUD authz + validation', () => {
        it('getOne 404s on a foreign/unknown id (no existence leak)', async () => {
            templates.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.getOne('u1', 'other-users-id')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('create rejects a duplicate slug with 409', async () => {
            templates.findBySlugAndUser.mockResolvedValueOnce({ id: 'existing' });
            await expect(
                svc.create('u1', { name: 'My flow', steps: [{ title: 'One' }] }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('create rejects an empty step list', async () => {
            await expect(svc.create('u1', { name: 'X', steps: [] })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('create rejects a step depending on an unknown position', async () => {
            await expect(
                svc.create('u1', {
                    name: 'X',
                    steps: [{ title: 'A', dependsOn: [5] }],
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('create rejects a self-dependency', async () => {
            await expect(
                svc.create('u1', {
                    name: 'X',
                    steps: [{ title: 'A', dependsOn: [0] }],
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('create rejects a dependency cycle', async () => {
            await expect(
                svc.create('u1', {
                    name: 'X',
                    steps: [
                        { title: 'A', dependsOn: [1] },
                        { title: 'B', dependsOn: [0] },
                    ],
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('create rejects an unreachable agent binding', async () => {
            agents.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(
                svc.create('u1', {
                    name: 'X',
                    steps: [{ title: 'A', agentId: '11111111-1111-1111-1111-111111111111' }],
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('remove 404s cross-user before deleting anything', async () => {
            templates.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.remove('u1', 'foreign')).rejects.toBeInstanceOf(NotFoundException);
            expect(templates.deleteById).not.toHaveBeenCalled();
        });
    });

    describe('instantiateTemplate', () => {
        const template = {
            id: 'tpl-1',
            userId: 'u1',
            name: 'Flow',
            slug: 'flow',
            labels: ['workflow'],
        };
        const steps = [
            {
                id: 's0',
                templateId: 'tpl-1',
                position: 0,
                title: 'Write spec',
                prompt: 'Write the spec.',
                agentId: 'agent-1',
                agentTemplateSlug: null,
                requiresApproval: true,
                dependsOn: null,
            },
            {
                id: 's1',
                templateId: 'tpl-1',
                position: 1,
                title: 'Implement',
                prompt: 'Implement it.',
                agentId: null,
                agentTemplateSlug: 'starter-plan-executor',
                requiresApproval: false,
                dependsOn: [0],
            },
        ];

        function arm() {
            templates.findByIdAndUser.mockResolvedValue(template);
            templates.findStepsByTemplateId.mockResolvedValue(steps);
            const { manager, saved } = makeManager();
            templates.withTransaction.mockImplementation(async (fn: any) => fn(manager));
            return { manager, saved };
        }

        it('creates parent + one subtask per step + blocks + assignees + approvers in ONE transaction', async () => {
            const { saved } = arm();

            const result = await svc.instantiateTemplate('u1', 'tpl-1', {
                title: 'Ship feature X',
                description: 'Feature X does Y.',
                workId: 'work-1',
            });

            expect(templates.withTransaction).toHaveBeenCalledTimes(1);

            const tasks = saved.filter((s) => s.entity === Task).map((s) => s.row);
            const blocks = saved.filter((s) => s.entity === TaskBlock).map((s) => s.row);
            const assignees = saved.filter((s) => s.entity === TaskAssignee).map((s) => s.row);
            const approvers = saved.filter((s) => s.entity === TaskApprover).map((s) => s.row);

            expect(tasks).toHaveLength(3); // parent + 2 steps
            const parent = tasks[0];
            expect(parent.parentTaskId).toBeNull();
            expect(parent.title).toBe('Ship feature X');
            expect(parent.workId).toBe('work-1');
            expect(parent.status).toBe(TaskStatus.TODO);

            const children = tasks.slice(1);
            for (const child of children) {
                expect(child.parentTaskId).toBe(parent.id);
                // Children agree with the parent on the owner tuple —
                // the sub-task hierarchy rule TasksService enforces.
                expect(child.workId).toBe('work-1');
            }

            // dependsOn [0] on step 1 → step-1 subtask blocked by step-0.
            expect(blocks).toHaveLength(1);
            expect(blocks[0].taskId).toBe(children[1].id);
            expect(blocks[0].blockedByTaskId).toBe(children[0].id);

            // agentId on step 0 → agent assignee on its subtask.
            expect(assignees).toHaveLength(1);
            expect(assignees[0]).toMatchObject({
                taskId: children[0].id,
                assigneeType: 'agent',
                assigneeId: 'agent-1',
            });

            // requiresApproval on step 0 → owner approver on its subtask.
            expect(approvers).toHaveLength(1);
            expect(approvers[0]).toMatchObject({
                taskId: children[0].id,
                approverType: 'user',
                approverId: 'u1',
            });

            expect(result.parentTask.id).toBe(parent.id);
            expect(result.subtasks).toHaveLength(2);
        });

        it('appends the per-step prompt under a "## Agent prompt" heading', async () => {
            const { saved } = arm();
            await svc.instantiateTemplate('u1', 'tpl-1', {
                title: 'Ship feature X',
                description: 'Feature X does Y.',
            });
            const tasks = saved.filter((s) => s.entity === Task).map((s) => s.row);
            expect(tasks[1].description).toContain('Feature X does Y.');
            expect(tasks[1].description).toContain('## Agent prompt');
            expect(tasks[1].description).toContain('Write the spec.');
        });

        it('skips the assignee for an agent that is no longer reachable', async () => {
            const { saved } = arm();
            agents.findByIdAndUser.mockResolvedValue(null);

            await svc.instantiateTemplate('u1', 'tpl-1', { title: 'T' });

            expect(saved.filter((s) => s.entity === TaskAssignee)).toHaveLength(0);
        });

        it('stamps branchName onto the parent branchRef', async () => {
            const { saved } = arm();
            await svc.instantiateTemplate('u1', 'tpl-1', {
                title: 'T',
                branchName: 'feature/ship-x',
            });
            const parent = saved.filter((s) => s.entity === Task)[0].row;
            expect(parent.branchRef).toBe('feature/ship-x');
        });

        it('404s on a foreign template id', async () => {
            templates.findByIdAndUser.mockResolvedValue(null);
            await expect(
                svc.instantiateTemplate('u1', 'foreign', { title: 'T' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('rejects an unreachable workId before writing anything', async () => {
            arm();
            works.findById.mockResolvedValueOnce({ id: 'work-2', userId: 'someone-else' });
            await expect(
                svc.instantiateTemplate('u1', 'tpl-1', { title: 'T', workId: 'work-2' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(templates.withTransaction).not.toHaveBeenCalled();
        });

        it('a mid-transaction failure surfaces (nothing partially applied by contract)', async () => {
            arm();
            templates.withTransaction.mockRejectedValueOnce(new Error('insert failed'));
            await expect(svc.instantiateTemplate('u1', 'tpl-1', { title: 'T' })).rejects.toThrow(
                'insert failed',
            );
        });
    });
});
