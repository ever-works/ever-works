import { BadRequestException, ConflictException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskRepository } from '../../database/repositories/task.repository';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';
import { AgentStatus } from '../../entities/agent.entity';

/**
 * Schedules — the reversible pause for recurring Tasks, and the out-of-band
 * run-now. Two halves:
 *
 *  1. the DUE-SCAN honours the pause (and nothing else about selection
 *     changes), so every job runtime that drives the recurrence dispatcher
 *     skips a paused template;
 *  2. the service writes only the pause column, never the cadence, and
 *     run-now never moves the next scheduled fire.
 */

function template(overrides: Partial<Task> = {}): Task {
    return {
        id: 'tpl-1',
        userId: 'user-1',
        slug: 'T-1',
        title: 'Morning inbox scan',
        description: 'Read the inbox, triage it.',
        status: TaskStatus.TODO,
        priority: TaskPriority.P3,
        labels: null,
        agentId: 'agent-1',
        isRecurring: true,
        recurrenceRule: null,
        recurrenceCron: '0 7 * * *',
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        recurrenceEndsAt: new Date('2030-01-01T00:00:00Z'),
        recurrenceMaxOccurrences: 99,
        recurrenceOccurredCount: 7,
        parentRecurringTaskId: null,
        recurrencePausedAt: null,
        createdByType: 'user',
        createdById: 'user-1',
        requireAllApprovers: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

describe('TaskRepository.findDueRecurringTemplates — the due-scan honours the pause', () => {
    function build() {
        const qb = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        };
        const repository = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);
        return { qb, repository };
    }

    it('excludes paused templates and keeps every other criterion exactly as before', async () => {
        const { qb, repository } = build();
        const now = new Date('2026-09-14T10:00:00Z');
        await repository.findDueRecurringTemplates(25, now);

        expect(qb.where).toHaveBeenCalledWith('task.isRecurring = :rec', { rec: true });
        expect(qb.andWhere).toHaveBeenCalledWith('task.recurrencePausedAt IS NULL');
        expect(qb.andWhere).toHaveBeenCalledWith('task.nextOccurrenceAt IS NOT NULL');
        expect(qb.andWhere).toHaveBeenCalledWith('task.nextOccurrenceAt <= :now', { now });
        expect(qb.andWhere).toHaveBeenCalledTimes(3);
        expect(qb.orderBy).toHaveBeenCalledWith('task.nextOccurrenceAt', 'ASC');
        expect(qb.take).toHaveBeenCalledWith(25);
    });

    it('the CAS claim also refuses a template paused after the scan read it', async () => {
        const qb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({ affected: 0 }),
        };
        const repository = new TaskRepository({ createQueryBuilder: jest.fn(() => qb) } as never);
        expect(await repository.casClaimRecurrence('tpl-1', new Date(), null)).toBe(false);
        expect(qb.andWhere).toHaveBeenCalledWith('recurrencePausedAt IS NULL');
    });
});

