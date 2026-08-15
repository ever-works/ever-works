import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';

/**
 * Schedule-modes upgrade — TasksService coverage:
 *
 *   - `scheduleTask` / `unscheduleTask` (one-shot mode)
 *   - `setRecurring` cron XOR RRULE validation matrix
 *   - `create` with `scheduledAt`
 */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'T-1',
        title: 'Ship the task feature',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'user-1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceRule: null,
        recurrenceCron: null,
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: null,
        scheduledAt: null,
        scheduleClaimedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

function makeService() {
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
        },
        assignees: {},
        reviewers: {},
        approvers: {},
        blocks: {},
        relations: {},
        counter: { nextSlug: jest.fn().mockResolvedValue(1) },
        transitions: {},
    };
    const service = new TasksService(
        repos.tasks as any,
        repos.assignees as any,
        repos.reviewers as any,
        repos.approvers as any,
        repos.blocks as any,
        repos.relations as any,
        repos.counter as any,
        repos.transitions as any,
    );
    return { service, repos };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

describe('TasksService.scheduleTask / unscheduleTask', () => {
    it('schedules a future one-shot and clears any stale claim', async () => {
        const { service, repos } = makeService();
        const task = makeTask({ scheduleClaimedAt: new Date() });
        repos.tasks.findByIdAndUser.mockResolvedValue(task);
        repos.tasks.findById.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));

        const out = await service.scheduleTask('user-1', 'task-1', FUTURE);

        expect(repos.tasks.updateById).toHaveBeenCalledWith('task-1', {
            scheduledAt: FUTURE,
            scheduleClaimedAt: null,
        });
        expect(out.scheduledAt).toEqual(FUTURE);
    });

    it('rejects a past runAt', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());

        await expect(service.scheduleTask('user-1', 'task-1', PAST)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('rejects an invalid datetime', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());

        await expect(
            service.scheduleTask('user-1', 'task-1', new Date('garbage')),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to schedule a recurring template', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ isRecurring: true, recurrenceRule: 'FREQ=DAILY' }),
        );

        await expect(service.scheduleTask('user-1', 'task-1', FUTURE)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('404s cross-user (no existence leak)', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(null);

        await expect(service.scheduleTask('user-1', 'foreign', FUTURE)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('unschedule clears both schedule columns', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));
        repos.tasks.findById.mockResolvedValue(makeTask());

        await service.unscheduleTask('user-1', 'task-1');

        expect(repos.tasks.updateById).toHaveBeenCalledWith('task-1', {
            scheduledAt: null,
            scheduleClaimedAt: null,
        });
    });
});

describe('TasksService.create with scheduledAt', () => {
    it('persists a future scheduledAt', async () => {
        const { service, repos } = makeService();
        repos.tasks.create.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));

        await service.create('user-1', {
            title: 'Scheduled task',
            createdByType: 'user',
            createdById: 'user-1',
            scheduledAt: FUTURE,
        });

        expect(repos.tasks.create).toHaveBeenCalledWith(
            expect.objectContaining({ scheduledAt: FUTURE, scheduleClaimedAt: null }),
        );
    });

    it('rejects a past scheduledAt at create', async () => {
        const { service, repos } = makeService();

        await expect(
            service.create('user-1', {
                title: 'Scheduled task',
                createdByType: 'user',
                createdById: 'user-1',
                scheduledAt: PAST,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });
});

describe('TasksService.setRecurring — cron XOR RRULE matrix', () => {
    function arm() {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findById.mockResolvedValue(makeTask({ isRecurring: true }));
        return { service, repos };
    }

    it('accepts an RRULE alone', async () => {
        const { service, repos } = arm();
        await service.setRecurring('user-1', 'task-1', { recurrenceRule: 'FREQ=DAILY' });
        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({
                isRecurring: true,
                recurrenceRule: 'FREQ=DAILY',
                recurrenceCron: null,
                nextOccurrenceAt: expect.any(Date),
            }),
        );
    });

    it('accepts a cron expression alone', async () => {
        const { service, repos } = arm();
        await service.setRecurring('user-1', 'task-1', { recurrenceCron: '0 9 * * *' });
        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({
                isRecurring: true,
                recurrenceRule: null,
                recurrenceCron: '0 9 * * *',
                nextOccurrenceAt: expect.any(Date),
            }),
        );
    });

    it('rejects BOTH provided (XOR)', async () => {
        const { service, repos } = arm();
        await expect(
            service.setRecurring('user-1', 'task-1', {
                recurrenceRule: 'FREQ=DAILY',
                recurrenceCron: '0 9 * * *',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('rejects NEITHER provided (XOR)', async () => {
        const { service } = arm();
        await expect(service.setRecurring('user-1', 'task-1', {})).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('rejects an invalid cron expression', async () => {
        const { service } = arm();
        await expect(
            service.setRecurring('user-1', 'task-1', { recurrenceCron: 'not a cron' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid RRULE', async () => {
        const { service } = arm();
        await expect(
            service.setRecurring('user-1', 'task-1', { recurrenceRule: 'GARBAGE' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('clearRecurring wipes BOTH cadence dialects', async () => {
        const { service, repos } = arm();
        await service.clearRecurring('user-1', 'task-1');
        expect(repos.tasks.updateById).toHaveBeenCalledWith('task-1', {
            isRecurring: false,
            recurrenceRule: null,
            recurrenceCron: null,
            nextOccurrenceAt: null,
            recurrenceEndsAt: null,
            recurrenceMaxOccurrences: null,
        });
    });
});
