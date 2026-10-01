// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph (database, entities, services, etc.).
//
// APW-01 T18 added the two constructor stubs: `quickCreateWork` builds a
// `CreateWorkDto` and a `CreateItemsGeneratorDto` with `new`, so a bare `{}` made
// the quick-create half of the app-kind coverage unreachable (`new undefined()`).
// Nothing else about either mock changed.
jest.mock('@ever-works/agent/dto', () => ({
    CreateWorkDto: class CreateWorkDto {},
}));
jest.mock('@ever-works/agent/items-generator', () => ({
    CreateItemsGeneratorDto: class CreateItemsGeneratorDto {},
}));
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
// APW-01 T18 — nothing else is mocked for the App Work block: the assertions there
// are driven by the REAL `AppWorkCreateService`, imported by path (the
// `@ever-works/agent/app-works` barrel would drag the whole agent module graph in, and
// is not the module the route loads either).
jest.mock('../auth', () => {
    // APW-01 T18 — `CurrentUser` is the REAL decorator, rebuilt, rather than the
    // `() => () => undefined` the original mock returned: a parameter decorator that
    // registers nothing erases the route's own parameter metadata, which the App Work
    // block reads to prove the handler takes no client input. `AuthService` and
    // `AuthSessionGuard` are untouched stubs, and every existing test in this file
    // passes its `auth` argument explicitly, so nothing else changes.
    const { createParamDecorator } = jest.requireActual('@nestjs/common');
    return {
        AuthService: class {},
        AuthSessionGuard: class {},
        CurrentUser: createParamDecorator(
            (
                _data: unknown,
                ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } },
            ) => ctx.switchToHttp().getRequest().user,
        ),
    };
});

import { ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA, CUSTOM_ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { DataSource, EntitySchema } from 'typeorm';
import { WorksController } from './works.controller';
// APW-01 T18 — the REAL `AppWorkCreateService`, imported by path rather than through
// `@ever-works/agent/app-works`: that barrel is not what this route's module loads for
// the create path (`WorkModule` gets it through `AppWorksModule`) and it drags the
// agent's whole Nest module graph into a controller spec. This one file is the create
// path the endpoint reaches.
import { AppWorkCreateService } from '../../../../packages/agent/src/app-works/app-work-create.service';
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

/**
 * Build the controller over the stubs.
 *
 * APW-01 T18 added the optional second argument: the App Work cases need the
 * **real** create path behind `POST works` (and behind `POST works/quick-create`),
 * because the refusals they assert are the create path's own. Omitting it keeps
 * every existing call site on the mock, byte for byte.
 */
function makeController(s: Stubs, lifecycleService?: unknown): WorksController {
    return new WorksController(
        s.cacheManager as any,
        s.cacheEntryRepository as any,
        s.workQueryService as any,
        (lifecycleService ?? {
            createWork: s.workLifecycleService.createWork,
            updateWork: s.workLifecycleService.updateWork,
            deleteWork: s.workLifecycleService.deleteWork,
            // syncFromDataRepository / generationService methods are unused in the
            // CRUD subset covered by this spec; provide placeholders to satisfy DI.
            syncFromDataRepository: jest.fn(),
        }) as any,
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
        { rotate: jest.fn(), getOrGenerate: jest.fn() } as any,
        {
            isEnabled: jest.fn().mockReturnValue(false),
            verify: jest.fn().mockResolvedValue({ success: true, skipped: true }),
        } as any,
        { emit: jest.fn() } as any,
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
        /**
         * What `WorkLifecycleService.deleteWork` answers once the row is gone
         * (`DeleteWorkResponseDto`): the message is where `withDeleteNotes` names every
         * repository that stayed and why.
         */
        const completedDelete = {
            status: 'success',
            slug: 'my-work',
            message:
                "Work 'my-work' and associated repositories have been deleted. " +
                'Kept: acme/my-work (a repository this Work did not create).',
            deleted_repositories: ['acme/my-work-data'],
        };

        /**
         * What it answers while the App runtime tears the workloads down (APW-01 T39,
         * FR-40a): the row stays and reads **Deleting…** until
         * `completeAppWorkDeletion(workId)` removes it.
         */
        const pendingAppDelete = {
            status: 'pending',
            slug: 'my-app',
            deleting: true,
            message:
                "Work 'my-app' is being deleted and keeps its row until the App runtime has " +
                'removed its workloads. Kept: acme/my-app (the fork stays on GitHub).',
            deleted_repositories: [],
        };

        it('forwards the dto, resolves the user, and logs WORK_DELETED', async () => {
            // ACC-NEG-07 — this case used to pin `workId: 'w-1'` on the log of a
            // COMPLETED delete, and no `details`. That call can never land: by the time
            // it runs `deleteWork` has removed the row, `activity_log.workId` is a
            // foreign key to `works`, and the insert is refused — then swallowed by the
            // handler's `.catch(() => {})`. The pinned shape encoded the defect, so it is
            // corrected here rather than kept: the identity of the deleted Work and what
            // was kept move into `details`.
            const dto: any = { deleteRepositories: true };
            s.workLifecycleService.deleteWork.mockResolvedValue(completedDelete);

            const result = await controller.deleteWork(auth, 'w-1', dto);

            expect(s.workLifecycleService.deleteWork).toHaveBeenCalledWith('w-1', dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                actionType: 'WORK_DELETED',
                action: 'work.deleted',
                status: 'COMPLETED',
                summary: 'Deleted work',
                details: {
                    workId: 'w-1',
                    slug: 'my-work',
                    deletedRepositories: ['acme/my-work-data'],
                    message: completedDelete.message,
                },
            });
            expect(result).toEqual(completedDelete);
        });

        it('logs a completed delete without the foreign key, naming the Work and what was kept in details (ACC-NEG-07)', async () => {
            s.workLifecycleService.deleteWork.mockResolvedValue(completedDelete);

            await controller.deleteWork(auth, 'w-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledTimes(1);
            const [entry] = s.activityLogService.log.mock.calls[0];
            // Absent, not merely `undefined`-valued: the row this would reference is gone.
            expect(entry).not.toHaveProperty('workId');
            expect(entry.details).toEqual(
                expect.objectContaining({
                    workId: 'w-1',
                    slug: 'my-work',
                    deletedRepositories: ['acme/my-work-data'],
                }),
            );
            expect(entry.details.message).toContain('Kept: acme/my-work');
        });

        it('keeps workId for a pending App Work delete, whose row remains and reads Deleting…', async () => {
            s.workLifecycleService.deleteWork.mockResolvedValue(pendingAppDelete);

            const result = await controller.deleteWork(auth, 'w-1', {} as any);

            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WORK_DELETED',
                action: 'work.deleted',
                status: 'COMPLETED',
                summary: 'Deleting work',
                details: {
                    workId: 'w-1',
                    slug: 'my-app',
                    deletedRepositories: [],
                    message: pendingAppDelete.message,
                },
            });
            expect(result).toEqual(pendingAppDelete);
        });

        it('defaults deletedRepositories to an empty list when the answer carries none', async () => {
            s.workLifecycleService.deleteWork.mockResolvedValue({
                status: 'success',
                slug: 'bare',
                message: "Work 'bare' and associated repositories have been deleted",
            });

            await controller.deleteWork(auth, 'w-1', {} as any);

            const [entry] = s.activityLogService.log.mock.calls[0];
            expect(entry).not.toHaveProperty('workId');
            expect(entry.details.deletedRepositories).toEqual([]);
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

        /**
         * ACC-NEG-07 through a REAL foreign key. The mocked log above only pins the
         * call's shape, and a mock cannot refuse anything: the defect was that the
         * database did. These cases write through `activity_log.workId → works.id`
         * (`ON DELETE SET NULL`, as `activity-log.entity.ts` declares it) on
         * better-sqlite3 — the driver the PR lane runs, which TypeORM opens with
         * `PRAGMA foreign_keys = ON` — and the lifecycle mock removes the Work row
         * before it answers, in the order `WorkLifecycleService.deleteWork` does.
         */
        describe('against the activity_log → works foreign key (better-sqlite3)', () => {
            interface WorkRow {
                id: string;
            }
            interface ActivityRow {
                id: string;
                userId: string;
                workId: string | null;
                actionType: string;
                action: string;
                status: string;
                summary: string;
                details: Record<string, any> | null;
            }

            const workSchema = new EntitySchema<WorkRow>({
                name: 'Work',
                tableName: 'works',
                columns: { id: { type: String, primary: true } },
            });
            const activitySchema = new EntitySchema<ActivityRow>({
                name: 'ActivityLog',
                tableName: 'activity_log',
                columns: {
                    id: { type: String, primary: true, generated: 'uuid' },
                    userId: { type: String },
                    workId: { type: String, nullable: true },
                    actionType: { type: String },
                    action: { type: String },
                    status: { type: String },
                    summary: { type: String },
                    details: { type: 'simple-json', nullable: true },
                },
                relations: {
                    work: {
                        type: 'many-to-one',
                        target: 'Work',
                        nullable: true,
                        onDelete: 'SET NULL',
                        joinColumn: { name: 'workId' },
                    },
                } as any,
            });

            let dataSource: DataSource;

            beforeEach(async () => {
                dataSource = await new DataSource({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: [workSchema, activitySchema],
                    synchronize: true,
                }).initialize();
                await dataSource.getRepository(workSchema).insert({ id: 'w-1' });
                s.activityLogService.log.mockImplementation((entry: Partial<ActivityRow>) =>
                    dataSource.getRepository(activitySchema).save({ ...entry }),
                );
            });

            afterEach(async () => {
                if (dataSource?.isInitialized) {
                    await dataSource.destroy();
                }
            });

            /** The handler does not await its log; the test does, so a refusal fails it. */
            async function theLogWrite(): Promise<void> {
                expect(s.activityLogService.log).toHaveBeenCalledTimes(1);
                await s.activityLogService.log.mock.results[0].value;
            }

            it('a completed delete lands its work.deleted row, naming the Work and what was kept', async () => {
                s.workLifecycleService.deleteWork.mockImplementation(async (id: string) => {
                    await dataSource.getRepository(workSchema).delete(id);
                    return completedDelete;
                });

                await controller.deleteWork(auth, 'w-1', {} as any);
                await theLogWrite();

                const rows = await dataSource
                    .getRepository(activitySchema)
                    .findBy({ action: 'work.deleted' });
                expect(rows).toHaveLength(1);
                expect(rows[0].workId).toBeNull();
                expect(rows[0].details).toEqual(
                    expect.objectContaining({ workId: 'w-1', slug: 'my-work' }),
                );
                expect(rows[0].details?.message).toContain('Kept: acme/my-work');
            });

            it('a pending App Work delete lands referencing its row, which the foreign key clears once the row goes', async () => {
                s.workLifecycleService.deleteWork.mockResolvedValue(pendingAppDelete);

                await controller.deleteWork(auth, 'w-1', {} as any);
                await theLogWrite();

                const activities = dataSource.getRepository(activitySchema);
                const logged = await activities.findOneByOrFail({ action: 'work.deleted' });
                expect(logged.workId).toBe('w-1');
                expect(logged.summary).toBe('Deleting work');

                // `completeAppWorkDeletion` removes the row later (APW-06); the record
                // stays, and still names the Work in `details`.
                await dataSource.getRepository(workSchema).delete('w-1');
                const kept = await activities.findOneByOrFail({ id: logged.id });
                expect(kept.workId).toBeNull();
                expect(kept.details?.workId).toBe('w-1');
            });
        });
    });

    // -----------------------------------------------------------------------
    // APW-01 T18 — the create endpoint's App Work coverage
    // -----------------------------------------------------------------------
    describe('App Work create (APW-01 T18)', () => {
        const APP_URL = 'https://github.com/upstream/widgets';
        const originalFlag = process.env.EVER_WORKS_APP_WORKS_ENABLED;

        /** A creatable `app` body: the mode and the owner are the two fields T18 adds. */
        const appBody = (overrides: Record<string, unknown> = {}) => ({
            slug: 'widgets',
            name: 'Widgets',
            description: 'A widgets app',
            kind: 'app',
            repositoryUrl: APP_URL,
            repositoryMode: 'fork',
            targetOwner: 'acme',
            ...overrides,
        });

        /**
         * The seam `POST works` calls, bound to the **real** create path.
         *
         * `WorkLifecycleService.createWork` normalises the kind and then delegates to
         * `AppWorkCreateService.create(dto, user)` — the one-line `app` branch T13 added
         * (`work-lifecycle.service.ts:334-341`). That class cannot be imported into this
         * app's jest environment: it reaches `p-map` and `github-slugger` (ESM-only
         * packages) through the generators, which jest cannot parse — which is why this
         * spec hand-builds the controller in the first place. Binding the seam to the
         * service that branch calls keeps **production code**, not a copy of it, behind
         * every refusal asserted below; the delegation itself is T13's and is what
         * `packages/agent/src/services/work.module.spec.ts` pins (the module must import
         * `AppWorksModule` for the branch to resolve at all).
         */
        function makeAppCreatePath() {
            const gitFacade = { getRepository: jest.fn() };
            const workRepository = {
                create: jest.fn(),
                withTransaction: jest.fn(),
                existsByUserAndSlug: jest.fn().mockResolvedValue(false),
                findAppWorksByDataRepository: jest.fn().mockResolvedValue([]),
            };
            const appWorkCreate = new AppWorkCreateService(
                // Never reached: every refusal below happens before the inspection.
                { inspect: jest.fn() } as never,
                { runExclusive: jest.fn() } as never,
                gitFacade as never,
                {} as never,
                workRepository as never,
                { create: jest.fn() } as never,
            );

            return {
                // The lifecycle seam, with the same `(dto, user)` shape the controller
                // calls it through.
                lifecycle: {
                    createWork: (dto: unknown, user: unknown) =>
                        appWorkCreate.create(dto as never, user as never),
                },
                workRepository,
                gitFacade,
                appWorkCreate,
            };
        }

        beforeEach(() => {
            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
        });

        afterEach(() => {
            if (originalFlag === undefined) {
                delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
            } else {
                process.env.EVER_WORKS_APP_WORKS_ENABLED = originalFlag;
            }
        });

        it('documents the 409 and 503 an app create adds to POST works', () => {
            const responses = Reflect.getMetadata(
                'swagger/apiResponse',
                WorksController.prototype.createWork,
            ) as Record<string, { description?: string }>;

            expect(Object.keys(responses).sort()).toEqual(['200', '400', '409', '503']);
            expect(responses['409'].description).toContain('create_in_progress');
            expect(responses['409'].description).toContain('app_work_exists');
            expect(responses['503'].description).toContain('rate_limited');
        });

        it('carries an app body with its mode and owner through to the service', async () => {
            const dto = appBody();
            s.workLifecycleService.createWork.mockResolvedValue({
                status: 'success',
                work: { id: 'w-app' },
            });

            const result = await controller.createWork(auth, dto as any);

            expect(s.workLifecycleService.createWork).toHaveBeenCalledTimes(1);
            expect(s.workLifecycleService.createWork).toHaveBeenCalledWith(dto, { id: 'user-1' });
            expect(result).toEqual({ status: 'success', work: { id: 'w-app' } });
        });

        it('refuses an app body with no repositoryMode at the pipe, naming the field', async () => {
            // The platform's own pipe (`apps/api/src/main.ts:199-205`) over the DTO the
            // request is validated against — the real one, not a double: the rejected
            // field has to be `repositoryMode` because that is what §3.3 declares.
            const { CreateWorkDto } = jest.requireActual<
                typeof import('../../../../packages/agent/src/dto/create-work.dto')
            >('../../../../packages/agent/src/dto/create-work.dto');
            const pipe = new ValidationPipe({
                whitelist: true,
                transform: true,
                forbidNonWhitelisted: true,
            });
            const { repositoryMode: _omitted, ...body } = appBody();

            await expect(
                pipe.transform(body, { type: 'body', metatype: CreateWorkDto }),
            ).rejects.toMatchObject({
                status: 400,
                response: { message: expect.arrayContaining(['repositoryMode must be defined']) },
            });
        });

        it('refuses the same body at the create path — which repeats the rule — before any row', async () => {
            const { lifecycle, workRepository } = makeAppCreatePath();
            const controllerWithRealPath = makeController(s, lifecycle);
            const { repositoryMode: _omitted, ...body } = appBody();

            await expect(
                (controllerWithRealPath as any).createWork(auth, body),
            ).rejects.toMatchObject({
                status: 400,
                response: { message: 'repositoryMode must be defined' },
            });

            expect(workRepository.create).not.toHaveBeenCalled();
            expect(workRepository.withTransaction).not.toHaveBeenCalled();
        });

        it('refuses an app create with the instance setting off, before any row and any provider call', async () => {
            delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
            const { lifecycle, workRepository, gitFacade } = makeAppCreatePath();
            const controllerWithRealPath = makeController(s, lifecycle);

            await expect(
                (controllerWithRealPath as any).createWork(auth, appBody()),
            ).rejects.toMatchObject({
                status: 400,
                response: {
                    status: 'error',
                    code: 'app_works_disabled',
                    message: 'Creating App Works is turned off on this installation.',
                },
            });

            expect(workRepository.create).not.toHaveBeenCalled();
            expect(gitFacade.getRepository).not.toHaveBeenCalled();
        });

        it('takes no client input at all, so no header can change that refusal', () => {
            // ACC-01-13's "whichever client calls it" is a property of the ROUTE: the
            // handler is handed a session and a body and nothing else, so there is no
            // User-Agent, no client header and no IP for a decision to depend on.
            //
            // Nest keys the parameter metadata by class + method name, and the key names
            // the parameter's kind: `3:<index>` is `RouteParamtypes.BODY`, and a custom
            // decorator's key ends with `__customRouteArgs__:<index>` (Nest builds the
            // prefix from a uid). `@Headers()`, `@Req()`, `@Ip()`, `@Query()` and
            // `@Param()` would each have to appear here under their own number, and the
            // handler declares exactly two parameters.
            const args = Reflect.getMetadata(
                ROUTE_ARGS_METADATA,
                WorksController,
                'createWork',
            ) as Record<string, { index: number }>;

            expect(WorksController.prototype.createWork.length).toBe(2);
            expect(Object.keys(args)).toHaveLength(2);
            expect(Object.keys(args).filter((key) => key.startsWith('3:'))).toEqual(['3:1']);
            expect(
                Object.keys(args).filter((key) => key.endsWith(`${CUSTOM_ROUTE_ARGS_METADATA}:0`)),
            ).toHaveLength(1);
        });

        it('forwards kind app from quick-create with neither a URL nor a mode', async () => {
            // quick-create carries no `repositoryUrl` and no `repositoryMode`
            // (`QuickCreateWorkDto` has neither), which is why the kind can never be
            // created through it; what this asserts is the shape it forwards.
            s.authService.getUser.mockResolvedValue({ id: 'user-1' });
            s.workLifecycleService.createWork.mockResolvedValue({
                status: 'success',
                work: { id: 'w-q' },
            });
            // The generation leg is not what this test is about — it is the step that runs
            // after a create succeeded, and `makeController` leaves it bare.
            (controller as any).workGenerationService = {
                generateItems: jest.fn().mockResolvedValue({ historyId: 'g-1', message: 'ok' }),
            };

            await (controller as any).quickCreateWork(auth, {
                slug: 'widgets',
                name: 'Widgets',
                description: 'A widgets app',
                prompt: 'build me widgets',
                kind: 'app',
            });

            const forwarded = s.workLifecycleService.createWork.mock.calls[0][0];
            expect(forwarded.kind).toBe('app');
            expect(forwarded.repositoryUrl).toBeUndefined();
            expect(forwarded.repositoryMode).toBeUndefined();
            expect(forwarded.targetOwner).toBeUndefined();
        });

        it('refuses quick-create with kind app before any row, from the real create path', async () => {
            const { lifecycle, workRepository } = makeAppCreatePath();
            const controllerWithRealPath = makeController(s, lifecycle);

            await expect(
                (controllerWithRealPath as any).quickCreateWork(auth, {
                    slug: 'widgets',
                    name: 'Widgets',
                    description: 'A widgets app',
                    prompt: 'build me widgets',
                    kind: 'app',
                }),
            ).rejects.toMatchObject({
                status: 400,
                response: { status: 'error', code: 'invalid_url' },
            });

            expect(workRepository.create).not.toHaveBeenCalled();
            expect(workRepository.findAppWorksByDataRepository).not.toHaveBeenCalled();
        });

        it('drops a repositoryUrl the quick-create body carries — the route has no such field', async () => {
            const { lifecycle, workRepository } = makeAppCreatePath();
            const controllerWithRealPath = makeController(s, lifecycle);

            // `QuickCreateWorkDto` declares no `repositoryUrl`, and the handler builds its
            // `CreateWorkDto` field by field, so a URL on the body is dropped before the
            // create path ever sees it. The refusal is therefore the missing URL — and an
            // app-kind quick-create can never get as far as the missing mode.
            await expect(
                (controllerWithRealPath as any).quickCreateWork(auth, {
                    slug: 'widgets',
                    name: 'Widgets',
                    description: 'A widgets app',
                    prompt: 'build me widgets',
                    kind: 'app',
                    repositoryUrl: APP_URL,
                }),
            ).rejects.toMatchObject({
                status: 400,
                response: { status: 'error', code: 'invalid_url' },
            });

            expect(workRepository.create).not.toHaveBeenCalled();
        });

        it('refuses the quick-create shape at the create path with the mode rule once a URL is present', async () => {
            const { appWorkCreate, workRepository } = makeAppCreatePath();
            const forwarded = {
                slug: 'widgets',
                name: 'Widgets',
                description: 'A widgets app',
                kind: 'app',
                repositoryUrl: APP_URL,
            };

            // This is the shape the route forwards, plus the URL it cannot carry: the
            // mode the quick-create body has no field for is what refuses it.
            await expect(
                appWorkCreate.create(forwarded as never, {} as never),
            ).rejects.toMatchObject({
                status: 400,
                response: { message: 'repositoryMode must be defined' },
            });

            expect(workRepository.create).not.toHaveBeenCalled();
        });
    });
});
