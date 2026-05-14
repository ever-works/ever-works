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
        PROMPTS_UPDATED: 'PROMPTS_UPDATED',
        IMPORT: 'IMPORT',
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
    workImportService: {
        analyzeRepository: Mock;
        analyzeForLinking: Mock;
        initiateImport: Mock;
        getUserRepositories: Mock;
    };
    repositoryManagementService: Record<string, never>;
    workOwnershipService: Record<string, never>;
    workAdvancedPromptsService: {
        getAdvancedPrompts: Mock;
        updateAdvancedPrompts: Mock;
    };
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
        workImportService: {
            analyzeRepository: jest.fn(),
            analyzeForLinking: jest.fn(),
            initiateImport: jest.fn(),
            getUserRepositories: jest.fn(),
        },
        repositoryManagementService: {} as any,
        workOwnershipService: {} as any,
        workAdvancedPromptsService: {
            getAdvancedPrompts: jest.fn(),
            updateAdvancedPrompts: jest.fn(),
        },
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
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — advanced-prompts + import endpoints', () => {
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
    // GET works/:id/advanced-prompts
    // -----------------------------------------------------------------------
    describe('getAdvancedPrompts', () => {
        it('forwards (id, auth.userId) directly without resolving user via authService', async () => {
            const fake: any = { entityListing: 'hello', entityDetail: null };
            s.workAdvancedPromptsService.getAdvancedPrompts.mockResolvedValue(fake);

            const result = await controller.getAdvancedPrompts(auth, 'w-1');

            expect(s.workAdvancedPromptsService.getAdvancedPrompts).toHaveBeenCalledWith(
                'w-1',
                'auth-1',
            );
            // The GET endpoint deliberately skips authService.getUser — assert that.
            expect(s.authService.getUser).not.toHaveBeenCalled();
            // Read endpoints emit no activity log.
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(fake);
        });

        it('propagates service errors verbatim', async () => {
            s.workAdvancedPromptsService.getAdvancedPrompts.mockRejectedValue(
                new Error('not found'),
            );

            await expect(controller.getAdvancedPrompts(auth, 'w-1')).rejects.toThrow('not found');
        });
    });

    // -----------------------------------------------------------------------
    // PUT works/:id/advanced-prompts
    // -----------------------------------------------------------------------
    describe('updateAdvancedPrompts', () => {
        it('forwards (id, dto, auth.userId), logs PROMPTS_UPDATED, and returns the service result', async () => {
            const dto: any = { entityListing: 'new-listing', entityDetail: 'new-detail' };
            const fake: any = { ...dto, savedAt: 'now' };
            s.workAdvancedPromptsService.updateAdvancedPrompts.mockResolvedValue(fake);

            const result = await controller.updateAdvancedPrompts(auth, 'w-1', dto);

            expect(s.workAdvancedPromptsService.updateAdvancedPrompts).toHaveBeenCalledWith(
                'w-1',
                dto,
                'auth-1',
            );
            expect(s.authService.getUser).not.toHaveBeenCalled();
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'PROMPTS_UPDATED',
                action: 'work.prompts_updated',
                status: 'COMPLETED',
                summary: 'Updated advanced prompts',
            });
            expect(result).toBe(fake);
        });

        it('does not emit a log when the service rejects', async () => {
            s.workAdvancedPromptsService.updateAdvancedPrompts.mockRejectedValue(
                new Error('forbidden'),
            );

            await expect(controller.updateAdvancedPrompts(auth, 'w-1', {} as any)).rejects.toThrow(
                'forbidden',
            );
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('swallows fire-and-forget activity-log rejection', async () => {
            s.workAdvancedPromptsService.updateAdvancedPrompts.mockResolvedValue({
                ok: true,
            } as any);
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(controller.updateAdvancedPrompts(auth, 'w-1', {} as any)).resolves.toEqual(
                { ok: true },
            );
        });
    });

    // -----------------------------------------------------------------------
    // POST works/import/analyze
    // -----------------------------------------------------------------------
    describe('analyzeRepository', () => {
        it('forwards (dto, user) to the import service and emits NO activity log', async () => {
            const dto: any = { sourceUrl: 'https://github.com/foo/bar' };
            const fake: any = { kind: 'directory' };
            s.workImportService.analyzeRepository.mockResolvedValue(fake);

            const result = await controller.analyzeRepository(auth, dto);

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workImportService.analyzeRepository).toHaveBeenCalledWith(dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(fake);
        });

        it('propagates service errors', async () => {
            s.workImportService.analyzeRepository.mockRejectedValue(new Error('rate limited'));

            await expect(controller.analyzeRepository(auth, {} as any)).rejects.toThrow(
                'rate limited',
            );
        });
    });

    // -----------------------------------------------------------------------
    // POST works/import/analyze-for-linking
    // -----------------------------------------------------------------------
    describe('analyzeForLinking', () => {
        it('forwards (dto, user) and emits NO activity log', async () => {
            const dto: any = { sourceUrl: 'https://github.com/foo/bar' };
            const fake: any = { mode: 'linking', candidateBranch: 'main' };
            s.workImportService.analyzeForLinking.mockResolvedValue(fake);

            const result = await controller.analyzeForLinking(auth, dto);

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workImportService.analyzeForLinking).toHaveBeenCalledWith(dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(fake);
        });
    });

    // -----------------------------------------------------------------------
    // POST works/import (importWork)
    // -----------------------------------------------------------------------
    describe('importWork', () => {
        it('forwards (dto, user), logs IMPORT with full source details, and returns the service result', async () => {
            const dto: any = {
                sourceUrl: 'https://github.com/foo/bar',
                sourceType: 'directory',
                gitProvider: 'github',
            };
            const fake: any = { workId: 'w-new', status: 'queued' };
            s.workImportService.initiateImport.mockResolvedValue(fake);

            const result = await controller.importWork(auth, dto);

            expect(s.workImportService.initiateImport).toHaveBeenCalledWith(dto, {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                actionType: 'IMPORT',
                action: 'work.import_started',
                status: 'COMPLETED',
                summary: 'Triggered work import',
                details: {
                    sourceUrl: 'https://github.com/foo/bar',
                    sourceType: 'directory',
                    gitProvider: 'github',
                },
            });
            // No workId on the activity log payload — pin that.
            const call = s.activityLogService.log.mock.calls[0][0];
            expect(call).not.toHaveProperty('workId');
            expect(result).toBe(fake);
        });

        it('forwards undefined fields verbatim into the log details when the dto omits them', async () => {
            const dto: any = { sourceUrl: 'https://github.com/foo/bar' };
            s.workImportService.initiateImport.mockResolvedValue({} as any);

            await controller.importWork(auth, dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: {
                        sourceUrl: 'https://github.com/foo/bar',
                        sourceType: undefined,
                        gitProvider: undefined,
                    },
                }),
            );
        });

        it('does not emit a log when initiateImport rejects', async () => {
            s.workImportService.initiateImport.mockRejectedValue(new Error('quota exceeded'));

            await expect(controller.importWork(auth, {} as any)).rejects.toThrow('quota exceeded');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('swallows fire-and-forget activity-log rejection', async () => {
            s.workImportService.initiateImport.mockResolvedValue({ workId: 'w-1' } as any);
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(controller.importWork(auth, {} as any)).resolves.toEqual({
                workId: 'w-1',
            });
        });
    });

    // -----------------------------------------------------------------------
    // GET works/import/repositories (getUserRepositories)
    // -----------------------------------------------------------------------
    describe('getUserRepositories', () => {
        it('parses page/perPage with parseInt(_, 10) and forwards string fields through "|| undefined"', async () => {
            const fake: any = { items: [] };
            s.workImportService.getUserRepositories.mockResolvedValue(fake);

            const result = await controller.getUserRepositories(
                auth,
                'github',
                '2',
                '50',
                'next',
                'octocat',
                'org',
            );

            expect(s.workImportService.getUserRepositories).toHaveBeenCalledWith(
                {
                    gitProvider: 'github',
                    page: 2,
                    perPage: 50,
                    search: 'next',
                    owner: 'octocat',
                    type: 'org',
                },
                { id: 'user-1' },
            );
            expect(result).toBe(fake);
        });

        it('passes undefined for page / perPage / search / owner / type when omitted', async () => {
            s.workImportService.getUserRepositories.mockResolvedValue({} as any);

            await controller.getUserRepositories(auth, 'github');

            expect(s.workImportService.getUserRepositories).toHaveBeenCalledWith(
                {
                    gitProvider: 'github',
                    page: undefined,
                    perPage: undefined,
                    search: undefined,
                    owner: undefined,
                    type: undefined,
                },
                { id: 'user-1' },
            );
        });

        it('coerces empty-string search/owner to undefined via "|| undefined"', async () => {
            s.workImportService.getUserRepositories.mockResolvedValue({} as any);

            await controller.getUserRepositories(auth, 'github', undefined, undefined, '', '');

            expect(s.workImportService.getUserRepositories).toHaveBeenCalledWith(
                expect.objectContaining({ search: undefined, owner: undefined }),
                expect.anything(),
            );
        });

        it('parses page/perPage even when one is provided alone', async () => {
            s.workImportService.getUserRepositories.mockResolvedValue({} as any);

            await controller.getUserRepositories(auth, 'github', '5', undefined);

            expect(s.workImportService.getUserRepositories).toHaveBeenCalledWith(
                expect.objectContaining({ page: 5, perPage: undefined }),
                expect.anything(),
            );
        });

        it('honors the type=user passthrough', async () => {
            s.workImportService.getUserRepositories.mockResolvedValue({} as any);

            await controller.getUserRepositories(
                auth,
                'github',
                undefined,
                undefined,
                undefined,
                undefined,
                'user',
            );

            expect(s.workImportService.getUserRepositories).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'user' }),
                expect.anything(),
            );
        });

        it('does NOT emit any activity log', async () => {
            s.workImportService.getUserRepositories.mockResolvedValue({} as any);

            await controller.getUserRepositories(auth, 'github');

            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('propagates service errors', async () => {
            s.workImportService.getUserRepositories.mockRejectedValue(new Error('401'));

            await expect(controller.getUserRepositories(auth, 'github')).rejects.toThrow('401');
        });
    });
});
