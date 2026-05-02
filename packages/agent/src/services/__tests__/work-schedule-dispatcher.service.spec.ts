jest.mock('../work-generation.service', () => ({
    WorkGenerationService: class WorkGenerationService {},
}));

jest.mock('../work-schedule.service', () => ({
    WorkScheduleService: class WorkScheduleService {},
}));

import { WorkScheduleDispatcherService } from '../work-schedule-dispatcher.service';
import {
    WorkScheduleBillingMode,
    WorkScheduleCadence,
    WorkScheduleStatus,
} from '@src/entities/types';

describe('WorkScheduleDispatcherService', () => {
    const originalScheduledUpdatesEnabled = process.env.SCHEDULED_UPDATES_ENABLED;

    let scheduleRepository: {
        findDue: jest.Mock;
    };
    let workGenerationService: {
        runScheduledUpdate: jest.Mock;
    };
    let workScheduleService: {
        recoverStuckSchedules: jest.Mock;
        markRunDispatched: jest.Mock;
    };
    let service: WorkScheduleDispatcherService;

    beforeEach(() => {
        process.env.SCHEDULED_UPDATES_ENABLED = 'true';

        scheduleRepository = {
            findDue: jest.fn(),
        };
        workGenerationService = {
            runScheduledUpdate: jest.fn(),
        };
        workScheduleService = {
            recoverStuckSchedules: jest.fn().mockResolvedValue(0),
            markRunDispatched: jest.fn(),
        };

        service = new WorkScheduleDispatcherService(
            scheduleRepository as any,
            workGenerationService as any,
            workScheduleService as any,
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

        expect(workScheduleService.recoverStuckSchedules).toHaveBeenCalledTimes(1);
        expect(scheduleRepository.findDue).toHaveBeenCalledWith(10);
    });

    it('counts already-claimed, skipped, and dispatched schedules separately', async () => {
        const alreadyClaimed = createSchedule('schedule-claimed', 'dir-claimed');
        const skipped = createSchedule('schedule-skipped', 'dir-skipped');
        const dispatched = createSchedule('schedule-dispatched', 'dir-dispatched');

        scheduleRepository.findDue.mockResolvedValue([alreadyClaimed, skipped, dispatched]);
        workScheduleService.markRunDispatched
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(skipped)
            .mockResolvedValueOnce(dispatched);
        workGenerationService.runScheduledUpdate
            .mockResolvedValueOnce({
                status: 'skipped',
                message: 'work already generating',
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
                message: 'work already generating',
                historyId: 'history-skipped',
            }),
            expect.objectContaining({
                scheduleId: dispatched.id,
                outcome: 'dispatched',
                message: 'queued',
                historyId: 'history-dispatched',
            }),
        ]);
        expect(workGenerationService.runScheduledUpdate).toHaveBeenCalledTimes(2);
    });

    function createSchedule(id: string, workId: string) {
        const scheduledFor = new Date('2026-04-11T15:55:12.034Z');

        return {
            id,
            workId,
            userId: 'user-1',
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            scheduledFor,
            nextRunAt: null,
            work: {
                id: workId,
                name: workId,
                slug: workId,
                owner: 'ever',
                getRepoOwner: () => 'ever',
            },
        };
    }
});
