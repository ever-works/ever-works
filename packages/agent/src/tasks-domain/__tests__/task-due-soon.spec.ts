import { BadRequestException, ConflictException } from '@nestjs/common';
import { TaskRecurrenceDispatcherService } from '../task-recurrence-dispatcher.service';
import { TasksService } from '../tasks.service';
import { TaskStatus } from '../../entities/task.entity';

/**
 * EW-P2-3 — task dates + estimate.
 *
 *  - `notifyDueSoon` claims each Task in the window once and notifies its
 *    owner + user assignees (watchers are added by the notification service);
 *    a lost claim notifies nobody; a failure is counted, never thrown.
 *  - `TasksService` validates the planning fields against the row as it will
 *    be after the patch, and a moved due date re-arms the notice.
 */
describe('TaskRecurrenceDispatcherService.notifyDueSoon', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const dueAt = new Date('2026-10-16T20:00:00Z');
    const task = { id: 't1', slug: 'T-1', title: 'Ship it', userId: 'owner', dueAt };

    function build(claimed = true) {
        const tasks = {
            findDueSoonTasks: jest.fn().mockResolvedValue([task]),
            casClaimDueSoon: jest.fn().mockResolvedValue(claimed),
            releaseDueSoonClaim: jest.fn().mockResolvedValue(true),
        };
        const notifications = {
            canDeliver: jest.fn().mockReturnValue(true),
            emitCounted: jest.fn().mockResolvedValue({ sent: 2, recipients: 2 }),
        };
        const assignees = {
            findByTaskId: jest.fn().mockResolvedValue([
                { assigneeType: 'user', assigneeId: 'u-2' },
                { assigneeType: 'agent', assigneeId: 'a-1' },
                { assigneeType: 'user', assigneeId: 'owner' },
            ]),
        };
        const svc = new TaskRecurrenceDispatcherService(
            tasks as never,
            {} as never,
            notifications as never,
            assignees as never,
        );
        return { svc, tasks, notifications };
    }

    it('scans the next 24 hours, claims, and notifies the owner and user assignees once', async () => {
        const { svc, tasks, notifications } = build();
        const summary = await svc.notifyDueSoon(100, now);
        expect(tasks.findDueSoonTasks).toHaveBeenCalledWith(
            100,
            now,
            new Date('2026-10-17T10:00:00Z'),
        );
        expect(tasks.casClaimDueSoon).toHaveBeenCalledWith('t1', dueAt, now);
        expect(notifications.emitCounted).toHaveBeenCalledWith(
            'task_due_soon',
            expect.objectContaining({
                taskId: 't1',
                taskSlug: 'T-1',
                extra: { dueAt: dueAt.toISOString() },
            }),
            ['owner', 'u-2'],
        );
        expect(summary).toMatchObject({
            dueCount: 1,
            notified: 1,
            skipped: 0,
            failed: 0,
            windowHours: 24,
        });
    });

    it('a lost claim notifies nobody', async () => {
        const { svc, notifications } = build(false);
        const summary = await svc.notifyDueSoon(100, now);
        expect(notifications.emitCounted).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ notified: 0, skipped: 1 });
    });

    it('a failure is counted, never thrown, and gives the claim back for a retry', async () => {
        const { svc, tasks, notifications } = build();
        notifications.emitCounted.mockRejectedValueOnce(new Error('down'));
        await expect(svc.notifyDueSoon(100, now)).resolves.toMatchObject({
            failed: 1,
            notified: 0,
        });
        expect(tasks.releaseDueSoonClaim).toHaveBeenCalledWith('t1', now);
    });

    it('a partial delivery releases the claim too (dedup per deadline keeps the retry idempotent)', async () => {
        const { svc, tasks, notifications } = build();
        notifications.emitCounted.mockResolvedValueOnce({ sent: 1, recipients: 2 });
        await expect(svc.notifyDueSoon(100, now)).resolves.toMatchObject({
            failed: 1,
            notified: 0,
        });
        expect(tasks.releaseDueSoonClaim).toHaveBeenCalledWith('t1', now);
    });

    it('does not scan at all when no notice can be delivered', async () => {
        const { svc, tasks, notifications } = build();
        notifications.canDeliver.mockReturnValue(false);
        await expect(svc.notifyDueSoon(100, now)).resolves.toMatchObject({ dueCount: 0 });
        expect(tasks.findDueSoonTasks).not.toHaveBeenCalled();
        expect(tasks.casClaimDueSoon).not.toHaveBeenCalled();
    });
});

