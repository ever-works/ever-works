// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph.
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/template-catalog', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({
    getDefaultWebsiteTemplateId: jest.fn(() => 'default-template'),
}));
jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        SCHEDULE_UPDATED: 'SCHEDULE_UPDATED',
        SCHEDULE_DELETED: 'SCHEDULE_DELETED',
        SCHEDULE_EXECUTED: 'SCHEDULE_EXECUTED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
    // Pin the WorkScheduleStatus values that the controller branches on.
    WorkScheduleStatus: { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: Record<string, never>;
    workLifecycleService: Record<string, never>;
    workGenerationService: { runScheduledUpdate: Mock };
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: {
        getSchedule: Mock;
        updateSchedule: Mock;
        cancelSchedule: Mock;
        getScheduleEntity: Mock;
    };
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: Record<string, never>;
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: Record<string, never>;
    generatorFormSchemaService: Record<string, never>;
    itemHealthService: Record<string, never>;
    communityPrProcessorService: Record<string, never>;
    comparisonGenerationService: Record<string, never>;
    workRepository: Record<string, never>;
    sourceValidationService: Record<string, never>;
    subscriptionService: Record<string, never>;
    activityLogService: { log: Mock };
    templateCatalogService: Record<string, never>;
    itemExportService: Record<string, never>;
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {} as any,
        workLifecycleService: {} as any,
        workGenerationService: { runScheduledUpdate: jest.fn() },
        authService: { getUser: jest.fn() },
        workDetailService: {} as any,
        workScheduleService: {
            getSchedule: jest.fn(),
            updateSchedule: jest.fn(),
            cancelSchedule: jest.fn(),
            getScheduleEntity: jest.fn(),
        },
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: {} as any,
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {} as any,
        generatorFormSchemaService: {} as any,
        itemHealthService: {} as any,
        communityPrProcessorService: {} as any,
        comparisonGenerationService: {} as any,
        workRepository: {} as any,
        sourceValidationService: {} as any,
        subscriptionService: {} as any,
        activityLogService: { log: jest.fn().mockResolvedValue(undefined) },
        templateCatalogService: {} as any,
        itemExportService: {} as any,
    };
}

