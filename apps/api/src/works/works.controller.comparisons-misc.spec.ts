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
        SETTINGS_UPDATED: 'SETTINGS_UPDATED',
        COMPARISON_GENERATION: 'COMPARISON_GENERATION',
        COMMUNITY_PR_MERGED: 'COMMUNITY_PR_MERGED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
    WorkScheduleStatus: { ACTIVE: 'ACTIVE' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: { getWork: Mock };
    workLifecycleService: Record<string, never>;
    workGenerationService: Record<string, never>;
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: { ensureAccess: Mock; ensureCanEdit: Mock };
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: Record<string, never>;
    generatorFormSchemaService: Record<string, never>;
    itemHealthService: Record<string, never>;
    communityPrProcessorService: { processWork: Mock };
    comparisonGenerationService: {
        listComparisons: Mock;
        getRemainingCount: Mock;
        getGenerationStatus: Mock;
        getComparison: Mock;
        generateNextComparison: Mock;
        generateManualComparison: Mock;
        deleteComparison: Mock;
    };
    workRepository: { findById: Mock };
    sourceValidationService: { getSettings: Mock; updateSettings: Mock };
    subscriptionService: { getCadenceAllowances: Mock };
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
        workQueryService: { getWork: jest.fn() },
        workLifecycleService: {} as any,
        workGenerationService: {} as any,
        authService: { getUser: jest.fn() },
        workDetailService: {} as any,
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: {
            ensureAccess: jest.fn().mockResolvedValue({ work: { id: 'w-1' } }),
            ensureCanEdit: jest.fn().mockResolvedValue(undefined),
        },
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {} as any,
        generatorFormSchemaService: {} as any,
        itemHealthService: {} as any,
        communityPrProcessorService: { processWork: jest.fn() },
        comparisonGenerationService: {
            listComparisons: jest.fn(),
            getRemainingCount: jest.fn(),
            getGenerationStatus: jest.fn(),
            getComparison: jest.fn(),
            generateNextComparison: jest.fn(),
            generateManualComparison: jest.fn(),
            deleteComparison: jest.fn(),
        },
        workRepository: { findById: jest.fn() },
        sourceValidationService: {
            getSettings: jest.fn(),
            updateSettings: jest.fn(),
        },
        subscriptionService: { getCadenceAllowances: jest.fn() },
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

describe('WorksController — comparisons + community-pr + source-validation endpoints', () => {
    let s: Stubs;
    let controller: WorksController;

    beforeEach(() => {
        s = makeStubs();
        s.authService.getUser.mockResolvedValue({ id: 'user-1' });
        controller = makeController(s);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // processCommunityPrs (POST works/:id/process-community-prs)
    // -----------------------------------------------------------------------
    describe('processCommunityPrs', () => {
        it('NotFoundException when workRepository.findById returns null (no log, no service call, no cache invalidation)', async () => {
            s.workRepository.findById.mockResolvedValue(null);

            await expect(controller.processCommunityPrs(auth, 'w-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );

            expect(s.communityPrProcessorService.processWork).not.toHaveBeenCalled();
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('BadRequestException when work.communityPrEnabled is false (no log, no service call)', async () => {
            s.workRepository.findById.mockResolvedValue({
                id: 'w-1',
                communityPrEnabled: false,
            } as any);

            await expect(controller.processCommunityPrs(auth, 'w-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(s.communityPrProcessorService.processWork).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('happy path: forwards work to processor, invalidates caches, logs COMMUNITY_PR_MERGED with itemsAdded, returns {itemsAdded}', async () => {
            const work: any = { id: 'w-1', communityPrEnabled: true };
            s.workRepository.findById.mockResolvedValue(work);
            s.communityPrProcessorService.processWork.mockResolvedValue(7);

            const result = await controller.processCommunityPrs(auth, 'w-1');

            expect(s.workQueryService.getWork).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(s.communityPrProcessorService.processWork).toHaveBeenCalledWith(work);
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'COMMUNITY_PR_MERGED',
                action: 'community_pr.processed',
                status: 'COMPLETED',
                summary: 'Processed community PRs',
                details: { itemsAdded: 7 },
            });
            expect(result).toEqual({ itemsAdded: 7 });
        });

        it('does not log when processWork rejects (cache also not invalidated)', async () => {
            s.workRepository.findById.mockResolvedValue({
                id: 'w-1',
                communityPrEnabled: true,
            } as any);
            s.communityPrProcessorService.processWork.mockRejectedValue(new Error('boom'));

            await expect(controller.processCommunityPrs(auth, 'w-1')).rejects.toThrow('boom');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // listComparisons
    // -----------------------------------------------------------------------
    describe('listComparisons', () => {
        it('verifies access via workQueryService.getWork(id, user) THEN forwards (id, user.id) to listComparisons', async () => {
            const fake: any = [{ slug: 'a-vs-b' }];
            s.comparisonGenerationService.listComparisons.mockResolvedValue(fake);

            const result = await controller.listComparisons(auth, 'w-1');

            expect(s.workQueryService.getWork).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(s.comparisonGenerationService.listComparisons).toHaveBeenCalledWith(
                'w-1',
                'user-1',
            );

            const accessOrder = s.workQueryService.getWork.mock.invocationCallOrder[0];
            const listOrder =
                s.comparisonGenerationService.listComparisons.mock.invocationCallOrder[0];
            expect(accessOrder).toBeLessThan(listOrder);

            expect(result).toBe(fake);
        });

        it('propagates getWork rejection without calling listComparisons', async () => {
            s.workQueryService.getWork.mockRejectedValue(new Error('forbidden'));

            await expect(controller.listComparisons(auth, 'w-1')).rejects.toThrow('forbidden');
            expect(s.comparisonGenerationService.listComparisons).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // getRemainingComparisonCount
    // -----------------------------------------------------------------------
    describe('getRemainingComparisonCount', () => {
        it('returns the count wrapped in a {count} envelope', async () => {
            s.comparisonGenerationService.getRemainingCount.mockResolvedValue(42);

            const result = await controller.getRemainingComparisonCount(auth, 'w-1');

            expect(s.workQueryService.getWork).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(s.comparisonGenerationService.getRemainingCount).toHaveBeenCalledWith(
                'w-1',
                'user-1',
            );
            expect(result).toEqual({ count: 42 });
        });
    });

    // -----------------------------------------------------------------------
    // getComparisonGenerationStatus
    // -----------------------------------------------------------------------
    describe('getComparisonGenerationStatus', () => {
        it('calls authService.getUser but does NOT call workQueryService.getWork (no access check on this endpoint)', async () => {
            const fake: any = { progress: 0.5, total: 10, completed: 5 };
            s.comparisonGenerationService.getGenerationStatus.mockResolvedValue(fake);

            const result = await controller.getComparisonGenerationStatus(auth, 'w-1');

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workQueryService.getWork).not.toHaveBeenCalled();
            expect(s.comparisonGenerationService.getGenerationStatus).toHaveBeenCalledWith('w-1');
            expect(result).toBe(fake);
        });
    });

    // -----------------------------------------------------------------------
    // getComparison
    // -----------------------------------------------------------------------
    describe('getComparison', () => {
        it('forwards (id, user.id, slug) and returns the result envelope when comparison exists', async () => {
            const envelope: any = { comparison: { slug: 'a-vs-b' }, related: [] };
            s.comparisonGenerationService.getComparison.mockResolvedValue(envelope);

            const result = await controller.getComparison(auth, 'w-1', 'a-vs-b');

            expect(s.workQueryService.getWork).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(s.comparisonGenerationService.getComparison).toHaveBeenCalledWith(
                'w-1',
                'user-1',
                'a-vs-b',
            );
            expect(result).toBe(envelope);
        });

        it('NotFoundException when result.comparison is null (the envelope is otherwise present)', async () => {
            s.comparisonGenerationService.getComparison.mockResolvedValue({
                comparison: null,
                related: [],
            } as any);

            await expect(controller.getComparison(auth, 'w-1', 'missing')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('NotFoundException when result.comparison is undefined', async () => {
            s.comparisonGenerationService.getComparison.mockResolvedValue({} as any);

            await expect(controller.getComparison(auth, 'w-1', 'missing')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    // -----------------------------------------------------------------------
    // generateNextComparison
    // -----------------------------------------------------------------------
    describe('generateNextComparison', () => {
        it('calls ensureCanEdit BEFORE generation, invalidates caches, and logs COMPARISON_GENERATION with status/slug/message details', async () => {
            const fake: any = { status: 'queued', slug: 'a-vs-b', message: 'queued' };
            s.comparisonGenerationService.generateNextComparison.mockResolvedValue(fake);

            const result = await controller.generateNextComparison(auth, 'w-1');

            expect(s.workOwnershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.comparisonGenerationService.generateNextComparison).toHaveBeenCalledWith(
                'w-1',
                'user-1',
            );

            const editOrder = s.workOwnershipService.ensureCanEdit.mock.invocationCallOrder[0];
            const genOrder =
                s.comparisonGenerationService.generateNextComparison.mock.invocationCallOrder[0];
            expect(editOrder).toBeLessThan(genOrder);

            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'COMPARISON_GENERATION',
                action: 'comparison.generated',
                status: 'COMPLETED',
                summary: 'Generated comparison',
                details: {
                    status: 'queued',
                    slug: 'a-vs-b',
                    message: 'queued',
                },
            });
            expect(result).toBe(fake);
        });

        it('does NOT log or invalidate when ensureCanEdit rejects', async () => {
            s.workOwnershipService.ensureCanEdit.mockRejectedValue(new Error('forbidden'));

            await expect(controller.generateNextComparison(auth, 'w-1')).rejects.toThrow(
                'forbidden',
            );
            expect(s.comparisonGenerationService.generateNextComparison).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // generateManualComparison
    // -----------------------------------------------------------------------
    describe('generateManualComparison', () => {
        it('BadRequestException when itemASlug equals itemBSlug (no service call, no log, ensureCanEdit STILL ran)', async () => {
            await expect(
                controller.generateManualComparison(auth, 'w-1', {
                    itemASlug: 'same',
                    itemBSlug: 'same',
                } as any),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(s.workOwnershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.comparisonGenerationService.generateManualComparison).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('forwards (id, user.id, itemASlug, itemBSlug) and logs COMPARISON_GENERATION with manual-flavored summary + details', async () => {
            const fake: any = { status: 'queued', slug: 'foo-vs-bar', message: 'ok' };
            s.comparisonGenerationService.generateManualComparison.mockResolvedValue(fake);

            const result = await controller.generateManualComparison(auth, 'w-1', {
                itemASlug: 'foo',
                itemBSlug: 'bar',
            } as any);

            expect(s.comparisonGenerationService.generateManualComparison).toHaveBeenCalledWith(
                'w-1',
                'user-1',
                'foo',
                'bar',
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'COMPARISON_GENERATION',
                action: 'comparison.generated_manual',
                status: 'COMPLETED',
                summary: 'Generated comparison: foo vs bar',
                details: {
                    status: 'queued',
                    slug: 'foo-vs-bar',
                    itemASlug: 'foo',
                    itemBSlug: 'bar',
                    message: 'ok',
                },
            });
            expect(result).toBe(fake);
        });

        it('does NOT log when generateManualComparison rejects', async () => {
            s.comparisonGenerationService.generateManualComparison.mockRejectedValue(
                new Error('quota'),
            );

            await expect(
                controller.generateManualComparison(auth, 'w-1', {
                    itemASlug: 'foo',
                    itemBSlug: 'bar',
                } as any),
            ).rejects.toThrow('quota');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // deleteComparison
    // -----------------------------------------------------------------------
    describe('deleteComparison', () => {
        it('forwards (id, user.id, slug), invalidates caches, and logs COMPARISON_GENERATION with slug-interpolated summary (NO details)', async () => {
            const fake: any = { ok: true };
            s.comparisonGenerationService.deleteComparison.mockResolvedValue(fake);

            const result = await controller.deleteComparison(auth, 'w-1', 'a-vs-b');

            expect(s.workOwnershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.comparisonGenerationService.deleteComparison).toHaveBeenCalledWith(
                'w-1',
                'user-1',
                'a-vs-b',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'COMPARISON_GENERATION',
                action: 'comparison.deleted',
                status: 'COMPLETED',
                summary: 'Deleted comparison: a-vs-b',
            });
            // NO details on delete (pinned)
            const call = s.activityLogService.log.mock.calls[0][0];
            expect(call).not.toHaveProperty('details');
            expect(result).toBe(fake);
        });

        it('does NOT log or invalidate when deleteComparison rejects', async () => {
            s.comparisonGenerationService.deleteComparison.mockRejectedValue(
                new Error('not found'),
            );

            await expect(controller.deleteComparison(auth, 'w-1', 'a-vs-b')).rejects.toThrow(
                'not found',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // getSourceValidationSettings (GET works/:id/source-validation)
    // -----------------------------------------------------------------------
    describe('getSourceValidationSettings', () => {
        it('runs ensureAccess BEFORE getSettings; passes (id, allowances) to the service; emits NO log', async () => {
            const allowances: any = { dailyMax: 50, hourlyMax: 5 };
            s.subscriptionService.getCadenceAllowances.mockResolvedValue(allowances);
            const settings: any = { cadence: 'daily', enabled: true };
            s.sourceValidationService.getSettings.mockResolvedValue(settings);

            const result = await controller.getSourceValidationSettings(auth, 'w-1');

            expect(s.workOwnershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.subscriptionService.getCadenceAllowances).toHaveBeenCalledWith({
                id: 'user-1',
            });
            expect(s.sourceValidationService.getSettings).toHaveBeenCalledWith('w-1', allowances);

            const accessOrder = s.workOwnershipService.ensureAccess.mock.invocationCallOrder[0];
            const getOrder = s.sourceValidationService.getSettings.mock.invocationCallOrder[0];
            expect(accessOrder).toBeLessThan(getOrder);

            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(settings);
        });

        it('propagates ensureAccess rejection without calling getCadenceAllowances or getSettings', async () => {
            s.workOwnershipService.ensureAccess.mockRejectedValue(new Error('forbidden'));

            await expect(controller.getSourceValidationSettings(auth, 'w-1')).rejects.toThrow(
                'forbidden',
            );
            expect(s.subscriptionService.getCadenceAllowances).not.toHaveBeenCalled();
            expect(s.sourceValidationService.getSettings).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // updateSourceValidationSettings (PUT works/:id/source-validation)
    // -----------------------------------------------------------------------
    describe('updateSourceValidationSettings', () => {
        it('runs ensureCanEdit BEFORE updateSettings; passes (id, dto, allowances); logs SETTINGS_UPDATED w/ details {cadence, enabled}', async () => {
            const allowances: any = { dailyMax: 50 };
            s.subscriptionService.getCadenceAllowances.mockResolvedValue(allowances);
            const settings: any = { cadence: 'weekly', enabled: false };
            s.sourceValidationService.updateSettings.mockResolvedValue(settings);

            const dto: any = { cadence: 'weekly', enabled: false };
            const result = await controller.updateSourceValidationSettings(auth, 'w-1', dto);

            expect(s.workOwnershipService.ensureCanEdit).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.sourceValidationService.updateSettings).toHaveBeenCalledWith(
                'w-1',
                dto,
                allowances,
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'work.source_validation_updated',
                status: 'COMPLETED',
                summary: 'Updated source validation settings',
                details: { cadence: 'weekly', enabled: false },
            });
            expect(result).toBe(settings);
        });

        it('forwards undefined cadence/enabled into the log details when dto omits them', async () => {
            s.subscriptionService.getCadenceAllowances.mockResolvedValue({} as any);
            s.sourceValidationService.updateSettings.mockResolvedValue({} as any);

            await controller.updateSourceValidationSettings(auth, 'w-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { cadence: undefined, enabled: undefined },
                }),
            );
        });

        it('does NOT log when updateSettings rejects', async () => {
            s.subscriptionService.getCadenceAllowances.mockResolvedValue({} as any);
            s.sourceValidationService.updateSettings.mockRejectedValue(new Error('quota'));

            await expect(
                controller.updateSourceValidationSettings(auth, 'w-1', {
                    cadence: 'daily',
                    enabled: true,
                } as any),
            ).rejects.toThrow('quota');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });
});