describe('TasksService — recurrence pause / resume / run-now', () => {
    function build(task: Task) {
        let current = task;
        const repos = {
            tasks: {
                findByIdAndUser: jest.fn(async () => current),
                updateById: jest.fn(async (_id: string, patch: Partial<Task>) => {
                    current = { ...current, ...patch } as Task;
                }),
                create: jest.fn(
                    async (data: Partial<Task>) => ({ ...data, id: 'instance-1' }) as Task,
                ),
                findLatestRecurrenceInstance: jest.fn().mockResolvedValue(null),
            },
            assignees: {
                findAgentAssignees: jest.fn().mockResolvedValue([]),
                findByTaskId: jest.fn().mockResolvedValue([]),
                add: jest.fn().mockResolvedValue(undefined),
            },
            counter: { nextSlug: jest.fn().mockResolvedValue(42) },
            transitions: {
                dispatchAgentRun: jest.fn().mockResolvedValue({
                    runId: 'run-1',
                    dispatched: true,
                    parked: false,
                }),
            },
            agents: {
                findByIdAndUser: jest
                    .fn()
                    .mockResolvedValue({ id: 'agent-1', status: AgentStatus.ACTIVE }),
            },
            agentRuns: { findLatestForTask: jest.fn().mockResolvedValue(null) },
        };
        const service = new TasksService(
            repos.tasks as never,
            repos.assignees as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            repos.counter as never,
            repos.transitions as never,
            undefined,
            undefined,
            repos.agents as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            repos.agentRuns as never,
        );
        return { service, repos, current: () => current };
    }

    it('pause writes ONLY the pause column — cadence, next fire and bounds are untouched', async () => {
        const original = template();
        const { service, repos, current } = build(original);
        await service.pauseRecurrence('user-1', 'tpl-1');

        expect(repos.tasks.updateById).toHaveBeenCalledTimes(1);
        const [, patch] = repos.tasks.updateById.mock.calls[0];
        expect(Object.keys(patch)).toEqual(['recurrencePausedAt']);
        expect(patch.recurrencePausedAt).toBeInstanceOf(Date);
        for (const key of [
            'recurrenceCron',
            'recurrenceRule',
            'nextOccurrenceAt',
            'recurrenceEndsAt',
            'recurrenceMaxOccurrences',
            'recurrenceOccurredCount',
            'isRecurring',
        ] as const) {
            expect(current()[key]).toEqual(original[key]);
        }
    });

    it('pause is idempotent and keeps the first instant', async () => {
        const pausedAt = new Date('2026-09-10T00:00:00Z');
        const { service, repos } = build(template({ recurrencePausedAt: pausedAt }));
        await service.pauseRecurrence('user-1', 'tpl-1');
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('refuses to pause a Task that is not a recurring template', async () => {
        const { service } = build(template({ isRecurring: false }));
        await expect(service.pauseRecurrence('user-1', 'tpl-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );
        const instance = build(template({ parentRecurringTaskId: 'tpl-0' }));
        await expect(instance.service.pauseRecurrence('user-1', 'tpl-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('resume clears the pause and keeps a future next fire exactly', async () => {
        const next = new Date(Date.now() + 3 * 60 * 60 * 1000);
        const { service, repos } = build(
            template({ recurrencePausedAt: new Date(), nextOccurrenceAt: next }),
        );
        await service.resumeRecurrence('user-1', 'tpl-1');
        expect(repos.tasks.updateById).toHaveBeenCalledWith('tpl-1', { recurrencePausedAt: null });
    });

    it('resume skips occurrences missed while paused instead of replaying them', async () => {
        const { service, repos } = build(
            template({
                recurrencePausedAt: new Date('2026-01-01T00:00:00Z'),
                nextOccurrenceAt: new Date('2026-01-02T07:00:00Z'),
            }),
        );
        const before = Date.now();
        await service.resumeRecurrence('user-1', 'tpl-1');
        const [, patch] = repos.tasks.updateById.mock.calls[0];
        expect(patch.recurrencePausedAt).toBeNull();
        expect(patch.nextOccurrenceAt).toBeInstanceOf(Date);
        expect((patch.nextOccurrenceAt as Date).getTime()).toBeGreaterThan(before);
        expect((patch.nextOccurrenceAt as Date).getUTCHours()).toBe(7);
    });

    it('resume on a template that is not paused writes nothing', async () => {
        const { service, repos } = build(template());
        await service.resumeRecurrence('user-1', 'tpl-1');
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('clearing recurrence ends a pause, and leaves every other clear byte-identical', async () => {
        const paused = build(template({ recurrencePausedAt: new Date() }));
        await paused.service.clearRecurring('user-1', 'tpl-1');
        expect(paused.repos.tasks.updateById.mock.calls[0][1]).toMatchObject({
            isRecurring: false,
            recurrencePausedAt: null,
        });

        const running = build(template());
        await running.service.clearRecurring('user-1', 'tpl-1');
        expect(running.repos.tasks.updateById.mock.calls[0][1]).not.toHaveProperty(
            'recurrencePausedAt',
        );
    });

    it('run-now spawns and dispatches one instance without moving the next fire', async () => {
        const original = template({ recurrencePausedAt: new Date() });
        const { service, repos, current } = build(original);
        const result = await service.runRecurringNow('user-1', 'tpl-1');

        expect(result).toMatchObject({
            templateId: 'tpl-1',
            instanceId: 'instance-1',
            instanceSlug: 'T-42',
            nextOccurrenceAt: original.nextOccurrenceAt,
            runs: [{ agentId: 'agent-1', runId: 'run-1', dispatched: true, parked: false }],
        });
        const created = repos.tasks.create.mock.calls[0][0];
        expect(created).toMatchObject({
            parentRecurringTaskId: 'tpl-1',
            isRecurring: false,
            agentId: 'agent-1',
            slug: 'T-42',
        });
        // The template itself is never written — not the next fire, not the
        // occurred count, and not the pause (run-now does not resume).
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
        expect(current().nextOccurrenceAt).toEqual(original.nextOccurrenceAt);
        expect(current().recurrencePausedAt).toEqual(original.recurrencePausedAt);
        expect(repos.transitions.dispatchAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'instance-1' }),
            'agent-1',
            { dedupKey: 'instance-1:agent-1:schedule-run-now' },
        );
    });

    it('run-now prefers agent assignees over the template agentId', async () => {
        const { service, repos } = build(template());
        repos.assignees.findAgentAssignees.mockResolvedValue([{ assigneeId: 'agent-9' }]);
        repos.assignees.findByTaskId.mockResolvedValue([
            { assigneeType: 'agent', assigneeId: 'agent-9' },
        ]);
        repos.agents.findByIdAndUser.mockResolvedValue({
            id: 'agent-9',
            status: AgentStatus.ACTIVE,
        });
        const result = await service.runRecurringNow('user-1', 'tpl-1');
        expect(result.runs.map((run) => run.agentId)).toEqual(['agent-9']);
        expect(repos.assignees.add).toHaveBeenCalledWith('instance-1', 'agent', 'agent-9');
    });

    it('run-now refuses while the previous fire is still in flight', async () => {
        const { service, repos } = build(template());
        repos.tasks.findLatestRecurrenceInstance.mockResolvedValue({ id: 'instance-0' });
        repos.agentRuns.findLatestForTask.mockResolvedValue({
            id: 'run-0',
            status: 'running',
            startedAt: new Date('2026-09-14T09:04:00Z'),
        });
        const error = await service.runRecurringNow('user-1', 'tpl-1').catch((err) => err);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getResponse()).toMatchObject({
            code: 'SCHEDULE_ALREADY_RUNNING',
            runId: 'run-0',
        });
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('run-now refuses with no Agent, and with only an archived Agent', async () => {
        const noAgent = build(template({ agentId: null }));
        const error = await noAgent.service.runRecurringNow('user-1', 'tpl-1').catch((err) => err);
        expect(error.getResponse()).toMatchObject({ code: 'SCHEDULE_NO_AGENT' });
        expect(noAgent.repos.tasks.create).not.toHaveBeenCalled();

        const archived = build(template());
        archived.repos.agents.findByIdAndUser.mockResolvedValue({
            id: 'agent-1',
            status: AgentStatus.ARCHIVED,
        });
        const archivedError = await archived.service
            .runRecurringNow('user-1', 'tpl-1')
            .catch((err) => err);
        expect(archivedError.getResponse()).toMatchObject({ code: 'SCHEDULE_OWNER_ARCHIVED' });
        expect(archived.repos.tasks.create).not.toHaveBeenCalled();
    });

    it('run-now reports a run parked by the credits gate honestly', async () => {
        const { service, repos } = build(template());
        repos.transitions.dispatchAgentRun.mockResolvedValue({
            runId: 'run-2',
            dispatched: false,
            parked: true,
            queuedReason: 'insufficient-credits',
        });
        const result = await service.runRecurringNow('user-1', 'tpl-1');
        expect(result.runs[0]).toMatchObject({
            parked: true,
            queuedReason: 'insufficient-credits',
        });
    });
});
