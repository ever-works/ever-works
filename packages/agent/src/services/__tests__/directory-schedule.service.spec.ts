jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { DirectoryScheduleService } from '../directory-schedule.service';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';

describe('DirectoryScheduleService', () => {
    const user = { id: 'user-1' } as any;
    const directory = { id: 'dir-1', sourceRepository: null } as any;

    let scheduleRepository: any;
    let directoryRepository: any;
    let ownershipService: any;
    let subscriptionService: any;
    let usageLedgerService: any;
    let dataGeneratorService: any;
    let pluginRegistry: any;
    let notificationService: any;
    let service: DirectoryScheduleService;

    beforeEach(() => {
        scheduleRepository = {
            findByDirectoryId: jest.fn(),
            upsert: jest.fn(),
            findById: jest.fn(),
            updateById: jest.fn(),
            countActiveByUser: jest.fn().mockResolvedValue(0),
        };
        directoryRepository = {
            update: jest.fn(),
            findById: jest.fn(),
        };
        ownershipService = {
            ensureCanEdit: jest.fn().mockResolvedValue({ directory }),
            ensureCanView: jest.fn().mockResolvedValue({ directory }),
        };
        subscriptionService = {
            isEnabled: jest.fn().mockReturnValue(false),
            resolvePlanForUser: jest.fn().mockResolvedValue({
                code: 'free',
                displayName: 'Free',
                maxDirectories: 10,
            }),
            getCadenceAllowances: jest.fn().mockResolvedValue([
                { cadence: DirectoryScheduleCadence.DAILY, allowed: true },
            ]),
            getDefaultCadence: jest.fn().mockReturnValue(DirectoryScheduleCadence.DAILY),
            requiresUsageBilling: jest.fn().mockReturnValue(false),
        };
        usageLedgerService = {
            recordUsage: jest.fn().mockResolvedValue(null),
        };
        dataGeneratorService = {
            getConfig: jest.fn().mockResolvedValue({
                metadata: {
                    last_request_data: { prompt: 'hello' },
                },
            }),
        };
        pluginRegistry = {
            get: jest.fn(),
        };
        notificationService = {
            notifySchedulePaused: jest.fn(),
        };

        service = new DirectoryScheduleService(
            scheduleRepository,
            directoryRepository,
            ownershipService,
            subscriptionService,
            usageLedgerService,
            dataGeneratorService,
            pluginRegistry,
            notificationService,
        );
    });

    it('preserves nextRunAt when saving an already-active schedule without changing cadence', async () => {
        const nextRunAt = new Date('2026-04-08T12:47:00.000Z');
        const existing = {
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt,
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        };

        scheduleRepository.findByDirectoryId.mockResolvedValue(existing);
        scheduleRepository.upsert.mockResolvedValue(existing);

        await service.updateSchedule(
            directory.id,
            {
                enable: true,
                cadence: DirectoryScheduleCadence.DAILY,
                billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 5,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                nextRunAt,
                maxFailureBeforePause: 5,
            }),
        );
    });

    it('recalculates nextRunAt when the cadence changes on an active schedule', async () => {
        const nextRunAt = new Date('2026-04-08T12:47:00.000Z');
        const existing = {
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt,
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        };
        const recalculated = new Date('2026-04-15T12:47:00.000Z');

        jest.spyOn(service, 'calculateNextRun').mockReturnValue(recalculated);
        scheduleRepository.findByDirectoryId.mockResolvedValue(existing);
        scheduleRepository.upsert.mockResolvedValue({
            ...existing,
            cadence: DirectoryScheduleCadence.WEEKLY,
            nextRunAt: recalculated,
        });

        await service.updateSchedule(
            directory.id,
            {
                enable: true,
                cadence: DirectoryScheduleCadence.WEEKLY,
                billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 3,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                nextRunAt: recalculated,
                cadence: DirectoryScheduleCadence.WEEKLY,
            }),
        );
    });

    it('keeps the upcoming run when a manual early run completes', async () => {
        const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const schedule = {
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.USAGE,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt,
            scheduledFor: null,
            failureCount: 2,
        };

        scheduleRepository.findById.mockResolvedValue(schedule);

        await service.markRunCompleted({
            scheduleId: schedule.id,
            historyId: 'history-1',
            status: GenerateStatusType.GENERATED,
        });

        expect(scheduleRepository.updateById).toHaveBeenCalledWith(
            schedule.id,
            expect.objectContaining({
                nextRunAt,
                failureCount: 0,
                lastRunStatus: GenerateStatusType.GENERATED,
            }),
        );
        expect(usageLedgerService.recordUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                directoryId: directory.id,
                generationHistoryId: 'history-1',
            }),
        );
    });

    it('keeps the upcoming run and does not increment failures for a manual early failure', async () => {
        const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const schedule = {
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt,
            scheduledFor: null,
            failureCount: 2,
            maxFailureBeforePause: 3,
        };

        scheduleRepository.findById.mockResolvedValue(schedule);

        await service.markRunFailed(schedule.id, 'manual test failed');

        expect(scheduleRepository.updateById).toHaveBeenCalledWith(
            schedule.id,
            expect.objectContaining({
                nextRunAt,
                failureCount: 2,
                status: DirectoryScheduleStatus.ACTIVE,
                lastRunStatus: GenerateStatusType.ERROR,
            }),
        );
        expect(directoryRepository.update).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                scheduledNextRunAt: nextRunAt,
            }),
        );
    });
});