function makeController(s: Stubs): WorksController {
    return new WorksController(
        s.cacheManager as any,
        s.cacheEntryRepository as any,
        s.workQueryService as any,
        s.workLifecycleService as any,
        s.workGenerationService as any,
        s.authService as any,
        s.workDetailService as any,
        s.workScheduleService as any,
        s.workImportService as any,
        s.repositoryManagementService as any,
        s.workOwnershipService as any,
        s.workAdvancedPromptsService as any,
        s.workTaxonomyService as any,
        s.generatorFormSchemaService as any,
        s.itemHealthService as any,
        s.communityPrProcessorService as any,
        s.comparisonGenerationService as any,
        s.workRepository as any,
        s.sourceValidationService as any,
        s.subscriptionService as any,
        s.activityLogService as any,
        s.templateCatalogService as any,
        s.itemExportService as any,
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — schedule endpoints', () => {
    let s: Stubs;
    let controller: WorksController;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        s = makeStubs();
        s.authService.getUser.mockResolvedValue({ id: 'user-1' });
        controller = makeController(s);
        errorSpy = jest
            .spyOn((controller as any).logger, 'error')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // getWorkSchedule
    // -----------------------------------------------------------------------
    describe('getWorkSchedule', () => {
        it('forwards id + user and wraps the result in {status: success, ...result}', async () => {
            s.workScheduleService.getSchedule.mockResolvedValue({
                cadence: 'daily',
                isActive: true,
            });

            const result = await controller.getWorkSchedule(auth, 'w-1');

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workScheduleService.getSchedule).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(result).toEqual({
                status: 'success',
                cadence: 'daily',
                isActive: true,
            });
        });

        it('propagates errors from getSchedule', async () => {
            s.workScheduleService.getSchedule.mockRejectedValue(new Error('not found'));

            await expect(controller.getWorkSchedule(auth, 'w-1')).rejects.toThrow('not found');
        });
    });

    // -----------------------------------------------------------------------
    // updateWorkSchedule
    // -----------------------------------------------------------------------
    describe('updateWorkSchedule', () => {
        it('runs immediate update when runImmediately=true AND schedule is ACTIVE', async () => {
            const dto: any = { runImmediately: true, cadence: 'daily' };
            const updatedSchedule: any = { id: 's-1', status: 'ACTIVE' };
            const scheduleEntity: any = { id: 's-1', work: { slug: 'my-work' } };
            s.workScheduleService.updateSchedule.mockResolvedValue(updatedSchedule);
            s.workScheduleService.getScheduleEntity.mockResolvedValue(scheduleEntity);
            s.workGenerationService.runScheduledUpdate.mockResolvedValue(undefined);

            const result = await controller.updateWorkSchedule(auth, 'w-1', dto);

            expect(s.workScheduleService.updateSchedule).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(s.workScheduleService.getScheduleEntity).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.workGenerationService.runScheduledUpdate).toHaveBeenCalledWith(scheduleEntity);
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SCHEDULE_UPDATED',
                action: 'schedule.updated',
                status: 'COMPLETED',
                summary: 'Updated schedule',
            });
            expect(result).toEqual({ status: 'success', schedule: updatedSchedule });
        });

        it('does NOT run immediate update when runImmediately=true but schedule is not ACTIVE', async () => {
            const dto: any = { runImmediately: true };
            s.workScheduleService.updateSchedule.mockResolvedValue({ id: 's-1', status: 'PAUSED' });

            await controller.updateWorkSchedule(auth, 'w-1', dto);

            expect(s.workScheduleService.getScheduleEntity).not.toHaveBeenCalled();
            expect(s.workGenerationService.runScheduledUpdate).not.toHaveBeenCalled();
            // Activity log still emitted.
            expect(s.activityLogService.log).toHaveBeenCalledTimes(1);
        });

        it('does NOT run immediate update when runImmediately=false (even if ACTIVE)', async () => {
            const dto: any = { runImmediately: false };
            s.workScheduleService.updateSchedule.mockResolvedValue({ id: 's-1', status: 'ACTIVE' });

            await controller.updateWorkSchedule(auth, 'w-1', dto);

            expect(s.workScheduleService.getScheduleEntity).not.toHaveBeenCalled();
            expect(s.workGenerationService.runScheduledUpdate).not.toHaveBeenCalled();
        });

        it('logs the runScheduledUpdate failure (Error → stack) without rejecting the response', async () => {
            const dto: any = { runImmediately: true };
            s.workScheduleService.updateSchedule.mockResolvedValue({ id: 's-1', status: 'ACTIVE' });
            s.workScheduleService.getScheduleEntity.mockResolvedValue({ id: 's-1' });
            const failure = new Error('queue down');
            s.workGenerationService.runScheduledUpdate.mockRejectedValue(failure);

            // The controller doesn't await runScheduledUpdate, so the response
            // resolves before the rejection is logged. Resolve any microtasks.
            const result = await controller.updateWorkSchedule(auth, 'w-1', dto);
            expect(result).toEqual({
                status: 'success',
                schedule: { id: 's-1', status: 'ACTIVE' },
            });

            // Flush microtasks so the .catch handler runs.
            await new Promise((resolve) => setImmediate(resolve));

            expect(errorSpy).toHaveBeenCalledTimes(1);
            const [msg, stack] = errorSpy.mock.calls[0];
            expect(msg).toBe('Failed to start immediate scheduled update for work w-1');
            expect(stack).toBe(failure.stack);
        });

        it('logs runScheduledUpdate failure (non-Error → String(error))', async () => {
            const dto: any = { runImmediately: true };
            s.workScheduleService.updateSchedule.mockResolvedValue({ id: 's-1', status: 'ACTIVE' });
            s.workScheduleService.getScheduleEntity.mockResolvedValue({ id: 's-1' });
            s.workGenerationService.runScheduledUpdate.mockRejectedValue('plain-string-error');

            await controller.updateWorkSchedule(auth, 'w-1', dto);
            await new Promise((resolve) => setImmediate(resolve));

            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to start immediate scheduled update for work w-1',
                'plain-string-error',
            );
        });
    });

    // -----------------------------------------------------------------------
    // cancelWorkSchedule
    // -----------------------------------------------------------------------
    describe('cancelWorkSchedule', () => {
        it('cancels the schedule, logs SCHEDULE_DELETED, and wraps the response', async () => {
            const cancelled: any = { id: 's-1', status: 'CANCELLED' };
            s.workScheduleService.cancelSchedule.mockResolvedValue(cancelled);

            const result = await controller.cancelWorkSchedule(auth, 'w-1');

            expect(s.workScheduleService.cancelSchedule).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SCHEDULE_DELETED',
                action: 'schedule.deleted',
                status: 'COMPLETED',
                summary: 'Deleted schedule',
            });
            expect(result).toEqual({ status: 'success', schedule: cancelled });
        });

        it('does not log when cancelSchedule rejects', async () => {
            s.workScheduleService.cancelSchedule.mockRejectedValue(new Error('not found'));

            await expect(controller.cancelWorkSchedule(auth, 'w-1')).rejects.toThrow('not found');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // runScheduledUpdate
    // -----------------------------------------------------------------------
    describe('runScheduledUpdate', () => {
        it('throws BadRequestException when schedule status is not ACTIVE', async () => {
            s.workScheduleService.getScheduleEntity.mockResolvedValue({
                id: 's-1',
                status: 'PAUSED',
            });

            await expect(controller.runScheduledUpdate(auth, 'w-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(s.workGenerationService.runScheduledUpdate).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('returns {status: pending, slug, message} on ACTIVE schedule and uses work.slug', async () => {
            const schedule: any = {
                id: 's-1',
                status: 'ACTIVE',
                work: { slug: 'my-slug' },
            };
            s.workScheduleService.getScheduleEntity.mockResolvedValue(schedule);
            s.workGenerationService.runScheduledUpdate.mockResolvedValue(undefined);

            const result = await controller.runScheduledUpdate(auth, 'w-1');

            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SCHEDULE_EXECUTED',
                action: 'schedule.executed',
                status: 'COMPLETED',
                summary: 'Triggered scheduled update',
            });
            expect(s.workGenerationService.runScheduledUpdate).toHaveBeenCalledWith(schedule);
            expect(result).toEqual({
                status: 'pending',
                slug: 'my-slug',
                message: 'Scheduled update started',
            });
        });

        it('falls back to the work id when work.slug is missing', async () => {
            s.workScheduleService.getScheduleEntity.mockResolvedValue({
                id: 's-1',
                status: 'ACTIVE',
            });
            s.workGenerationService.runScheduledUpdate.mockResolvedValue(undefined);

            const result = await controller.runScheduledUpdate(auth, 'w-1');

            expect(result.slug).toBe('w-1');
        });

        it('logs the runScheduledUpdate failure (Error → stack) without rejecting', async () => {
            const schedule: any = { id: 's-1', status: 'ACTIVE' };
            s.workScheduleService.getScheduleEntity.mockResolvedValue(schedule);
            const failure = new Error('queue down');
            s.workGenerationService.runScheduledUpdate.mockRejectedValue(failure);

            const result = await controller.runScheduledUpdate(auth, 'w-1');
            expect(result.status).toBe('pending');

            // Flush microtasks so the .catch fires.
            await new Promise((resolve) => setImmediate(resolve));

            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy.mock.calls[0][0]).toBe('Failed to run scheduled update for work w-1');
            expect(errorSpy.mock.calls[0][1]).toBe(failure.stack);
        });

        it('logs runScheduledUpdate failure (non-Error → String(error))', async () => {
            s.workScheduleService.getScheduleEntity.mockResolvedValue({
                id: 's-1',
                status: 'ACTIVE',
            });
            s.workGenerationService.runScheduledUpdate.mockRejectedValue({ code: 500 });

            await controller.runScheduledUpdate(auth, 'w-1');
            await new Promise((resolve) => setImmediate(resolve));

            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to run scheduled update for work w-1',
                String({ code: 500 }), // i.e. '[object Object]'
            );
        });
    });
});
