jest.mock('../directory-generation.service', () => ({
    DirectoryGenerationService: class DirectoryGenerationService {},
}));

jest.mock('../directory-schedule.service', () => ({
    DirectoryScheduleService: class DirectoryScheduleService {},
}));

import { DirectoryScheduleDispatcherService } from '../directory-schedule-dispatcher.service';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
} from '@src/entities/types';

describe('DirectoryScheduleDispatcherService', () => {
    const originalScheduledUpdatesEnabled = process.env.SCHEDULED_UPDATES_ENABLED;

    let scheduleRepository: {
        findDue: jest.Mock;
    };
    let directoryGenerationService: {
        runScheduledUpdate: jest.Mock;
    };
    let directoryScheduleService: {
        recoverStuckSchedules: jest.Mock;
        markRunDispatched: jest.Mock;
    };
    let service: DirectoryScheduleDispatcherService;

    beforeEach(() => {
        process.env.SCHEDULED_UPDATES_ENABLED = 'true';

        scheduleRepository = {
            findDue: jest.fn(),
        };
        directoryGenerationService = {
            runScheduledUpdate: jest.fn(),
        };
        directoryScheduleService = {
            recoverStuckSchedules: jest.fn().mockResolvedValue(0),
            markRunDispatched: jest.fn(),
        };

        service = new DirectoryScheduleDispatcherService(
            scheduleRepository as any,
            directoryGenerationService as any,
            directoryScheduleService as any,
        );
    });

    afterAll(() => {
        if (originalScheduledUpdatesEnabled === undefined) {
            delete process.env.SCHEDULED_UPDATES_ENABLED;
            return;
        }

        process.env.SCHEDULED_UPDATES_ENABLED = originalScheduledUpdatesEnabled;
    });

    it('recovers stuck schedules before dispatching due schedules', async () => {
        scheduleRepository.findDue.mockResolvedValue([]);

        await service.dispatchDue(10);

        expect(directoryScheduleService.recoverStuckSchedules).toHaveBeenCalledTimes(1);
        expect(scheduleRepository.findDue).toHaveBeenCalledWith(10);
    });

    it('counts already-claimed, skipped, and dispatched schedules separately', async () => {
        const alreadyClaimed = createSchedule('schedule-claimed', 'dir-claimed');
        const skipped = createSchedule('schedule-skipped', 'dir-skipped');
        const dispatched = createSchedule('schedule-dispatched', 'dir-dispatched');

        scheduleRepository.findDue.mockResolvedValue([alreadyClaimed, skipped, dispatched]);
        directoryScheduleService.markRunDispatched
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(skipped)
            .mockResolvedValueOnce(dispatched);
        directoryGenerationService.runScheduledUpdate
            .mockResolvedValueOnce({
                status: 'skipped',
                message: 'directory already generating',
                historyId: 'history-skipped',
            })
            .mockResolvedValueOnce({
                status: 'completed',
                message: 'queued',
                historyId: 'history-dispatched',
            });

        const summary = await service.dispatchDue(25);

        expect(summary).toMatchObject({
            limit: 25,
            dueCount: 3,
            dispatched: 1,
            skipped: 2,
            failed: 0,
        });
        expect(summary.entries).toEqual([
            expect.objectContaining({
                scheduleId: alreadyClaimed.id,
                outcome: 'skipped',
                message: 'Schedule was already dispatched by another worker',
            }),
            expect.objectContaining({
                scheduleId: skipped.id,
                outcome: 'skipped',
                message: 'directory already generating',
                historyId: 'history-skipped',
            }),
            expect.objectContaining({
                scheduleId: dispatched.id,
                outcome: 'dispatched',
                message: 'queued',
                historyId: 'history-dispatched',
            }),
        ]);
        expect(directoryGenerationService.runScheduledUpdate).toHaveBeenCalledTimes(2);
    });

    function createSchedule(id: string, directoryId: string) {
        const scheduledFor = new Date('2026-04-11T15:55:12.034Z');

        return {
            id,
            directoryId,
            userId: 'user-1',
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            scheduledFor,
            nextRunAt: null,
            directory: {
                id: directoryId,
                name: directoryId,
                slug: directoryId,
                owner: 'ever',
                getRepoOwner: () => 'ever',
            },
        };
    }
});
