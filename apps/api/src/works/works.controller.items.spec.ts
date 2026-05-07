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
        ITEM_ADDED: 'ITEM_ADDED',
        ITEM_REMOVED: 'ITEM_REMOVED',
        ITEM_UPDATED: 'ITEM_UPDATED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
    WorkScheduleStatus: { ACTIVE: 'ACTIVE' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: Record<string, never>;
    workLifecycleService: Record<string, never>;
    workGenerationService: {
        submitItem: Mock;
        removeItem: Mock;
        updateItemMetadata: Mock;
        extractItemDetails: Mock;
        bulkCaptureImages: Mock;
    };
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: Record<string, never>;
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: Record<string, never>;
    generatorFormSchemaService: Record<string, never>;
    itemHealthService: { checkItem: Mock };
    communityPrProcessorService: Record<string, never>;
    comparisonGenerationService: Record<string, never>;
    workRepository: Record<string, never>;
    sourceValidationService: Record<string, never>;
    subscriptionService: Record<string, never>;
    activityLogService: { log: Mock };
    templateCatalogService: Record<string, never>;
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {} as any,
        workLifecycleService: {} as any,
        workGenerationService: {
            submitItem: jest.fn(),
            removeItem: jest.fn(),
            updateItemMetadata: jest.fn(),
            extractItemDetails: jest.fn(),
            bulkCaptureImages: jest.fn(),
        },
        authService: { getUser: jest.fn() },
        workDetailService: {} as any,
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: {} as any,
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {} as any,
        generatorFormSchemaService: {} as any,
        itemHealthService: { checkItem: jest.fn() },
        communityPrProcessorService: {} as any,
        comparisonGenerationService: {} as any,
        workRepository: {} as any,
        sourceValidationService: {} as any,
        subscriptionService: {} as any,
        activityLogService: { log: jest.fn().mockResolvedValue(undefined) },
        templateCatalogService: {} as any,
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
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — items mutation endpoints', () => {
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
    // submitItem
    // -----------------------------------------------------------------------
    describe('submitItem', () => {
        it('forwards args, invalidates caches, and logs ITEM_ADDED with the item name in the summary', async () => {
            const dto: any = { name: 'My Item', url: 'https://example.com' };
            s.workGenerationService.submitItem.mockResolvedValue({ id: 'i-1' });

            const result = await controller.submitItem(auth, 'w-1', dto);

            expect(s.workGenerationService.submitItem).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'ITEM_ADDED',
                action: 'item.submitted',
                status: 'COMPLETED',
                summary: 'Added item: My Item',
            });
            expect(result).toEqual({ id: 'i-1' });
        });

        it('falls back to "New item" in the summary when name is missing', async () => {
            const dto: any = { url: 'https://example.com' };
            s.workGenerationService.submitItem.mockResolvedValue({ id: 'i-2' });

            await controller.submitItem(auth, 'w-1', dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ summary: 'Added item: New item' }),
            );
        });

        it('does not invalidate caches or log when submitItem rejects', async () => {
            s.workGenerationService.submitItem.mockRejectedValue(new Error('quota'));

            await expect(controller.submitItem(auth, 'w-1', {} as any)).rejects.toThrow('quota');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // removeItem
    // -----------------------------------------------------------------------
    describe('removeItem', () => {
        it('forwards args, invalidates caches, and logs ITEM_REMOVED', async () => {
            const dto: any = { item_slug: 'item-1' };
            s.workGenerationService.removeItem.mockResolvedValue({ removed: true });

            const result = await controller.removeItem(auth, 'w-1', dto);

            expect(s.workGenerationService.removeItem).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'ITEM_REMOVED',
                action: 'item.removed',
                status: 'COMPLETED',
                summary: 'Removed item',
            });
            expect(result).toEqual({ removed: true });
        });

        it('does not invalidate caches or log when removeItem rejects', async () => {
            s.workGenerationService.removeItem.mockRejectedValue(new Error('not found'));

            await expect(controller.removeItem(auth, 'w-1', {} as any)).rejects.toThrow(
                'not found',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // updateItemMetadata
    // -----------------------------------------------------------------------
    describe('updateItemMetadata', () => {
        it('forwards args, invalidates caches, and logs ITEM_UPDATED with item details', async () => {
            const dto: any = { item_slug: 'item-1', featured: true, order: 3 };
            s.workGenerationService.updateItemMetadata.mockResolvedValue({ ok: true });

            const result = await controller.updateItemMetadata(auth, 'w-1', dto);

            expect(s.workGenerationService.updateItemMetadata).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'ITEM_UPDATED',
                action: 'item.updated',
                status: 'COMPLETED',
                summary: 'Updated item metadata',
                details: { itemSlug: 'item-1', featured: true, order: 3 },
            });
            expect(result).toEqual({ ok: true });
        });

        it('passes undefined for missing dto fields in the activity-log details', async () => {
            const dto: any = { item_slug: 'item-2' };
            s.workGenerationService.updateItemMetadata.mockResolvedValue({});

            await controller.updateItemMetadata(auth, 'w-1', dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { itemSlug: 'item-2', featured: undefined, order: undefined },
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // checkItemHealth
    // -----------------------------------------------------------------------
    describe('checkItemHealth', () => {
        it('forwards positional args (id, item_slug, user) and logs the result fields', async () => {
            const dto: any = { item_slug: 'foo' };
            const checkResult: any = {
                item_slug: 'foo',
                item_name: 'Foo',
                health: 'ok',
                message: 'all good',
            };
            s.itemHealthService.checkItem.mockResolvedValue(checkResult);

            const result = await controller.checkItemHealth(auth, 'w-1', dto);

            expect(s.itemHealthService.checkItem).toHaveBeenCalledWith('w-1', 'foo', {
                id: 'user-1',
            });
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'ITEM_UPDATED',
                action: 'item.source_rechecked',
                status: 'COMPLETED',
                summary: 'Re-checked item source: Foo',
                details: {
                    itemSlug: 'foo',
                    itemName: 'Foo',
                    health: 'ok',
                    message: 'all good',
                },
            });
            expect(result).toEqual(checkResult);
        });

        it('falls back to the dto item_slug in the summary when result.item_name is missing', async () => {
            const dto: any = { item_slug: 'bar' };
            s.itemHealthService.checkItem.mockResolvedValue({
                item_slug: 'bar',
                item_name: undefined,
                health: 'broken',
                message: '404',
            });

            await controller.checkItemHealth(auth, 'w-1', dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    summary: 'Re-checked item source: bar',
                }),
            );
        });

        it('does not invalidate caches or log when checkItem rejects', async () => {
            s.itemHealthService.checkItem.mockRejectedValue(new Error('timeout'));

            await expect(
                controller.checkItemHealth(auth, 'w-1', { item_slug: 'x' } as any),
            ).rejects.toThrow('timeout');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // extractItemDetails
    // -----------------------------------------------------------------------
    describe('extractItemDetails', () => {
        it('forwards the dto and user to workGenerationService.extractItemDetails — no log, no cache invalidate', async () => {
            const dto: any = { url: 'https://example.com' };
            s.workGenerationService.extractItemDetails.mockResolvedValue({ name: 'Example' });

            const result = await controller.extractItemDetails(auth, dto);

            expect(s.workGenerationService.extractItemDetails).toHaveBeenCalledWith(dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(result).toEqual({ name: 'Example' });
        });

        it('propagates errors from extractItemDetails', async () => {
            s.workGenerationService.extractItemDetails.mockRejectedValue(new Error('extract fail'));

            await expect(controller.extractItemDetails(auth, {} as any)).rejects.toThrow(
                'extract fail',
            );
        });
    });

    // -----------------------------------------------------------------------
    // bulkCaptureImages
    // -----------------------------------------------------------------------
    describe('bulkCaptureImages', () => {
        it('forwards args and logs ITEM_UPDATED with images_captured action — no cache invalidation', async () => {
            const dto: any = { itemSlugs: ['a', 'b'] };
            s.workGenerationService.bulkCaptureImages.mockResolvedValue({ captured: 2 });

            const result = await controller.bulkCaptureImages(auth, 'w-1', dto);

            expect(s.workGenerationService.bulkCaptureImages).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            // Note: bulkCaptureImages does NOT call invalidateWorkCaches.
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'ITEM_UPDATED',
                action: 'items.images_captured',
                status: 'COMPLETED',
                summary: 'Captured item images',
            });
            expect(result).toEqual({ captured: 2 });
        });

        it('does not log when bulkCaptureImages rejects', async () => {
            s.workGenerationService.bulkCaptureImages.mockRejectedValue(new Error('boom'));

            await expect(controller.bulkCaptureImages(auth, 'w-1', {} as any)).rejects.toThrow(
                'boom',
            );
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });
});
