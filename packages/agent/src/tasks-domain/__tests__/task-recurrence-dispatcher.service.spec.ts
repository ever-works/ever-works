import { TaskRecurrenceDispatcherService } from '../task-recurrence-dispatcher.service';
import { TaskPriority, TaskStatus } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

function makeTemplate(over: Partial<Task> = {}): Task {
    return {
        id: 'tmpl-1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Daily standup',
        description: null,
        status: TaskStatus.BACKLOG,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: true,
        recurrenceRule: 'FREQ=DAILY',
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: new Date('2026-05-26T00:00:00Z'),
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
    } as Task;
}

describe('TaskRecurrenceDispatcherService', () => {
    let tasks: any;
    let counter: any;
    let svc: TaskRecurrenceDispatcherService;

    beforeEach(() => {
        tasks = {
            findDueRecurringTemplates: jest.fn().mockResolvedValue([]),
            casClaimRecurrence: jest.fn().mockResolvedValue(true),
            create: jest.fn(),
        };
        counter = { nextSlug: jest.fn().mockResolvedValue(42) };
        svc = new TaskRecurrenceDispatcherService(tasks, counter);
    });

    it('returns empty summary when no templates are due', async () => {
        const summary = await svc.dispatchDue();
        expect(summary.dueCount).toBe(0);
        expect(summary.spawned).toBe(0);
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('happy path — claims template, advances nextOccurrenceAt, spawns instance with fresh slug', async () => {
        const template = makeTemplate({
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        });
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.casClaimRecurrence.mockResolvedValueOnce(true);
        tasks.create.mockResolvedValueOnce({ id: 'inst-1', slug: 'T-42' });

        const summary = await svc.dispatchDue();

        expect(summary.spawned).toBe(1);
        expect(summary.entries[0].outcome).toBe('spawned');
        expect(summary.entries[0].instanceSlug).toBe('T-42');
        expect(tasks.create).toHaveBeenCalledWith(
            expect.objectContaining({
                slug: 'T-42',
                parentRecurringTaskId: 'tmpl-1',
                isRecurring: false,
                tenantId: template.tenantId,
                organizationId: template.organizationId,
            }),
        );
        // CAS-claim advanced nextOccurrenceAt to a future Date.
        const casArgs = tasks.casClaimRecurrence.mock.calls[0];
        expect(casArgs[0]).toBe('tmpl-1');
        expect(casArgs[1]).toEqual(template.nextOccurrenceAt);
    });

    it('preserves a legacy personal template as personal', async () => {
        const template = makeTemplate({ tenantId: null, organizationId: null });
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.create.mockResolvedValueOnce({ id: 'inst-personal', slug: 'T-42' });

        await svc.dispatchDue();

        expect(tasks.create).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: null, organizationId: null }),
        );
    });

    it('CAS-claim loss → outcome=skipped, no spawn', async () => {
        const template = makeTemplate();
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.casClaimRecurrence.mockResolvedValueOnce(false);

        const summary = await svc.dispatchDue();

        expect(summary.spawned).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(summary.entries[0].outcome).toBe('skipped');
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('error during spawn is contained — one template failing doesn`t cascade', async () => {
        const templates = [makeTemplate({ id: 't1' }), makeTemplate({ id: 't2' })];
        tasks.findDueRecurringTemplates.mockResolvedValueOnce(templates);
        tasks.casClaimRecurrence.mockResolvedValue(true);
        tasks.create
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ id: 'inst-2', slug: 'T-43' });

        const summary = await svc.dispatchDue();

        expect(summary.failed).toBe(1);
        expect(summary.spawned).toBe(1);
        expect(summary.entries.map((e) => e.outcome).sort()).toEqual(['failed', 'spawned']);
    });

    it('hands the count of dueCount through the summary', async () => {
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([
            makeTemplate({ id: 'a' }),
            makeTemplate({ id: 'b' }),
        ]);
        tasks.create.mockResolvedValue({ id: 'inst', slug: 'T-44' });
        const summary = await svc.dispatchDue();
        expect(summary.dueCount).toBe(2);
    });

    it('handles cron-cadence templates (recurrenceCron, no RRULE)', async () => {
        const template = makeTemplate({
            recurrenceRule: null,
            recurrenceCron: '0 9 * * *',
        } as any);
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.create.mockResolvedValueOnce({ id: 'inst-c', slug: 'T-45' });

        const summary = await svc.dispatchDue();

        expect(summary.spawned).toBe(1);
        // CAS advanced nextOccurrenceAt to the next 09:00 UTC fire.
        const nextSlot = tasks.casClaimRecurrence.mock.calls[0][2] as Date;
        expect(nextSlot).not.toBeNull();
        expect(nextSlot.getUTCHours()).toBe(9);
    });
});

