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
        WEBSITE_SETTINGS_UPDATED: 'WEBSITE_SETTINGS_UPDATED',
        WORK_UPDATED: 'WORK_UPDATED',
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
    workLifecycleService: {
        switchWebsiteTemplate: Mock;
        syncFromDataRepository: Mock;
    };
    workGenerationService: {
        updateDomainType: Mock;
        regenerateMarkdown: Mock;
        updateReadme: Mock;
        updateWebsiteRepository: Mock;
    };
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: {
        getRepositoriesStatus: Mock;
        updateRepositoryVisibility: Mock;
    };
    workOwnershipService: { ensureAccess: Mock };
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
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {} as any,
        workLifecycleService: {
            switchWebsiteTemplate: jest.fn(),
            syncFromDataRepository: jest.fn(),
        },
        workGenerationService: {
            updateDomainType: jest.fn(),
            regenerateMarkdown: jest.fn(),
            updateReadme: jest.fn(),
            updateWebsiteRepository: jest.fn(),
        },
        authService: { getUser: jest.fn() },
        workDetailService: {} as any,
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {
            getRepositoriesStatus: jest.fn(),
            updateRepositoryVisibility: jest.fn(),
        },
        workOwnershipService: { ensureAccess: jest.fn() },
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

describe('WorksController — domain + repository endpoints', () => {
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
    // updateDomainType
    // -----------------------------------------------------------------------
    describe('updateDomainType', () => {
        it('forwards positional args (id, domainType, user, manuallySet=true by default) and emits NO activity log', async () => {
            s.workGenerationService.updateDomainType.mockResolvedValue({ ok: true });

            const result = await controller.updateDomainType(auth, 'w-1', {
                domainType: 'custom',
            });

            expect(s.workGenerationService.updateDomainType).toHaveBeenCalledWith(
                'w-1',
                'custom',
                { id: 'user-1' },
                true,
            );
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toEqual({ ok: true });
        });

        it('respects an explicit manuallySet=false flag', async () => {
            s.workGenerationService.updateDomainType.mockResolvedValue(undefined);

            await controller.updateDomainType(auth, 'w-1', {
                domainType: 'auto',
                manuallySet: false,
            });

            expect(s.workGenerationService.updateDomainType).toHaveBeenCalledWith(
                'w-1',
                'auto',
                { id: 'user-1' },
                false,
            );
        });

        it('propagates service errors and still does not log', async () => {
            s.workGenerationService.updateDomainType.mockRejectedValue(new Error('forbidden'));

            await expect(
                controller.updateDomainType(auth, 'w-1', { domainType: 'custom' }),
            ).rejects.toThrow('forbidden');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // regenerateMarkdown
    // -----------------------------------------------------------------------
    describe('regenerateMarkdown', () => {
        it('forwards (id, user) and logs SETTINGS_UPDATED with action work.markdown_regenerated', async () => {
            s.workGenerationService.regenerateMarkdown.mockResolvedValue({ files: 12 });

            const result = await controller.regenerateMarkdown(auth, 'w-1');

            expect(s.workGenerationService.regenerateMarkdown).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'work.markdown_regenerated',
                status: 'COMPLETED',
                summary: 'Regenerated markdown',
            });
            expect(result).toEqual({ files: 12 });
        });

        it('does not emit a log when the service rejects', async () => {
            s.workGenerationService.regenerateMarkdown.mockRejectedValue(new Error('boom'));

            await expect(controller.regenerateMarkdown(auth, 'w-1')).rejects.toThrow('boom');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });

        it('swallows a fire-and-forget activity-log rejection without throwing', async () => {
            s.workGenerationService.regenerateMarkdown.mockResolvedValue({ files: 1 });
            s.activityLogService.log.mockRejectedValue(new Error('log down'));

            await expect(controller.regenerateMarkdown(auth, 'w-1')).resolves.toEqual({
                files: 1,
            });
        });
    });

    // -----------------------------------------------------------------------
    // updateReadme
    // -----------------------------------------------------------------------
    describe('updateReadme', () => {
        it('forwards (id, user) and logs SETTINGS_UPDATED with action work.readme_updated', async () => {
            s.workGenerationService.updateReadme.mockResolvedValue({ commit: 'abc123' });

            const result = await controller.updateReadme(auth, 'w-1');

            expect(s.workGenerationService.updateReadme).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'SETTINGS_UPDATED',
                action: 'work.readme_updated',
                status: 'COMPLETED',
                summary: 'Updated README',
            });
            expect(result).toEqual({ commit: 'abc123' });
        });

        it('does not emit a log when updateReadme rejects', async () => {
            s.workGenerationService.updateReadme.mockRejectedValue(new Error('git error'));

            await expect(controller.updateReadme(auth, 'w-1')).rejects.toThrow('git error');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // updateWebsiteRepository (POST works/:id/update-website)
    // -----------------------------------------------------------------------
    describe('updateWebsiteRepository', () => {
        it('forwards (id, user) and logs WEBSITE_SETTINGS_UPDATED with action work.website_updated', async () => {
            const fake: any = { status: 'updated', commit: 'sha-1' };
            s.workGenerationService.updateWebsiteRepository.mockResolvedValue(fake);

            const result = await controller.updateWebsiteRepository(auth, 'w-1');

            expect(s.workGenerationService.updateWebsiteRepository).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WEBSITE_SETTINGS_UPDATED',
                action: 'work.website_updated',
                status: 'COMPLETED',
                summary: 'Updated website repository',
            });
            expect(result).toBe(fake);
        });

        it('does not emit a log when the update rejects', async () => {
            s.workGenerationService.updateWebsiteRepository.mockRejectedValue(new Error('502'));

            await expect(controller.updateWebsiteRepository(auth, 'w-1')).rejects.toThrow('502');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // switchWebsiteTemplate
    // -----------------------------------------------------------------------
    describe('switchWebsiteTemplate', () => {
        it('repository_recreated: summary includes both template ids and the recreated wording', async () => {
            const fake: any = {
                switchMode: 'repository_recreated',
                previousWebsiteTemplateId: 't-old',
                websiteTemplateId: 't-new',
                repositoryRecreated: true,
                repository: { url: 'https://example.com/r' },
                message: 'recreated',
            };
            s.workLifecycleService.switchWebsiteTemplate.mockResolvedValue(fake);

            const result = await controller.switchWebsiteTemplate(auth, 'w-1', {
                websiteTemplateId: 't-new',
            });

            expect(s.workLifecycleService.switchWebsiteTemplate).toHaveBeenCalledWith(
                'w-1',
                't-new',
                { id: 'user-1' },
            );
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WEBSITE_SETTINGS_UPDATED',
                action: 'work.website_template_switched',
                status: 'COMPLETED',
                summary:
                    'Switched website template from t-old to t-new and recreated the website repository',
                details: {
                    previousWebsiteTemplateId: 't-old',
                    websiteTemplateId: 't-new',
                    switchMode: 'repository_recreated',
                    repositoryRecreated: true,
                    repository: { url: 'https://example.com/r' },
                },
            });
            expect(result).toBe(fake);
        });

        it('repository_reset: summary uses the "reset the existing website repository" wording', async () => {
            const fake: any = {
                switchMode: 'repository_reset',
                previousWebsiteTemplateId: 't-a',
                websiteTemplateId: 't-b',
                repositoryRecreated: false,
                repository: null,
                message: 'reset',
            };
            s.workLifecycleService.switchWebsiteTemplate.mockResolvedValue(fake);

            await controller.switchWebsiteTemplate(auth, 'w-1', { websiteTemplateId: 't-b' });

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    summary:
                        'Switched website template from t-a to t-b and reset the existing website repository',
                    details: expect.objectContaining({
                        switchMode: 'repository_reset',
                        repositoryRecreated: false,
                        repository: null,
                    }),
                }),
            );
        });

        it('saved_for_initialization: summary uses the "Saved … for first website creation" wording', async () => {
            const fake: any = {
                switchMode: 'saved_for_initialization',
                previousWebsiteTemplateId: 't-old',
                websiteTemplateId: 't-new',
                repositoryRecreated: false,
                repository: null,
                message: 'saved',
            };
            s.workLifecycleService.switchWebsiteTemplate.mockResolvedValue(fake);

            await controller.switchWebsiteTemplate(auth, 'w-1', { websiteTemplateId: 't-new' });

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    summary:
                        'Saved website template change from t-old to t-new for first website creation',
                }),
            );
        });

        it('no_change: summary equals the service-provided message verbatim', async () => {
            const fake: any = {
                switchMode: 'no_change',
                previousWebsiteTemplateId: 't-x',
                websiteTemplateId: 't-x',
                repositoryRecreated: false,
                repository: null,
                message: 'Template unchanged',
            };
            s.workLifecycleService.switchWebsiteTemplate.mockResolvedValue(fake);

            await controller.switchWebsiteTemplate(auth, 'w-1', { websiteTemplateId: 't-x' });

            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({ summary: 'Template unchanged' }),
            );
        });

        it('forwards null body.websiteTemplateId to clear the template', async () => {
            s.workLifecycleService.switchWebsiteTemplate.mockResolvedValue({
                switchMode: 'no_change',
                previousWebsiteTemplateId: 't-old',
                websiteTemplateId: null,
                repositoryRecreated: false,
                repository: null,
                message: 'cleared',
            } as any);

            await controller.switchWebsiteTemplate(auth, 'w-1', { websiteTemplateId: null });

            expect(s.workLifecycleService.switchWebsiteTemplate).toHaveBeenCalledWith(
                'w-1',
                null,
                { id: 'user-1' },
            );
        });

        it('does not emit a log when switchWebsiteTemplate rejects', async () => {
            s.workLifecycleService.switchWebsiteTemplate.mockRejectedValue(new Error('failed'));

            await expect(
                controller.switchWebsiteTemplate(auth, 'w-1', { websiteTemplateId: 't-new' }),
            ).rejects.toThrow('failed');
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // syncWorkData (POST works/:id/sync-data)
    // -----------------------------------------------------------------------
    describe('syncWorkData', () => {
        it('invalidates caches AFTER sync, then logs WORK_UPDATED with full details', async () => {
            const fake: any = {
                status: 'success',
                updated: ['name', 'description'],
                message: 'pulled',
            };
            s.workLifecycleService.syncFromDataRepository.mockResolvedValue(fake);

            const callOrder: string[] = [];
            s.workLifecycleService.syncFromDataRepository.mockImplementation(async () => {
                callOrder.push('sync');
                return fake;
            });
            s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike.mockImplementation(
                async () => {
                    callOrder.push('invalidate');
                },
            );

            const result = await controller.syncWorkData(auth, 'w-1');

            expect(callOrder).toEqual(['sync', 'invalidate']);
            expect(s.workLifecycleService.syncFromDataRepository).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'WORK_UPDATED',
                action: 'work.synced_from_data_repo',
                status: 'COMPLETED',
                summary: 'Synced work data',
                details: {
                    syncStatus: 'success',
                    updatedFields: ['name', 'description'],
                    message: 'pulled',
                },
            });
            expect(result).toBe(fake);
        });

        it('does not invalidate caches or log when syncFromDataRepository rejects', async () => {
            s.workLifecycleService.syncFromDataRepository.mockRejectedValue(new Error('git'));

            await expect(controller.syncWorkData(auth, 'w-1')).rejects.toThrow('git');
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).not.toHaveBeenCalled();
            expect(s.activityLogService.log).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // getRepositoryVisibility (GET works/:id/repositories/visibility)
    // -----------------------------------------------------------------------
    describe('getRepositoryVisibility', () => {
        it('runs ensureAccess(id, user.id) BEFORE getRepositoriesStatus and forwards the resolved work', async () => {
            const work: any = { id: 'w-1', slug: 'my-work' };
            s.workOwnershipService.ensureAccess.mockResolvedValue({ work, role: 'owner' });
            const status: any = [{ repoType: 'data', isPrivate: true }];
            s.repositoryManagementService.getRepositoriesStatus.mockResolvedValue(status);

            const result = await controller.getRepositoryVisibility(auth, 'w-1');

            expect(s.workOwnershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.repositoryManagementService.getRepositoriesStatus).toHaveBeenCalledWith(
                work,
                { id: 'user-1' },
            );

            const accessOrder = s.workOwnershipService.ensureAccess.mock.invocationCallOrder[0];
            const statusOrder =
                s.repositoryManagementService.getRepositoriesStatus.mock.invocationCallOrder[0];
            expect(accessOrder).toBeLessThan(statusOrder);

            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(status);
        });

        it('propagates ensureAccess rejection without calling getRepositoriesStatus', async () => {
            s.workOwnershipService.ensureAccess.mockRejectedValue(new Error('forbidden'));

            await expect(controller.getRepositoryVisibility(auth, 'w-1')).rejects.toThrow(
                'forbidden',
            );
            expect(s.repositoryManagementService.getRepositoriesStatus).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // updateRepositoryVisibility (PUT works/:id/repositories/visibility)
    // -----------------------------------------------------------------------
    describe('updateRepositoryVisibility', () => {
        it('runs ensureAccess BEFORE updateRepositoryVisibility and forwards (work, user, repoType, isPrivate)', async () => {
            const work: any = { id: 'w-1' };
            s.workOwnershipService.ensureAccess.mockResolvedValue({ work, role: 'owner' });
            const updated: any = { repoType: 'website', isPrivate: false };
            s.repositoryManagementService.updateRepositoryVisibility.mockResolvedValue(updated);

            const result = await controller.updateRepositoryVisibility(auth, 'w-1', {
                repoType: 'website' as any,
                isPrivate: false,
            });

            expect(s.workOwnershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'user-1');
            expect(
                s.repositoryManagementService.updateRepositoryVisibility,
            ).toHaveBeenCalledWith(work, { id: 'user-1' }, 'website', false);

            const accessOrder = s.workOwnershipService.ensureAccess.mock.invocationCallOrder[0];
            const updateOrder =
                s.repositoryManagementService.updateRepositoryVisibility.mock
                    .invocationCallOrder[0];
            expect(accessOrder).toBeLessThan(updateOrder);

            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toBe(updated);
        });

        it('propagates ensureAccess rejection without calling updateRepositoryVisibility', async () => {
            s.workOwnershipService.ensureAccess.mockRejectedValue(new Error('not member'));

            await expect(
                controller.updateRepositoryVisibility(auth, 'w-1', {
                    repoType: 'data' as any,
                    isPrivate: true,
                }),
            ).rejects.toThrow('not member');
            expect(
                s.repositoryManagementService.updateRepositoryVisibility,
            ).not.toHaveBeenCalled();
        });

        it('forwards isPrivate=true verbatim with the data repoType', async () => {
            s.workOwnershipService.ensureAccess.mockResolvedValue({ work: { id: 'w-1' } });
            s.repositoryManagementService.updateRepositoryVisibility.mockResolvedValue({} as any);

            await controller.updateRepositoryVisibility(auth, 'w-1', {
                repoType: 'data' as any,
                isPrivate: true,
            });

            expect(
                s.repositoryManagementService.updateRepositoryVisibility,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'w-1' }),
                { id: 'user-1' },
                'data',
                true,
            );
        });
    });
});
