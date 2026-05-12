// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph (database, entities, services, etc.).
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
        WORK_UPDATED: 'WORK_UPDATED',
        WEBSITE_SETTINGS_UPDATED: 'WEBSITE_SETTINGS_UPDATED',
        WORK_DELETED: 'WORK_DELETED',
        SETTINGS_UPDATED: 'SETTINGS_UPDATED',
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
import {
    getWorkCategoriesTagsCacheKey,
    getWorkConfigCacheKey,
    getWorkCountCacheKey,
    getWorkItemsCacheKey,
    WORK_CACHE_TTL_MS,
} from './work-cache.constants';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: {
        getWorks: Mock;
        getStats: Mock;
        getWork: Mock;
        workItems: Mock;
        workConfig: Mock;
        workCount: Mock;
        workCategoriesTags: Mock;
        workGenerationHistory: Mock;
        getWebsiteSettings: Mock;
        updateWebsiteSettings: Mock;
    };
    workLifecycleService: { createWork: Mock; updateWork: Mock; deleteWork: Mock };
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
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
    templateCatalogService: { listTemplatesForUser: Mock };
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
        workQueryService: {
            getWorks: jest.fn(),
            getStats: jest.fn(),
            getWork: jest.fn(),
            workItems: jest.fn(),
            workConfig: jest.fn(),
            workCount: jest.fn(),
            workCategoriesTags: jest.fn(),
            workGenerationHistory: jest.fn(),
            getWebsiteSettings: jest.fn(),
            updateWebsiteSettings: jest.fn(),
        },
        workLifecycleService: {
            createWork: jest.fn(),
            updateWork: jest.fn(),
            deleteWork: jest.fn(),
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
        itemHealthService: {} as any,
        communityPrProcessorService: {} as any,
        comparisonGenerationService: {} as any,
        workRepository: {} as any,
        sourceValidationService: {} as any,
        subscriptionService: {} as any,
        activityLogService: { log: jest.fn().mockResolvedValue(undefined) },
        templateCatalogService: { listTemplatesForUser: jest.fn() },
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
        {
            createWork: s.workLifecycleService.createWork,
            updateWork: s.workLifecycleService.updateWork,
            deleteWork: s.workLifecycleService.deleteWork,
            // syncFromDataRepository / generationService methods are unused in the
            // CRUD subset covered by this spec; provide placeholders to satisfy DI.
            syncFromDataRepository: jest.fn(),
        } as any,
        {
            generateItems: jest.fn(),
            updateItemsGenerator: jest.fn(),
            cancelGeneration: jest.fn(),
        } as any,
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
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — core CRUD endpoints', () => {
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
    // getWorks
    // -----------------------------------------------------------------------
    describe('getWorks', () => {
        it('forwards parsed limit/offset/search and the resolved user', async () => {
            s.workQueryService.getWorks.mockResolvedValue([{ id: 'w1' }]);

            const result = await controller.getWorks(auth, '10', '5', 'foo');

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workQueryService.getWorks).toHaveBeenCalledWith(
                { limit: 10, offset: 5, search: 'foo' },
                { id: 'user-1' },
            );
            expect(result).toEqual([{ id: 'w1' }]);
        });

        it('coerces NaN limit/offset to undefined and converts empty search to undefined', async () => {
            await controller.getWorks(auth, 'abc', 'def', '');

            expect(s.workQueryService.getWorks).toHaveBeenCalledWith(
                { limit: undefined, offset: undefined, search: undefined },
                { id: 'user-1' },
            );
        });

        it('passes undefined for all query fields when not provided', async () => {
            await controller.getWorks(auth);

            expect(s.workQueryService.getWorks).toHaveBeenCalledWith(
                { limit: undefined, offset: undefined, search: undefined },
                { id: 'user-1' },
            );
        });

        it('treats limit=0 as undefined (`0 && true === 0`, falsy short-circuit)', async () => {
            // The controller uses `parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined`,
            // so a parsed value of 0 short-circuits to undefined. This test pins
            // that behaviour so a future refactor must update it intentionally.
            await controller.getWorks(auth, '0', '0', undefined);

            expect(s.workQueryService.getWorks).toHaveBeenCalledWith(
                { limit: undefined, offset: undefined, search: undefined },
                { id: 'user-1' },
            );
        });
    });

    // -----------------------------------------------------------------------
    // getWorkStats
    // -----------------------------------------------------------------------
    describe('getWorkStats', () => {
        it('resolves user and forwards to workQueryService.getStats', async () => {
            s.workQueryService.getStats.mockResolvedValue({ totalWorks: 3 });

            const result = await controller.getWorkStats(auth);

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workQueryService.getStats).toHaveBeenCalledWith({ id: 'user-1' });
            expect(result).toEqual({ totalWorks: 3 });
        });

        it('propagates errors from getStats', async () => {
            s.workQueryService.getStats.mockRejectedValue(new Error('boom'));
            await expect(controller.getWorkStats(auth)).rejects.toThrow('boom');
        });
    });

    // -----------------------------------------------------------------------
    // getWebsiteTemplates
    // -----------------------------------------------------------------------
    describe('getWebsiteTemplates', () => {
        it('maps templates and preserves an explicit isDefault flag', async () => {
            s.templateCatalogService.listTemplatesForUser.mockResolvedValue({
                templates: [
                    {
                        id: 'a',
                        name: 'Alpha',
                        description: 'd1',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: true,
                    },
                    {
                        id: 'b',
                        name: 'Beta',
                        description: 'd2',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: false,
                    },
                ],
            });

            const result = await controller.getWebsiteTemplates(auth);

            expect(s.templateCatalogService.listTemplatesForUser).toHaveBeenCalledWith(
                'website',
                'auth-1',
            );
            expect(result).toEqual({
                status: 'success',
                templates: [
                    {
                        id: 'a',
                        name: 'Alpha',
                        description: 'd1',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: true,
                    },
                    {
                        id: 'b',
                        name: 'Beta',
                        description: 'd2',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: false,
                    },
                ],
            });
        });

        it('falls back to the global default-template id when no template advertises isDefault', async () => {
            s.templateCatalogService.listTemplatesForUser.mockResolvedValue({
                templates: [
                    {
                        id: 'default-template',
                        name: 'Default',
                        description: '',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: false,
                    },
                    {
                        id: 'other',
                        name: 'Other',
                        description: '',
                        sourceType: 'git',
                        originType: 'system',
                        isDefault: false,
                    },
                ],
            });

            const result = await controller.getWebsiteTemplates(auth);

            expect(result.templates[0].isDefault).toBe(true);
            expect(result.templates[1].isDefault).toBe(false);
        });

        it('returns an empty list when the catalog is empty', async () => {
            s.templateCatalogService.listTemplatesForUser.mockResolvedValue({ templates: [] });

            const result = await controller.getWebsiteTemplates(auth);

            expect(result).toEqual({ status: 'success', templates: [] });
        });
    });

    // -----------------------------------------------------------------------
    // createWork
    // -----------------------------------------------------------------------
    describe('createWork', () => {
        it('forwards the dto and resolved user to workLifecycleService.createWork', async () => {
            const dto: any = { name: 'My Work', description: 'desc' };
            s.workLifecycleService.createWork.mockResolvedValue({ id: 'w-new' });

            const result = await controller.createWork(auth, dto);

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workLifecycleService.createWork).toHaveBeenCalledWith(dto, { id: 'user-1' });
            expect(result).toEqual({ id: 'w-new' });
        });
    });

    // -----------------------------------------------------------------------
    // getWork
    // -----------------------------------------------------------------------
    describe('getWork', () => {
        it('resolves the user and forwards id + user', async () => {
            s.workQueryService.getWork.mockResolvedValue({ id: 'w-1' });

            const result = await controller.getWork(auth, 'w-1');

            expect(s.workQueryService.getWork).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(result).toEqual({ id: 'w-1' });
        });
    });

    // -----------------------------------------------------------------------
    // updateWork
    // -----------------------------------------------------------------------
    describe('updateWork', () => {
        it('returns the updateWork result and emits a WORK_UPDATED activity log', async () => {
            const dto: any = { name: 'New' };
            s.workLifecycleService.updateWork.mockResolvedValue({ id: 'w-1', updated: true });

            const result = await controller.updateWork(auth, 'w-1', dto);

            expect(s.workLifecycleService.updateWork).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledTimes(1);
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WORK_UPDATED',
                action: 'work.updated',
                status: 'COMPLETED',
                summary: 'Updated work settings',
            });
            expect(result).toEqual({ id: 'w-1', updated: true });
        });

        it('still returns successfully when the activity log promise rejects', async () => {
            s.workLifecycleService.updateWork.mockResolvedValue({ id: 'w-1' });
            s.activityLogService.log.mockRejectedValueOnce(new Error('log failure'));

            // Resolves cleanly because the controller `.catch(() => {})`s the log.
            await expect(controller.updateWork(auth, 'w-1', {} as any)).resolves.toEqual({
                id: 'w-1',
            });
        });

        it('does NOT emit an activity log if updateWork rejects', async () => {
            s.workLifecycleService.updateWork.mockRejectedValue(new Error('not found'));

            await expect(controller.updateWork(auth, 'w-1', {} as any)).rejects.toThrow(
                'not found',
            );
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // getWorkItems (cached)
    // -----------------------------------------------------------------------
    describe('getWorkItems', () => {
        it('uses the items cache key, runs the inner work, and forwards TTL', async () => {
            // Simulate a cache miss: cacheManager.wrap runs the inner factory.
            s.cacheManager.wrap.mockImplementation(async (_key, factory) => factory());
            s.workQueryService.workItems.mockResolvedValue(['item1']);

            const result = await controller.getWorkItems(auth, 'w-1');

            expect(s.cacheManager.wrap).toHaveBeenCalledTimes(1);
            const [key, , ttl] = s.cacheManager.wrap.mock.calls[0];
            expect(key).toBe(getWorkItemsCacheKey('w-1', 'auth-1'));
            expect(ttl).toBe(WORK_CACHE_TTL_MS);
            expect(s.workQueryService.workItems).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(result).toEqual(['item1']);
        });

        it('returns the cache hit value without invoking the inner factory', async () => {
            s.cacheManager.wrap.mockResolvedValue(['cached']);

            const result = await controller.getWorkItems(auth, 'w-1');

            expect(result).toEqual(['cached']);
            expect(s.workQueryService.workItems).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // getWorkConfig (cached)
    // -----------------------------------------------------------------------
    describe('getWorkConfig', () => {
        it('uses the config cache key and forwards user to workConfig', async () => {
            s.cacheManager.wrap.mockImplementation(async (_k, fn) => fn());
            s.workQueryService.workConfig.mockResolvedValue({ a: 1 });

            const result = await controller.getWorkConfig(auth, 'w-1');

            expect(s.cacheManager.wrap.mock.calls[0][0]).toBe(
                getWorkConfigCacheKey('w-1', 'auth-1'),
            );
            expect(s.cacheManager.wrap.mock.calls[0][2]).toBe(WORK_CACHE_TTL_MS);
            expect(s.workQueryService.workConfig).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(result).toEqual({ a: 1 });
        });
    });

    // -----------------------------------------------------------------------
    // getWebsiteSettings / updateWebsiteSettings
    // -----------------------------------------------------------------------
    describe('getWebsiteSettings', () => {
        it('forwards id + user to workQueryService.getWebsiteSettings', async () => {
            s.workQueryService.getWebsiteSettings.mockResolvedValue({ ok: true });

            const result = await controller.getWebsiteSettings(auth, 'w-1');

            expect(s.workQueryService.getWebsiteSettings).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(result).toEqual({ ok: true });
        });
    });

    describe('updateWebsiteSettings', () => {
        it('updates settings, invalidates caches, and logs WEBSITE_SETTINGS_UPDATED', async () => {
            const dto: any = { theme: 'dark' };
            s.workQueryService.updateWebsiteSettings.mockResolvedValue({ ok: true });

            const result = await controller.updateWebsiteSettings(auth, 'w-1', dto);

            expect(s.workQueryService.updateWebsiteSettings).toHaveBeenCalledWith(
                'w-1',
                { id: 'user-1' },
                dto,
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WEBSITE_SETTINGS_UPDATED',
                action: 'work.website_settings_updated',
                status: 'COMPLETED',
                summary: 'Updated website settings',
            });
            expect(result).toEqual({ ok: true });
        });

        it('does not invalidate caches or log when updateWebsiteSettings rejects', async () => {
            s.workQueryService.updateWebsiteSettings.mockRejectedValue(new Error('forbidden'));

            await expect(controller.updateWebsiteSettings(auth, 'w-1', {} as any)).rejects.toThrow(
                'forbidden',
            );
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('still returns when the activity log rejects', async () => {
            s.workQueryService.updateWebsiteSettings.mockResolvedValue({ ok: true });
            s.activityLogService.log.mockRejectedValueOnce(new Error('log down'));

            await expect(controller.updateWebsiteSettings(auth, 'w-1', {} as any)).resolves.toEqual(
                { ok: true },
            );
        });
    });

    // -----------------------------------------------------------------------
    // getWorkStatus (cached) — endpoint name `count`
    // -----------------------------------------------------------------------
    describe('getWorkStatus (count)', () => {
        it('uses the count cache key and forwards user', async () => {
            s.cacheManager.wrap.mockImplementation(async (_k, fn) => fn());
            s.workQueryService.workCount.mockResolvedValue({ count: 42 });

            const result = await controller.getWorkStatus(auth, 'w-1');

            expect(s.cacheManager.wrap.mock.calls[0][0]).toBe(
                getWorkCountCacheKey('w-1', 'auth-1'),
            );
            expect(s.workQueryService.workCount).toHaveBeenCalledWith('w-1', { id: 'user-1' });
            expect(result).toEqual({ count: 42 });
        });
    });

    // -----------------------------------------------------------------------
    // getWorkCategoriesTags (cached)
    // -----------------------------------------------------------------------
    describe('getWorkCategoriesTags', () => {
        it('uses the categories-tags cache key and forwards user', async () => {
            s.cacheManager.wrap.mockImplementation(async (_k, fn) => fn());
            s.workQueryService.workCategoriesTags.mockResolvedValue({ categories: [], tags: [] });

            const result = await controller.getWorkCategoriesTags(auth, 'w-1');

            expect(s.cacheManager.wrap.mock.calls[0][0]).toBe(
                getWorkCategoriesTagsCacheKey('w-1', 'auth-1'),
            );
            expect(s.workQueryService.workCategoriesTags).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(result).toEqual({ categories: [], tags: [] });
        });
    });

    // -----------------------------------------------------------------------
    // getWorkHistory
    // -----------------------------------------------------------------------
    describe('getWorkHistory', () => {
        it('parses limit/offset, forwards activityType, and wraps in {status, ...result}', async () => {
            s.workQueryService.workGenerationHistory.mockResolvedValue({
                items: [{ id: 'h1' }],
                total: 1,
            });

            const result = await controller.getWorkHistory(auth, 'w-1', '20', '0', 'generation');

            expect(s.workQueryService.workGenerationHistory).toHaveBeenCalledWith(
                'w-1',
                { id: 'user-1' },
                { limit: 20, offset: undefined, activityType: 'generation' },
            );
            // offset=0 short-circuits via `parsedOffset && !isNaN` to undefined.
            expect(result).toEqual({
                status: 'success',
                items: [{ id: 'h1' }],
                total: 1,
            });
        });

        it('handles undefined query params', async () => {
            s.workQueryService.workGenerationHistory.mockResolvedValue({ items: [] });

            await controller.getWorkHistory(auth, 'w-1');

            expect(s.workQueryService.workGenerationHistory).toHaveBeenCalledWith(
                'w-1',
                { id: 'user-1' },
                { limit: undefined, offset: undefined, activityType: undefined },
            );
        });

        it('coerces NaN limit/offset to undefined', async () => {
            s.workQueryService.workGenerationHistory.mockResolvedValue({});

            await controller.getWorkHistory(auth, 'w-1', 'foo', 'bar');

            expect(s.workQueryService.workGenerationHistory).toHaveBeenCalledWith(
                'w-1',
                { id: 'user-1' },
                { limit: undefined, offset: undefined, activityType: undefined },
            );
        });
    });

    // -----------------------------------------------------------------------
    // deleteWork
    // -----------------------------------------------------------------------
    describe('deleteWork', () => {
        it('forwards the dto, resolves the user, and logs WORK_DELETED', async () => {
            const dto: any = { deleteRepositories: true };
            s.workLifecycleService.deleteWork.mockResolvedValue({ status: 'deleted' });

            const result = await controller.deleteWork(auth, 'w-1', dto);

            expect(s.workLifecycleService.deleteWork).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WORK_DELETED',
                action: 'work.deleted',
                status: 'COMPLETED',
                summary: 'Deleted work',
            });
            expect(result).toEqual({ status: 'deleted' });
        });

        it('does not log when delete rejects', async () => {
            s.workLifecycleService.deleteWork.mockRejectedValue(new Error('locked'));

            await expect(controller.deleteWork(auth, 'w-1', {} as any)).rejects.toThrow('locked');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('still resolves when log rejects', async () => {
            s.workLifecycleService.deleteWork.mockResolvedValue({ status: 'deleted' });
            s.activityLogService.log.mockRejectedValueOnce(new Error('log down'));

            await expect(controller.deleteWork(auth, 'w-1', {} as any)).resolves.toEqual({
                status: 'deleted',
            });
        });
    });
});
