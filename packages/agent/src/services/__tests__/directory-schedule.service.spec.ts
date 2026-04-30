jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { DirectoryScheduleService } from '../directory-schedule.service';
import { ImportSourceTypeEnum } from '@src/dto/import-directory.dto';
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';

describe('DirectoryScheduleService', () => {
    const user = { id: 'user-1' } as any;
    const directory = { id: 'dir-1', sourceRepository: null } as any;
    const originalScheduledUpdatesEnabled = process.env.SCHEDULED_UPDATES_ENABLED;

    const restoreScheduledUpdatesEnabled = () => {
        if (originalScheduledUpdatesEnabled === undefined) {
            delete process.env.SCHEDULED_UPDATES_ENABLED;
            return;
        }

        process.env.SCHEDULED_UPDATES_ENABLED = originalScheduledUpdatesEnabled;
    };

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
        restoreScheduledUpdatesEnabled();

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
            getCadenceAllowances: jest
                .fn()
                .mockResolvedValue([{ cadence: DirectoryScheduleCadence.DAILY, allowed: true }]),
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
            get: jest.fn((pluginId: string) =>
                ['openrouter', 'agent-pipeline'].includes(pluginId)
                    ? { id: pluginId, state: 'loaded' }
                    : null,
            ),
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

    afterAll(() => {
        restoreScheduledUpdatesEnabled();
    });

    it('returns readiness metadata instead of throwing when initial setup is incomplete', async () => {
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);
        dataGeneratorService.getConfig.mockResolvedValue({
            metadata: {},
        });

        const result = await service.getSchedule(directory.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: DirectoryScheduleStatus.DISABLED,
                featureEnabled: true,
                canEnable: false,
                blockingCode: 'INITIAL_DIRECTORY_SETUP_REQUIRED',
                blockingReason:
                    'Complete an initial directory setup before enabling scheduled updates.',
            }),
        );
    });

    it('returns feature-disabled metadata when scheduled updates are turned off globally', async () => {
        process.env.SCHEDULED_UPDATES_ENABLED = 'false';
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);

        const result = await service.getSchedule(directory.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: DirectoryScheduleStatus.DISABLED,
                featureEnabled: false,
                canEnable: false,
                blockingCode: 'SCHEDULED_UPDATES_DISABLED',
                blockingReason: 'Scheduled updates are currently disabled.',
            }),
        );
    });

    it('does not allow scheduled source sync for linked existing directories', async () => {
        const linkedDirectory = {
            ...directory,
            sourceRepository: {
                type: ImportSourceTypeEnum.LINK_EXISTING,
            },
        };

        ownershipService.ensureCanView.mockResolvedValue({ directory: linkedDirectory });
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);

        const result = await service.getSchedule(directory.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: DirectoryScheduleStatus.DISABLED,
                featureEnabled: true,
                canEnable: false,
                blockingCode: 'SOURCE_SYNC_UNSUPPORTED',
                blockingReason:
                    'Linked directories use existing repositories directly and cannot be synced from an import source.',
            }),
        );
    });

    it('rejects enabling scheduled source sync for linked existing directories', async () => {
        const linkedDirectory = {
            ...directory,
            sourceRepository: {
                type: ImportSourceTypeEnum.LINK_EXISTING,
            },
        };

        ownershipService.ensureCanEdit.mockResolvedValue({ directory: linkedDirectory });
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);

        await expect(
            service.updateSchedule(
                directory.id,
                {
                    enable: true,
                    cadence: DirectoryScheduleCadence.DAILY,
                },
                user,
            ),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                code: 'SOURCE_SYNC_UNSUPPORTED',
            }),
        });
    });

    it('returns config-unavailable metadata when readiness inspection fails', async () => {
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);
        dataGeneratorService.getConfig.mockRejectedValue(new Error('repository unavailable'));

        const result = await service.getSchedule(directory.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: DirectoryScheduleStatus.DISABLED,
                featureEnabled: true,
                canEnable: false,
                blockingCode: 'CONFIG_UNAVAILABLE',
                blockingReason:
                    'Schedule readiness could not be checked right now. Try again in a moment.',
            }),
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

    it('restores provider overrides from imported works config for any source type', async () => {
        const directoryWithWorksConfig = {
            ...directory,
            sourceRepository: {
                type: 'data_repo',
                worksConfig: {
                    providers: {
                        ai: 'openrouter',
                        pipeline: 'agent-pipeline',
                    },
                },
            },
        };
        ownershipService.ensureCanEdit.mockResolvedValue({ directory: directoryWithWorksConfig });
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);
        scheduleRepository.upsert.mockResolvedValue({
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt: new Date('2026-04-08T12:47:00.000Z'),
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: {
                ai: 'openrouter',
                pipeline: 'agent-pipeline',
            },
        });

        await service.updateSchedule(
            directory.id,
            {
                enable: true,
                cadence: DirectoryScheduleCadence.DAILY,
                billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 3,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                providerOverrides: {
                    ai: 'openrouter',
                    pipeline: 'agent-pipeline',
                },
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

    it('defaults provider overrides from imported works.yml config when enabling schedule', async () => {
        const worksConfigDirectory = {
            ...directory,
            sourceRepository: {
                type: 'works_config',
                worksConfig: {
                    providers: {
                        ai: 'openrouter',
                        pipeline: 'agent-pipeline',
                    },
                },
            },
        };

        ownershipService.ensureCanEdit.mockResolvedValue({ directory: worksConfigDirectory });
        scheduleRepository.findByDirectoryId.mockResolvedValue(null);
        scheduleRepository.upsert.mockResolvedValue({
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.DAILY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            providerOverrides: {
                ai: 'openrouter',
                pipeline: 'agent-pipeline',
            },
        });

        await service.updateSchedule(
            directory.id,
            {
                enable: true,
                cadence: DirectoryScheduleCadence.DAILY,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                providerOverrides: {
                    ai: 'openrouter',
                    pipeline: 'agent-pipeline',
                },
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
                lastRunStatus: null,
            }),
        );
        expect(directoryRepository.update).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                scheduledNextRunAt: nextRunAt,
            }),
        );
    });

    it('does not let a manual early failure suppress a later scheduled failure', async () => {
        const futureNextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const manualRunSchedule = {
            id: 'schedule-1',
            directoryId: directory.id,
            userId: user.id,
            cadence: DirectoryScheduleCadence.HOURLY,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            status: DirectoryScheduleStatus.ACTIVE,
            nextRunAt: futureNextRunAt,
            scheduledFor: null,
            failureCount: 2,
            maxFailureBeforePause: 3,
        };
        const scheduledRunSchedule = {
            ...manualRunSchedule,
            nextRunAt: null,
            scheduledFor: new Date(Date.now() - 60 * 1000),
            lastRunStatus: null,
            lastRunAt: new Date(),
        };

        scheduleRepository.findById
            .mockResolvedValueOnce(manualRunSchedule)
            .mockResolvedValueOnce(scheduledRunSchedule);

        await service.markRunFailed(manualRunSchedule.id, 'manual run failed');
        await service.markRunFailed(scheduledRunSchedule.id, 'scheduled run failed');

        expect(scheduleRepository.updateById).toHaveBeenNthCalledWith(
            1,
            manualRunSchedule.id,
            expect.objectContaining({
                failureCount: 2,
                lastRunStatus: null,
                nextRunAt: futureNextRunAt,
            }),
        );
        expect(scheduleRepository.updateById).toHaveBeenNthCalledWith(
            2,
            scheduledRunSchedule.id,
            expect.objectContaining({
                failureCount: 3,
                lastRunStatus: GenerateStatusType.ERROR,
                status: DirectoryScheduleStatus.PAUSED,
            }),
        );
    });
});