describe('TasksService planning fields', () => {
    const base = {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'T',
        status: TaskStatus.TODO,
        workId: null,
        dueAt: new Date('2026-10-20T23:59:59Z'),
        startAt: new Date('2026-10-18T00:00:00Z'),
        estimateMinutes: 60,
        dueSoonNotifiedAt: new Date('2026-10-19T00:00:00Z'),
    };

    function build() {
        const tasks = {
            findByIdAndUser: jest.fn().mockResolvedValue({ ...base }),
            updateById: jest.fn().mockResolvedValue(undefined),
            updateByIdIfUnchanged: jest.fn().mockResolvedValue(true),
        };
        const service = new TasksService(
            tasks as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        return { service, tasks };
    }

    it('refuses a start after the due date, judged on the post-patch row', async () => {
        const { service } = build();
        await expect(
            service.update('u1', 't1', { startAt: new Date('2026-10-25T00:00:00Z') }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an estimate that is not whole minutes in 0..525600', async () => {
        const { service } = build();
        for (const estimateMinutes of [-1, 1.5, 525601]) {
            await expect(service.update('u1', 't1', { estimateMinutes })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        }
    });

    it('a moved due date re-arms the due-soon notice; the same date does not', async () => {
        const { service, tasks } = build();
        await service.update('u1', 't1', { dueAt: new Date('2026-10-22T23:59:59Z') });
        expect(tasks.updateByIdIfUnchanged.mock.calls[0][1]).toMatchObject({
            dueAt: new Date('2026-10-22T23:59:59Z'),
            dueSoonNotifiedAt: null,
        });
        await service.update('u1', 't1', { dueAt: new Date('2026-10-20T23:59:59Z') });
        expect(tasks.updateByIdIfUnchanged.mock.calls[1][1]).not.toHaveProperty(
            'dueSoonNotifiedAt',
        );
    });

    it('moving one end guards the write on the other end (no racing PATCH can invert the pair)', async () => {
        const { service, tasks } = build();
        await service.update('u1', 't1', { startAt: new Date('2026-10-19T00:00:00Z') });
        expect(tasks.updateByIdIfUnchanged.mock.calls[0][2]).toEqual({
            field: 'dueAt',
            expected: base.dueAt,
        });
        await service.update('u1', 't1', { dueAt: new Date('2026-10-21T00:00:00Z') });
        expect(tasks.updateByIdIfUnchanged.mock.calls[1][2]).toEqual({
            field: 'startAt',
            expected: base.startAt,
        });
        // Both ends together (or a clear) need no guard.
        await service.update('u1', 't1', { estimateMinutes: 30 });
        expect(tasks.updateById).toHaveBeenCalledTimes(1);
    });

    it('a lost guard answers 409 so the caller re-reads', async () => {
        const { service, tasks } = build();
        tasks.updateByIdIfUnchanged.mockResolvedValueOnce(false);
        await expect(
            service.update('u1', 't1', { startAt: new Date('2026-10-19T00:00:00Z') }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('clears dates and the estimate with null', async () => {
        const { service, tasks } = build();
        await service.update('u1', 't1', { dueAt: null, startAt: null, estimateMinutes: null });
        expect(tasks.updateById.mock.calls[0][1]).toMatchObject({
            dueAt: null,
            startAt: null,
            estimateMinutes: null,
            dueSoonNotifiedAt: null,
        });
    });
});
