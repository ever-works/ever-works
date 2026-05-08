jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { WorkScheduleService } from '../work-schedule.service';
import { ImportSourceTypeEnum } from '@src/dto/import-work.dto';
import {
    WorkScheduleBillingMode,
    WorkScheduleCadence,
    WorkScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';

describe('WorkScheduleService', () => {
    const user = { id: 'user-1' } as any;
    const work = { id: 'dir-1', sourceRepository: null } as any;
    const originalScheduledUpdatesEnabled = process.env.SCHEDULED_UPDATES_ENABLED;

    const restoreScheduledUpdatesEnabled = () => {
        if (originalScheduledUpdatesEnabled === undefined) {
            delete process.env.SCHEDULED_UPDATES_ENABLED;
            return;
        }

        process.env.SCHEDULED_UPDATES_ENABLED = originalScheduledUpdatesEnabled;
    };

    let scheduleRepository: any;
    let workRepository: any;
    let ownershipService: any;
    let subscriptionService: any;
    let usageLedgerService: any;
    let dataGeneratorService: any;
    let pluginRegistry: any;
    let notificationService: any;
    let service: WorkScheduleService;

    beforeEach(() => {
        restoreScheduledUpdatesEnabled();

        scheduleRepository = {
            findByWorkId: jest.fn(),
            upsert: jest.fn(),
            findById: jest.fn(),
            updateById: jest.fn(),
            countActiveByUser: jest.fn().mockResolvedValue(0),
        };
        workRepository = {
            update: jest.fn(),
            findById: jest.fn(),
        };
        ownershipService = {
            ensureCanEdit: jest.fn().mockResolvedValue({ work }),
            ensureCanView: jest.fn().mockResolvedValue({ work }),
        };
        subscriptionService = {
            isEnabled: jest.fn().mockReturnValue(false),
            resolvePlanForUser: jest.fn().mockResolvedValue({
                code: 'free',
                displayName: 'Free',
                maxWorks: 10,
            }),
            getCadenceAllowances: jest
                .fn()
                .mockResolvedValue([{ cadence: WorkScheduleCadence.DAILY, allowed: true }]),
            getDefaultCadence: jest.fn().mockReturnValue(WorkScheduleCadence.DAILY),
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

        service = new WorkScheduleService(
            scheduleRepository,
            workRepository,
            ownershipService,
            subscriptionService,
            usageLedgerService,
            dataGeneratorService,
            pluginRegistry,
            notificationService,
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    afterAll(() => {
        restoreScheduledUpdatesEnabled();
    });

    it('returns readiness metadata instead of throwing when initial setup is incomplete', async () => {
        scheduleRepository.findByWorkId.mockResolvedValue(null);
        dataGeneratorService.getConfig.mockResolvedValue({
            metadata: {},
        });

        const result = await service.getSchedule(work.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: WorkScheduleStatus.DISABLED,
                featureEnabled: true,
                canEnable: false,
                blockingCode: 'INITIAL_WORK_SETUP_REQUIRED',
                blockingReason: 'Complete an initial work setup before enabling scheduled updates.',
            }),
        );
    });

    it('returns feature-disabled metadata when scheduled updates are turned off globally', async () => {
        process.env.SCHEDULED_UPDATES_ENABLED = 'false';
        scheduleRepository.findByWorkId.mockResolvedValue(null);

        const result = await service.getSchedule(work.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: WorkScheduleStatus.DISABLED,
                featureEnabled: false,
                canEnable: false,
                blockingCode: 'SCHEDULED_UPDATES_DISABLED',
                blockingReason: 'Scheduled updates are currently disabled.',
            }),
        );
    });

    it('allows linked existing works to schedule from saved generator config', async () => {
        const linkedWork = {
            ...work,
            sourceRepository: {
                type: ImportSourceTypeEnum.LINK_EXISTING,
            },
        };

        ownershipService.ensureCanView.mockResolvedValue({ work: linkedWork });
        scheduleRepository.findByWorkId.mockResolvedValue(null);

        const result = await service.getSchedule(work.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: WorkScheduleStatus.DISABLED,
                featureEnabled: true,
                canEnable: true,
            }),
        );
    });

    it('enables schedules for linked existing works with saved generator config', async () => {
        const linkedWork = {
            ...work,
            sourceRepository: {
                type: ImportSourceTypeEnum.LINK_EXISTING,
            },
        };

        ownershipService.ensureCanEdit.mockResolvedValue({ work: linkedWork });
        scheduleRepository.findByWorkId.mockResolvedValue(null);

        scheduleRepository.upsert.mockResolvedValue({
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: new Date('2026-04-08T12:47:00.000Z'),
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        });

        await service.updateSchedule(
            work.id,
            {
                enable: true,
                cadence: WorkScheduleCadence.DAILY,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                status: WorkScheduleStatus.ACTIVE,
                cadence: WorkScheduleCadence.DAILY,
            }),
        );
    });

    it('requires saved generator config before scheduling linked existing works', async () => {
        const linkedWork = {
            ...work,
            sourceRepository: {
                type: ImportSourceTypeEnum.LINK_EXISTING,
            },
        };

        ownershipService.ensureCanEdit.mockResolvedValue({ work: linkedWork });
        scheduleRepository.findByWorkId.mockResolvedValue(null);
        dataGeneratorService.getConfig.mockResolvedValue({
            metadata: {},
        });

        await expect(
            service.updateSchedule(
                work.id,
                {
                    enable: true,
                    cadence: WorkScheduleCadence.DAILY,
                },
                user,
            ),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                code: 'INITIAL_WORK_SETUP_REQUIRED',
            }),
        });
    });

    it('returns config-unavailable metadata when readiness inspection fails', async () => {
        scheduleRepository.findByWorkId.mockResolvedValue(null);
        dataGeneratorService.getConfig.mockRejectedValue(new Error('repository unavailable'));

        const result = await service.getSchedule(work.id, user);

        expect(result.schedule).toEqual(
            expect.objectContaining({
                status: WorkScheduleStatus.DISABLED,
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
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt,
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        };

        scheduleRepository.findByWorkId.mockResolvedValue(existing);
        scheduleRepository.upsert.mockResolvedValue(existing);

        await service.updateSchedule(
            work.id,
            {
                enable: true,
                cadence: WorkScheduleCadence.DAILY,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 5,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                nextRunAt,
                maxFailureBeforePause: 5,
            }),
        );
    });

    it('restores provider overrides from imported works config for any source type', async () => {
        const workWithWorksConfig = {
            ...work,
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
        ownershipService.ensureCanEdit.mockResolvedValue({ work: workWithWorksConfig });
        scheduleRepository.findByWorkId.mockResolvedValue(null);
        scheduleRepository.upsert.mockResolvedValue({
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: new Date('2026-04-08T12:47:00.000Z'),
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: {
                ai: 'openrouter',
                pipeline: 'agent-pipeline',
            },
        });

        await service.updateSchedule(
            work.id,
            {
                enable: true,
                cadence: WorkScheduleCadence.DAILY,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 3,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            work.id,
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
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt,
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        };
        const recalculated = new Date('2026-04-15T12:47:00.000Z');

        jest.spyOn(service, 'calculateNextRun').mockReturnValue(recalculated);
        scheduleRepository.findByWorkId.mockResolvedValue(existing);
        scheduleRepository.upsert.mockResolvedValue({
            ...existing,
            cadence: WorkScheduleCadence.WEEKLY,
            nextRunAt: recalculated,
        });

        await service.updateSchedule(
            work.id,
            {
                enable: true,
                cadence: WorkScheduleCadence.WEEKLY,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
                maxFailureBeforePause: 3,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                nextRunAt: recalculated,
                cadence: WorkScheduleCadence.WEEKLY,
            }),
        );
    });

    it('reschedules completed scheduled runs from scheduledFor to avoid drift', async () => {
        const scheduledFor = new Date(Date.now() - 60 * 1000);
        const expectedNextRunAt = new Date(scheduledFor);
        expectedNextRunAt.setDate(expectedNextRunAt.getDate() + 1);
        const schedule = {
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: null,
            scheduledFor,
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
                lastRunStatus: GenerateStatusType.GENERATED,
                nextRunAt: expectedNextRunAt,
                failureCount: 0,
                scheduledFor: null,
            }),
        );
        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                scheduledUpdatesEnabled: true,
                scheduledNextRunAt: expectedNextRunAt,
                scheduledStatus: WorkScheduleStatus.ACTIVE,
            }),
        );
    });

    it('schedules failed scheduled runs for retry from scheduledFor', async () => {
        const scheduledFor = new Date(Date.now() - 60 * 1000);
        const expectedRetryAt = new Date(scheduledFor.getTime() + 15 * 60 * 1000);
        const schedule = {
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: null,
            scheduledFor,
            failureCount: 1,
            maxFailureBeforePause: 3,
        };

        scheduleRepository.findById.mockResolvedValue(schedule);

        await service.markRunFailed(schedule.id, 'scheduled run failed');

        expect(scheduleRepository.updateById).toHaveBeenCalledWith(
            schedule.id,
            expect.objectContaining({
                failureCount: 2,
                lastRunStatus: GenerateStatusType.ERROR,
                status: WorkScheduleStatus.ACTIVE,
                scheduledFor: null,
                nextRunAt: expectedRetryAt,
            }),
        );
        expect(notificationService.notifySchedulePaused).not.toHaveBeenCalled();
    });

    it('keeps skipped scheduled runs active and retries without incrementing failures', async () => {
        const now = new Date('2026-04-11T15:55:12.034Z');
        const scheduledFor = new Date('2026-04-11T15:54:12.034Z');
        const expectedRetryAt = new Date(now.getTime() + 15 * 60 * 1000);
        const schedule = {
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: null,
            scheduledFor,
            failureCount: 2,
        };

        jest.useFakeTimers().setSystemTime(now);
        scheduleRepository.findById.mockResolvedValue(schedule);

        await service.finalizeScheduleRun(schedule.id, {
            status: 'skipped',
            reason: 'work already generating',
        });

        expect(scheduleRepository.updateById).toHaveBeenCalledWith(
            schedule.id,
            expect.objectContaining({
                lastRunStatus: null,
                nextRunAt: expectedRetryAt,
                scheduledFor: null,
            }),
        );
        expect(scheduleRepository.updateById.mock.calls[0][1]).not.toHaveProperty('failureCount');
    });

    it('defaults provider overrides from imported .works/works.yml config when enabling schedule', async () => {
        const worksConfigWork = {
            ...work,
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

        ownershipService.ensureCanEdit.mockResolvedValue({ work: worksConfigWork });
        scheduleRepository.findByWorkId.mockResolvedValue(null);
        scheduleRepository.upsert.mockResolvedValue({
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
            providerOverrides: {
                ai: 'openrouter',
                pipeline: 'agent-pipeline',
            },
        });

        await service.updateSchedule(
            work.id,
            {
                enable: true,
                cadence: WorkScheduleCadence.DAILY,
            },
            user,
        );

        expect(scheduleRepository.upsert).toHaveBeenCalledWith(
            work.id,
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
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.USAGE,
            status: WorkScheduleStatus.ACTIVE,
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
                workId: work.id,
                generationHistoryId: 'history-1',
            }),
        );
    });

    it('keeps the upcoming run and does not increment failures for a manual early failure', async () => {
        const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const schedule = {
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
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
                status: WorkScheduleStatus.ACTIVE,
                lastRunStatus: null,
            }),
        );
        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                scheduledNextRunAt: nextRunAt,
            }),
        );
    });

    it('does not let a manual early failure suppress a later scheduled failure', async () => {
        const futureNextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const manualRunSchedule = {
            id: 'schedule-1',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.HOURLY,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            status: WorkScheduleStatus.ACTIVE,
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
                status: WorkScheduleStatus.PAUSED,
            }),
        );
    });
});