describe('TaskRecurrenceDispatcherService — instance execution (schedule-modes upgrade)', () => {
    let tasks: any;
    let counter: any;
    let assignees: any;
    let transitions: any;
    let notifications: any;
    let svc: TaskRecurrenceDispatcherService;

    beforeEach(() => {
        tasks = {
            findDueRecurringTemplates: jest.fn().mockResolvedValue([]),
            casClaimRecurrence: jest.fn().mockResolvedValue(true),
            create: jest.fn(),
            findDueScheduledTasks: jest.fn().mockResolvedValue([]),
            casClaimSchedule: jest.fn().mockResolvedValue(true),
            casUpdateStatus: jest.fn().mockResolvedValue(true),
        };
        counter = { nextSlug: jest.fn().mockResolvedValue(42) };
        assignees = {
            findByTaskId: jest.fn().mockResolvedValue([]),
            findAgentAssignees: jest.fn().mockResolvedValue([]),
            add: jest.fn().mockResolvedValue({}),
        };
        transitions = {
            dispatchAgentRun: jest
                .fn()
                .mockResolvedValue({ runId: 'run-1', dispatched: true, parked: false }),
        };
        notifications = { emit: jest.fn().mockResolvedValue(1) };
        svc = new TaskRecurrenceDispatcherService(
            tasks,
            counter,
            notifications,
            assignees,
            transitions,
        );
    });

    it('copies the template assignee rows onto the spawned instance', async () => {
        const template = makeTemplate();
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.create.mockResolvedValueOnce({ id: 'inst-1', slug: 'T-42', userId: 'u1' });
        assignees.findByTaskId.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-1' },
            { assigneeType: 'user', assigneeId: 'user-2' },
        ]);

        await svc.dispatchDue();

        expect(assignees.findByTaskId).toHaveBeenCalledWith('tmpl-1');
        expect(assignees.add).toHaveBeenCalledWith('inst-1', 'agent', 'agent-1');
        expect(assignees.add).toHaveBeenCalledWith('inst-1', 'user', 'user-2');
    });

    it('dispatches the spawned instance through dispatchAgentRun per agent assignee', async () => {
        const template = makeTemplate();
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        const instance = { id: 'inst-1', slug: 'T-42', userId: 'u1', title: 'Daily standup' };
        tasks.create.mockResolvedValueOnce(instance);
        assignees.findAgentAssignees.mockResolvedValueOnce([
            { assigneeType: 'agent', assigneeId: 'agent-1' },
        ]);

        const summary = await svc.dispatchDue();

        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            instance,
            'agent-1',
            expect.objectContaining({ dedupKey: expect.stringContaining('inst-1:agent-1') }),
        );
        expect(summary.entries[0].dispatch).toBe('dispatched');
    });

    it('falls back to the instance agentId column when there are no agent assignees', async () => {
        const template = makeTemplate({ agentId: 'agent-col' } as any);
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        const instance = {
            id: 'inst-1',
            slug: 'T-42',
            userId: 'u1',
            title: 'Daily standup',
            agentId: 'agent-col',
        };
        tasks.create.mockResolvedValueOnce(instance);

        const summary = await svc.dispatchDue();

        expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
            instance,
            'agent-col',
            expect.anything(),
        );
        expect(summary.entries[0].dispatch).toBe('dispatched');
    });

    it('emits task_run_no_agent (never silently skips) when nothing resolves', async () => {
        const template = makeTemplate();
        tasks.findDueRecurringTemplates.mockResolvedValueOnce([template]);
        tasks.create.mockResolvedValueOnce({
            id: 'inst-1',
            slug: 'T-42',
            userId: 'u1',
            title: 'Daily standup',
            agentId: null,
        });

        const summary = await svc.dispatchDue();

        expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
        expect(summary.entries[0].dispatch).toBe('no-agent');
        expect(notifications.emit).toHaveBeenCalledWith(
            'task_run_no_agent',
            expect.objectContaining({ taskId: 'inst-1' }),
            ['u1'],
        );
    });

    describe('dispatchDueScheduled (one-shot)', () => {
        function makeScheduled(over: Partial<Task> = {}): Task {
            return {
                ...makeTemplate({ isRecurring: false, recurrenceRule: null }),
                id: 'sched-1',
                slug: 'T-7',
                status: TaskStatus.BACKLOG,
                nextOccurrenceAt: null,
                scheduledAt: new Date('2026-08-14T09:00:00Z'),
                scheduleClaimedAt: null,
                agentId: 'agent-1',
                ...over,
            } as Task;
        }

        it('returns empty summary when nothing is due', async () => {
            const summary = await svc.dispatchDueScheduled();
            expect(summary.dueCount).toBe(0);
            expect(summary.dispatched).toBe(0);
        });

        it('claims a due one-shot and dispatches it (backlog promoted to todo)', async () => {
            const task = makeScheduled();
            tasks.findDueScheduledTasks.mockResolvedValueOnce([task]);

            const summary = await svc.dispatchDueScheduled();

            expect(tasks.casClaimSchedule).toHaveBeenCalledWith(
                'sched-1',
                task.scheduledAt,
                expect.any(Date),
            );
            expect(tasks.casUpdateStatus).toHaveBeenCalledWith('sched-1', TaskStatus.BACKLOG, {
                status: TaskStatus.TODO,
            });
            expect(transitions.dispatchAgentRun).toHaveBeenCalledWith(
                task,
                'agent-1',
                expect.anything(),
            );
            expect(summary.dispatched).toBe(1);
            expect(summary.entries[0].outcome).toBe('dispatched');
        });

        it('CAS-claim loss → outcome=skipped, no dispatch', async () => {
            tasks.findDueScheduledTasks.mockResolvedValueOnce([makeScheduled()]);
            tasks.casClaimSchedule.mockResolvedValueOnce(false);

            const summary = await svc.dispatchDueScheduled();

            expect(summary.skipped).toBe(1);
            expect(transitions.dispatchAgentRun).not.toHaveBeenCalled();
        });

        it('no resolvable agent → outcome=no-agent + notification, never a throw', async () => {
            tasks.findDueScheduledTasks.mockResolvedValueOnce([makeScheduled({ agentId: null })]);

            const summary = await svc.dispatchDueScheduled();

            expect(summary.noAgent).toBe(1);
            expect(summary.entries[0].outcome).toBe('no-agent');
            expect(notifications.emit).toHaveBeenCalledWith(
                'task_run_no_agent',
                expect.objectContaining({ taskId: 'sched-1' }),
                ['u1'],
            );
        });

        it('one failing task does not cascade to the rest', async () => {
            const a = makeScheduled({ id: 'a' });
            const b = makeScheduled({ id: 'b' });
            tasks.findDueScheduledTasks.mockResolvedValueOnce([a, b]);
            tasks.casClaimSchedule
                .mockRejectedValueOnce(new Error('boom'))
                .mockResolvedValueOnce(true);

            const summary = await svc.dispatchDueScheduled();

            expect(summary.failed).toBe(1);
            expect(summary.dispatched).toBe(1);
        });
    });
});
