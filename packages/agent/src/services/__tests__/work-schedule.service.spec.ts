jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { BadRequestException } from '@nestjs/common';
import { WorkScheduleService } from '../work-schedule.service';
import { ImportSourceTypeEnum } from '@src/dto/import-work.dto';
import { REPOSITORY_WORK_REFUSAL } from '@src/works/repository-work-guard';
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
            // EW-761 - every BillingProvider in the tree inherits the no-op
            // `recordUsageCharge`, so "we can bill this run" is FALSE in
            // production. That is the default here too.
            canBillUsage: jest.fn().mockReturnValue(false),
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

    // Self-build slice D (EW-766): the web hides the schedule page for a
    // Repository Work, but `PUT /works/:id/schedule` and the MCP
    // `update_schedule` tool reach this method directly. Both the enable
    // and the pause branch upsert a row and ask WorksConfigWriter to commit
    // `.works/works.yml` into the data repository — the wrapped code repo —
    // so the refusal has to land before either writer is touched.
    it('refuses to create or update a schedule for a Repository Work before any writer runs', async () => {
        const eventEmitter = { emit: jest.fn() };
        const repositoryWork = { ...work, kind: 'repo', name: 'Platform' };
        ownershipService.ensureCanEdit.mockResolvedValue({ work: repositoryWork });
        scheduleRepository.findByWorkId.mockResolvedValue(null);

        const guarded = new WorkScheduleService(
            scheduleRepository,
            workRepository,
            ownershipService,
            subscriptionService,
            usageLedgerService,
            dataGeneratorService,
            pluginRegistry,
            notificationService,
            eventEmitter as any,
        );

        const enableError = await guarded
            .updateSchedule(work.id, { enable: true, cadence: WorkScheduleCadence.DAILY }, user)
            .catch((error) => error);
        expect(enableError).toBeInstanceOf(BadRequestException);
        expect(enableError.message).toContain(REPOSITORY_WORK_REFUSAL);
        expect(enableError.message).toContain('Work "Platform"');

        // The pause branch skips `ensureWorkConfigReady`, so it must be
        // refused by the kind guard itself, not by readiness.
        const pauseError = await guarded
            .updateSchedule(work.id, { enable: false }, user)
            .catch((error) => error);
        expect(pauseError).toBeInstanceOf(BadRequestException);
        expect(pauseError.message).toContain(REPOSITORY_WORK_REFUSAL);

        expect(scheduleRepository.upsert).not.toHaveBeenCalled();
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(dataGeneratorService.getConfig).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    /**
     * EW-761 - validateRunEntitlement is the LAST gate before a scheduled
     * run is allowed to spend money on the platform's inference budget.
     *
     * It used to open with an unconditional
     *   `if (schedule.billingMode === USAGE) return true;`
     * justified by the comment "assuming they can pay". Nothing in the tree
     * can charge a pay-per-use run - `BillingProvider.recordUsageCharge` is
     * a bare `return` on the abstract and neither concrete provider
     * overrides it - so the assumption was false and an unmetered run was
     * silently allowed past the plan's active-schedule cap.
     *
     * The gate now stands down for USAGE only when the bound provider says
     * it really settles usage charges. Both paths are covered here so the
     * fix cannot regress in either direction: a legitimately billable
     * pay-per-use run must still sail through.
     */
    describe('validateRunEntitlement - pay-per-use may not bypass plan limits unless it is billable', () => {
        const overLimitPlan = { code: 'standard', displayName: 'Standard', maxWorks: 1 };

        const usageSchedule = {
            id: 'schedule-ppu',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.HOURLY,
            billingMode: WorkScheduleBillingMode.USAGE,
            status: WorkScheduleStatus.ACTIVE,
        } as any;

        const subscriptionSchedule = {
            ...usageSchedule,
            id: 'schedule-sub',
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
        } as any;

        beforeEach(() => {
            subscriptionService.isEnabled.mockReturnValue(true);
            subscriptionService.resolvePlanForUser.mockResolvedValue(overLimitPlan);
            subscriptionService.getCadenceAllowances.mockResolvedValue([
                { cadence: WorkScheduleCadence.HOURLY, allowed: true },
            ]);
            workRepository.findById.mockResolvedValue({ id: work.id, name: 'My Work' });
        });

        it('REFUSES an over-limit pay-per-use run and pauses the schedule when the provider cannot bill usage', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(5);

            await expect(service.validateRunEntitlement(usageSchedule, user)).resolves.toBe(false);

            expect(subscriptionService.canBillUsage).toHaveBeenCalled();
            expect(scheduleRepository.countActiveByUser).toHaveBeenCalledWith(user.id);
            expect(scheduleRepository.updateById).toHaveBeenCalledWith(
                usageSchedule.id,
                expect.objectContaining({
                    status: WorkScheduleStatus.PAUSED,
                    nextRunAt: null,
                }),
            );
            expect(notificationService.notifySchedulePaused).toHaveBeenCalled();
        });

        it('tells the pay-per-use owner WHY in the pause notification (not the plain plan-limit copy)', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(5);

            await service.validateRunEntitlement(usageSchedule, user);

            const reason = notificationService.notifySchedulePaused.mock.calls[0][3] as string;
            expect(reason.toLowerCase()).toContain('pay-per-use');
            expect(reason).toContain('Standard');
        });

        it('ALLOWS an over-limit pay-per-use run when the provider really settles usage charges', async () => {
            subscriptionService.canBillUsage.mockReturnValue(true);
            scheduleRepository.countActiveByUser.mockResolvedValue(5);

            await expect(service.validateRunEntitlement(usageSchedule, user)).resolves.toBe(true);

            expect(scheduleRepository.updateById).not.toHaveBeenCalled();
            expect(notificationService.notifySchedulePaused).not.toHaveBeenCalled();
        });

        it('REFUSES a pay-per-use run on a cadence the plan no longer allows (unbillable) and pauses it', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(1);
            subscriptionService.getCadenceAllowances.mockResolvedValue([
                { cadence: WorkScheduleCadence.HOURLY, allowed: false },
            ]);

            await expect(service.validateRunEntitlement(usageSchedule, user)).resolves.toBe(false);

            expect(scheduleRepository.updateById).toHaveBeenCalledWith(
                usageSchedule.id,
                expect.objectContaining({ status: WorkScheduleStatus.PAUSED }),
            );
        });

        it('still ALLOWS an in-limit pay-per-use run (the fix does not blanket-ban pay-per-use)', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(1);

            await expect(service.validateRunEntitlement(usageSchedule, user)).resolves.toBe(true);
            expect(scheduleRepository.updateById).not.toHaveBeenCalled();
        });

        it('still ALLOWS a subscription-covered run inside the plan limit (no regression on the paid path)', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(1);

            await expect(service.validateRunEntitlement(subscriptionSchedule, user)).resolves.toBe(
                true,
            );
            expect(scheduleRepository.updateById).not.toHaveBeenCalled();
            expect(notificationService.notifySchedulePaused).not.toHaveBeenCalled();
        });

        it('still REFUSES an over-limit subscription run with the original plan-limit copy', async () => {
            scheduleRepository.countActiveByUser.mockResolvedValue(5);

            await expect(service.validateRunEntitlement(subscriptionSchedule, user)).resolves.toBe(
                false,
            );
            const reason = notificationService.notifySchedulePaused.mock.calls[0][3] as string;
            expect(reason).toContain('Plan limit exceeded');
        });

        it('short-circuits to true for BOTH billing modes when subscriptions are disabled', async () => {
            subscriptionService.isEnabled.mockReturnValue(false);

            await expect(service.validateRunEntitlement(usageSchedule, user)).resolves.toBe(true);
            await expect(service.validateRunEntitlement(subscriptionSchedule, user)).resolves.toBe(
                true,
            );
            expect(subscriptionService.resolvePlanForUser).not.toHaveBeenCalled();
        });
    });

    /**
     * EW-761 (related cleanup) - the ledger write is the LAST thing
     * `markRunCompleted` does, and it was un-guarded: a BillingProvider that
     * ever threw from `recordUsageCharge` would propagate out of here and
     * fail a run that had already succeeded, after the schedule columns were
     * already advanced. The row is persisted before the charge, so
     * swallowing-and-logging loses nothing that settlement cannot pick up.
     */
    describe('markRunCompleted - a billing failure cannot fail a successful run', () => {
        const completedSchedule = {
            id: 'schedule-done',
            workId: work.id,
            userId: user.id,
            cadence: WorkScheduleCadence.DAILY,
            billingMode: WorkScheduleBillingMode.USAGE,
            status: WorkScheduleStatus.ACTIVE,
            nextRunAt: null,
            scheduledFor: new Date('2026-04-11T00:00:00.000Z'),
            failureCount: 0,
        } as any;

        it('does not throw when usage recording rejects, and still advances the schedule', async () => {
            scheduleRepository.findById.mockResolvedValue(completedSchedule);
            usageLedgerService.recordUsage.mockRejectedValue(new Error('stripe down'));

            await expect(
                service.markRunCompleted({
                    scheduleId: completedSchedule.id,
                    historyId: 'hist-1',
                    status: GenerateStatusType.GENERATED,
                }),
            ).resolves.toBeUndefined();

            expect(scheduleRepository.updateById).toHaveBeenCalledWith(
                completedSchedule.id,
                expect.objectContaining({ lastRunStatus: GenerateStatusType.GENERATED }),
            );
            expect(usageLedgerService.recordUsage).toHaveBeenCalled();
        });

        it('still records usage on the happy path', async () => {
            scheduleRepository.findById.mockResolvedValue(completedSchedule);

            await service.markRunCompleted({
                scheduleId: completedSchedule.id,
                historyId: 'hist-2',
                status: GenerateStatusType.GENERATED,
            });

            expect(usageLedgerService.recordUsage).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: user.id,
                    workId: work.id,
                    billingMode: WorkScheduleBillingMode.USAGE,
                    generationHistoryId: 'hist-2',
                }),
            );
        });
    });
});
