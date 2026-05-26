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
        const template = makeTemplate();
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
            }),
        );
        // CAS-claim advanced nextOccurrenceAt to a future Date.
        const casArgs = tasks.casClaimRecurrence.mock.calls[0];
        expect(casArgs[0]).toBe('tmpl-1');
        expect(casArgs[1]).toEqual(template.nextOccurrenceAt);
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
});
