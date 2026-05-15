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

import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: Record<string, never>;
    workLifecycleService: Record<string, never>;
    workGenerationService: Record<string, never>;
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: Record<string, never>;
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: {
        createCategory: Mock;
        updateCategory: Mock;
        deleteCategory: Mock;
        createTag: Mock;
        updateTag: Mock;
        deleteTag: Mock;
        createCollection: Mock;
        updateCollection: Mock;
        deleteCollection: Mock;
    };
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
    itemImportService: Record<string, never>;
    itemImportExecutor: Record<string, never>;
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {} as any,
        workLifecycleService: {} as any,
        workGenerationService: {} as any,
        authService: { getUser: jest.fn() },
        workDetailService: {} as any,
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: {} as any,
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {
            createCategory: jest.fn(),
            updateCategory: jest.fn(),
            deleteCategory: jest.fn(),
            createTag: jest.fn(),
            updateTag: jest.fn(),
            deleteTag: jest.fn(),
            createCollection: jest.fn(),
            updateCollection: jest.fn(),
            deleteCollection: jest.fn(),
        },
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
        itemImportService: {} as any,
        itemImportExecutor: {} as any,
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
        s.itemImportService as any,
        s.itemImportExecutor as any,
        { rotate: jest.fn(), getOrGenerate: jest.fn() } as any,
        {
            isEnabled: jest.fn().mockReturnValue(false),
            verify: jest.fn().mockResolvedValue({ success: true, skipped: true }),
        } as any,
        { emit: jest.fn() } as any,
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — taxonomy CRUD endpoints', () => {
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
    // createCategory / updateCategory / deleteCategory
    // -----------------------------------------------------------------------
    describe('createCategory', () => {
        it('forwards (id, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ "Created category: <name>"', async () => {
            const dto: any = { name: 'AI Tools' };
            s.workTaxonomyService.createCategory.mockResolvedValue({ id: 'c-1', ...dto });

            const result = await controller.createCategory(auth, 'w-1', dto);

            expect(s.workTaxonomyService.createCategory).toHaveBeenCalledWith('w-1', dto, 'auth-1');
            expect(s.authService.getUser).not.toHaveBeenCalled();
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.category_created',
                status: 'COMPLETED',
                summary: 'Created category: AI Tools',
            });
            expect(result).toEqual({ id: 'c-1', name: 'AI Tools' });
        });

        it('runs the cache invalidation AFTER the service call', async () => {
            const order: string[] = [];
            s.workTaxonomyService.createCategory.mockImplementation(async () => {
                order.push('service');
                return { id: 'c-1' };
            });
            s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike.mockImplementation(
                async () => {
                    order.push('cache');
                },
            );

            await controller.createCategory(auth, 'w-1', { name: 'X' } as any);

            expect(order).toEqual(['service', 'cache']);
        });

        it('does NOT invalidate caches or log when createCategory rejects', async () => {
            s.workTaxonomyService.createCategory.mockRejectedValue(new Error('duplicate'));

            await expect(
                controller.createCategory(auth, 'w-1', { name: 'X' } as any),
            ).rejects.toThrow('duplicate');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('updateCategory', () => {
        it('forwards (id, categoryId, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {categoryId, name}', async () => {
            const dto: any = { name: 'Renamed' };
            s.workTaxonomyService.updateCategory.mockResolvedValue({ id: 'c-1', ...dto });

            const result = await controller.updateCategory(auth, 'w-1', 'c-1', dto);

            expect(s.workTaxonomyService.updateCategory).toHaveBeenCalledWith(
                'w-1',
                'c-1',
                dto,
                'auth-1',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.category_updated',
                status: 'COMPLETED',
                summary: 'Updated category',
                details: { categoryId: 'c-1', name: 'Renamed' },
            });
            expect(result).toEqual({ id: 'c-1', name: 'Renamed' });
        });

        it('forwards undefined name in details when dto omits it (PATCH-style update)', async () => {
            s.workTaxonomyService.updateCategory.mockResolvedValue({} as any);

            await controller.updateCategory(auth, 'w-1', 'c-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { categoryId: 'c-1', name: undefined },
                }),
            );
        });

        it('does NOT invalidate caches or log when updateCategory rejects', async () => {
            s.workTaxonomyService.updateCategory.mockRejectedValue(new Error('not found'));

            await expect(controller.updateCategory(auth, 'w-1', 'c-1', {} as any)).rejects.toThrow(
                'not found',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('deleteCategory', () => {
        it('forwards (id, categoryId, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {categoryId}', async () => {
            s.workTaxonomyService.deleteCategory.mockResolvedValue({ removed: true });

            const result = await controller.deleteCategory(auth, 'w-1', 'c-1');

            expect(s.workTaxonomyService.deleteCategory).toHaveBeenCalledWith(
                'w-1',
                'c-1',
                'auth-1',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.category_deleted',
                status: 'COMPLETED',
                summary: 'Deleted category',
                details: { categoryId: 'c-1' },
            });
            expect(result).toEqual({ removed: true });
        });

        it('does NOT invalidate caches or log when deleteCategory rejects', async () => {
            s.workTaxonomyService.deleteCategory.mockRejectedValue(new Error('in use'));

            await expect(controller.deleteCategory(auth, 'w-1', 'c-1')).rejects.toThrow('in use');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // createTag / updateTag / deleteTag
    // -----------------------------------------------------------------------
    describe('createTag', () => {
        it('forwards (id, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ "Created tag: <name>"', async () => {
            const dto: any = { name: 'open-source' };
            s.workTaxonomyService.createTag.mockResolvedValue({ id: 't-1', ...dto });

            const result = await controller.createTag(auth, 'w-1', dto);

            expect(s.workTaxonomyService.createTag).toHaveBeenCalledWith('w-1', dto, 'auth-1');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.tag_created',
                status: 'COMPLETED',
                summary: 'Created tag: open-source',
            });
            expect(result).toEqual({ id: 't-1', name: 'open-source' });
        });

        it('does NOT invalidate caches or log when createTag rejects', async () => {
            s.workTaxonomyService.createTag.mockRejectedValue(new Error('duplicate'));

            await expect(controller.createTag(auth, 'w-1', { name: 'x' } as any)).rejects.toThrow(
                'duplicate',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    describe('updateTag', () => {
        it('forwards (id, tagId, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {tagId, name}', async () => {
            const dto: any = { name: 'rust' };
            s.workTaxonomyService.updateTag.mockResolvedValue({} as any);

            await controller.updateTag(auth, 'w-1', 't-1', dto);

            expect(s.workTaxonomyService.updateTag).toHaveBeenCalledWith(
                'w-1',
                't-1',
                dto,
                'auth-1',
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.tag_updated',
                status: 'COMPLETED',
                summary: 'Updated tag',
                details: { tagId: 't-1', name: 'rust' },
            });
        });

        it('forwards undefined name in details when dto omits it', async () => {
            s.workTaxonomyService.updateTag.mockResolvedValue({} as any);

            await controller.updateTag(auth, 'w-1', 't-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { tagId: 't-1', name: undefined },
                }),
            );
        });
    });

    describe('deleteTag', () => {
        it('forwards (id, tagId, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {tagId}', async () => {
            s.workTaxonomyService.deleteTag.mockResolvedValue({ ok: true });

            const result = await controller.deleteTag(auth, 'w-1', 't-1');

            expect(s.workTaxonomyService.deleteTag).toHaveBeenCalledWith('w-1', 't-1', 'auth-1');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.tag_deleted',
                status: 'COMPLETED',
                summary: 'Deleted tag',
                details: { tagId: 't-1' },
            });
            expect(result).toEqual({ ok: true });
        });
    });

    // -----------------------------------------------------------------------
    // createCollection / updateCollection / deleteCollection
    // -----------------------------------------------------------------------
    describe('createCollection', () => {
        it('forwards (id, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ "Created collection: <name>"', async () => {
            const dto: any = { name: 'Featured' };
            s.workTaxonomyService.createCollection.mockResolvedValue({ id: 'col-1', ...dto });

            const result = await controller.createCollection(auth, 'w-1', dto);

            expect(s.workTaxonomyService.createCollection).toHaveBeenCalledWith(
                'w-1',
                dto,
                'auth-1',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.collection_created',
                status: 'COMPLETED',
                summary: 'Created collection: Featured',
            });
            expect(result).toEqual({ id: 'col-1', name: 'Featured' });
        });
    });

    describe('updateCollection', () => {
        it('forwards (id, collectionId, dto, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {collectionId, name}', async () => {
            const dto: any = { name: 'Popular' };
            s.workTaxonomyService.updateCollection.mockResolvedValue({} as any);

            await controller.updateCollection(auth, 'w-1', 'col-1', dto);

            expect(s.workTaxonomyService.updateCollection).toHaveBeenCalledWith(
                'w-1',
                'col-1',
                dto,
                'auth-1',
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.collection_updated',
                status: 'COMPLETED',
                summary: 'Updated collection',
                details: { collectionId: 'col-1', name: 'Popular' },
            });
        });

        it('forwards undefined name in details when dto omits it', async () => {
            s.workTaxonomyService.updateCollection.mockResolvedValue({} as any);

            await controller.updateCollection(auth, 'w-1', 'col-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: { collectionId: 'col-1', name: undefined },
                }),
            );
        });
    });

    describe('deleteCollection', () => {
        it('forwards (id, collectionId, auth.userId), invalidates caches, and logs SETTINGS_UPDATED w/ details {collectionId}', async () => {
            s.workTaxonomyService.deleteCollection.mockResolvedValue({ ok: true });

            const result = await controller.deleteCollection(auth, 'w-1', 'col-1');

            expect(s.workTaxonomyService.deleteCollection).toHaveBeenCalledWith(
                'w-1',
                'col-1',
                'auth-1',
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'taxonomy.collection_deleted',
                status: 'COMPLETED',
                summary: 'Deleted collection',
                details: { collectionId: 'col-1' },
            });
            expect(result).toEqual({ ok: true });
        });

        it('does NOT invalidate caches or log when deleteCollection rejects', async () => {
            s.workTaxonomyService.deleteCollection.mockRejectedValue(new Error('referenced'));

            await expect(controller.deleteCollection(auth, 'w-1', 'col-1')).rejects.toThrow(
                'referenced',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Cross-cutting: fire-and-forget log rejection swallowing on every endpoint
    // -----------------------------------------------------------------------
    describe('fire-and-forget activity-log rejection swallowing', () => {
        it('createCategory: log-rejection does not throw the response', async () => {
            s.workTaxonomyService.createCategory.mockResolvedValue({ id: 'c-1' });
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(
                controller.createCategory(auth, 'w-1', { name: 'X' } as any),
            ).resolves.toEqual({ id: 'c-1' });
        });

        it('deleteTag: log-rejection does not throw the response', async () => {
            s.workTaxonomyService.deleteTag.mockResolvedValue({ ok: true });
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(controller.deleteTag(auth, 'w-1', 't-1')).resolves.toEqual({ ok: true });
        });

        it('updateCollection: log-rejection does not throw the response', async () => {
            s.workTaxonomyService.updateCollection.mockResolvedValue({ id: 'col-1' });
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(
                controller.updateCollection(auth, 'w-1', 'col-1', { name: 'Z' } as any),
            ).resolves.toEqual({ id: 'col-1' });
        });
    });
});
