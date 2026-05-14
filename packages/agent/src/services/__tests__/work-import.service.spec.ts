jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));

import { WorkImportService } from '../work-import.service';
import { ImportSourceTypeEnum } from '@src/dto/import-work.dto';

function createWorksConfigRestoreServiceMock() {
    return {
        getConflictRepoNames: jest.fn(
            (slug: string, sourceRepoName?: string, worksConfig?: any) => {
                const repoNames = [`${slug}-data`];
                const websiteRepo = worksConfig?.websiteRepo?.split('/').pop() || `${slug}-website`;
                return repoNames
                    .concat(websiteRepo)
                    .filter((repoName) => repoName.toLowerCase() !== sourceRepoName?.toLowerCase());
            },
        ),
        sanitizeConflict: jest.fn((conflict: any, sourceRepoName?: string, worksConfig?: any) => {
            const benign = new Set<string>();
            if (sourceRepoName) benign.add(sourceRepoName.toLowerCase());
            const websiteRepo = worksConfig?.websiteRepo?.split('/').pop();
            if (websiteRepo?.toLowerCase() === sourceRepoName?.toLowerCase()) {
                benign.add(websiteRepo.toLowerCase());
            }
            const conflictingRepos = conflict.conflictingRepos.filter(
                (repoName: string) => !benign.has(repoName.toLowerCase()),
            );
            return {
                ...conflict,
                hasConflict: conflictingRepos.length > 0,
                conflictingRepos,
            };
        }),
        validateForImport: jest.fn().mockResolvedValue(undefined),
        validateRepositoryTargets: jest.fn(),
        buildSourceRepository: jest.fn((options: any) => ({
            url: options.sourceUrl,
            owner: options.sourceOwner,
            repo: options.sourceRepo,
            type: options.sourceType,
            importedAt: new Date('2026-04-24T00:00:00.000Z'),
            worksConfig: options.worksConfig
                ? {
                      initialPrompt: options.worksConfig.initialPrompt,
                      websiteRepo: options.worksConfig.websiteRepo,
                      providers: options.worksConfig.providers,
                  }
                : undefined,
            relatedRepositories: {
                [options.sourceRole ?? 'work']: {
                    owner: options.sourceOwner,
                    repo: options.sourceRepo,
                },
                ...(options.worksConfig?.websiteRepositoryTarget
                    ? { website: options.worksConfig.websiteRepositoryTarget }
                    : {}),
            },
        })),
        applyPipelineSettings: jest.fn().mockResolvedValue(undefined),
        applyInitialSchedule: jest.fn().mockResolvedValue(undefined),
        applyScheduleOverrides: jest.fn().mockResolvedValue(undefined),
        applyActivitySyncMode: jest.fn().mockResolvedValue(undefined),
        validateProviderSettings: jest.fn().mockResolvedValue(undefined),
        toResolved: jest.fn((worksConfig: any) => worksConfig ?? null),
    };
}

describe('WorkImportService.analyzeRepository', () => {
    it('does not surface the source .works/works.yml repo as a slug conflict', async () => {
        const sourceRepoAnalyzer = {
            analyzeRepository: jest.fn().mockResolvedValue({
                sourceUrl: 'https://github.com/ever-works/compare-cloud-pricing',
                owner: 'ever-works',
                repo: 'compare-cloud-pricing',
                detectedType: ImportSourceTypeEnum.WORKS_CONFIG,
                isPublic: true,
                requiresAuth: false,
                worksConfig: {
                    initialPrompt: 'Build everything',
                    websiteRepo: 'ever-works/compare-cloud-pricing',
                },
            }),
            parseGitUrl: jest.fn(),
            checkSlugConflicts: jest.fn().mockResolvedValue({
                hasConflict: true,
                conflictingRepos: ['compare-cloud-pricing'],
                suggestedSlug: 'compare-cloud-pricing-2',
            }),
        };

        const service = new WorkImportService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
            } as any,
            sourceRepoAnalyzer as any,
            {} as any,
            {
                parseRepositoryReference: jest.fn().mockImplementation((value?: string) => {
                    if (!value) {
                        return undefined;
                    }

                    const [owner, repo] = value.split('/');
                    return repo ? { owner, repo } : { repo: owner };
                }),
            } as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {} as any,
            {} as any,
        );

        const result = await service.analyzeRepository(
            {
                sourceUrl: 'https://github.com/ever-works/compare-cloud-pricing',
                gitProvider: 'github',
            },
            {
                id: 'user-1',
                username: 'ever-works',
            } as any,
        );

        expect(sourceRepoAnalyzer.checkSlugConflicts).toHaveBeenCalledWith(
            'ever-works',
            'compare-cloud-pricing',
            'token',
            'github',
            {
                includeRepoNames: ['compare-cloud-pricing-data'],
            },
        );
        expect(result.slugConflict).toBeUndefined();
    });

    it('does not run slug conflict checks when repository format is not detected', async () => {
        const sourceRepoAnalyzer = {
            analyzeRepository: jest.fn().mockResolvedValue({
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing',
                detectedType: null,
                isPublic: true,
                requiresAuth: false,
                structure: {
                    hasConfig: false,
                    hasDataFolder: false,
                    hasReadme: false,
                    hasWorksConfig: false,
                },
            }),
            parseGitUrl: jest.fn(),
            checkSlugConflicts: jest.fn(),
        };

        const service = new WorkImportService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
            } as any,
            sourceRepoAnalyzer as any,
            {} as any,
            {
                parseRepositoryReference: jest.fn(),
            } as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {} as any,
            {} as any,
        );

        const result = await service.analyzeRepository(
            {
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                gitProvider: 'github',
            },
            {
                id: 'user-1',
                username: 'Ntermast',
            } as any,
        );

        expect(sourceRepoAnalyzer.checkSlugConflicts).not.toHaveBeenCalled();
        expect(result.slugConflict).toBeUndefined();
    });

    it('treats mixed-case source repo names as the same repo when sanitizing works config conflicts', async () => {
        const sourceRepoAnalyzer = {
            analyzeRepository: jest.fn().mockResolvedValue({
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing',
                detectedType: ImportSourceTypeEnum.WORKS_CONFIG,
                isPublic: true,
                requiresAuth: false,
                worksConfig: {
                    initialPrompt: 'Build everything',
                    websiteRepo: 'Ntermast/Compare-Cloud-Pricing',
                },
            }),
            parseGitUrl: jest.fn(),
            checkSlugConflicts: jest.fn().mockResolvedValue({
                hasConflict: true,
                conflictingRepos: ['compare-cloud-pricing'],
                suggestedSlug: 'compare-cloud-pricing-2',
            }),
        };

        const service = new WorkImportService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
            } as any,
            sourceRepoAnalyzer as any,
            {} as any,
            {
                parseRepositoryReference: jest.fn().mockImplementation((value?: string) => {
                    if (!value) {
                        return undefined;
                    }

                    const [owner, repo] = value.split('/');
                    return repo ? { owner, repo } : { repo: owner };
                }),
            } as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {} as any,
            {} as any,
        );

        const result = await service.analyzeRepository(
            {
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                gitProvider: 'github',
            },
            {
                id: 'user-1',
                username: 'Ntermast',
            } as any,
        );

        expect(result.slugConflict).toBeUndefined();
    });
});

describe('WorkImportService.initiateImport', () => {
    it('passes updated works_config source repository data to the import dispatcher path', async () => {
        const workRepository = {
            findByOwnerAndSlug: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
                id: 'dir-1',
                slug: 'compare-cloud-pricing',
                name: 'Compare Cloud Pricing',
                owner: 'Ntermast',
                organization: false,
                gitProvider: 'github',
            }),
            update: jest.fn().mockResolvedValue(undefined),
        };

        const generationHistoryRepository = {
            createEntry: jest.fn().mockResolvedValue({
                id: 'history-1',
                startedAt: new Date('2026-04-24T00:00:00.000Z'),
            }),
        };

        const sourceRepoAnalyzer = {
            parseGitUrl: jest.fn().mockReturnValue({
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing',
                provider: 'github',
            }),
            checkSlugConflicts: jest.fn().mockResolvedValue({
                hasConflict: false,
                conflictingRepos: [],
                suggestedSlug: 'compare-cloud-pricing',
            }),
        };

        const worksConfigService = {
            loadFromRepository: jest.fn().mockResolvedValue({
                initialPrompt: 'Build everything',
                websiteRepo: 'Ntermast/Compare-Cloud-Pricing-Website',
                websiteRepositoryTarget: {
                    owner: 'Ntermast',
                    repo: 'Compare-Cloud-Pricing-Website',
                },
                providers: {
                    ai: 'groq',
                    pipeline: 'agent-pipeline',
                },
            }),
            parseRepositoryReference: jest.fn().mockImplementation((value?: string) => {
                if (!value) {
                    return undefined;
                }

                const [owner, repo] = value.split('/');
                return repo ? { owner, repo } : { repo: owner };
            }),
        };

        const service = new WorkImportService(
            workRepository as any,
            generationHistoryRepository as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
            } as any,
            sourceRepoAnalyzer as any,
            {} as any,
            worksConfigService as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {
                validateSelectedProviders: jest.fn().mockResolvedValue(undefined),
                validateRequiredProvidersForPipeline: jest.fn().mockResolvedValue(undefined),
            } as any,
            {
                emit: jest.fn(),
            } as any,
        );

        const dispatchImportTask = jest.fn().mockResolvedValue(undefined);
        (service as any).dispatchImportTask = dispatchImportTask;

        const result = await service.initiateImport(
            {
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                sourceType: ImportSourceTypeEnum.WORKS_CONFIG,
                name: 'Compare Cloud Pricing',
                gitProvider: 'github',
                deployProvider: 'vercel',
                organization: false,
            } as any,
            {
                id: 'user-1',
                username: 'Ntermast',
            } as any,
        );

        expect(result.status).toBe('success');
        expect(dispatchImportTask).toHaveBeenCalled();

        const dispatchedWork = dispatchImportTask.mock.calls[0][0];
        expect(dispatchedWork.sourceRepository).toMatchObject({
            owner: 'Ntermast',
            repo: 'Compare-Cloud-Pricing',
            type: ImportSourceTypeEnum.WORKS_CONFIG,
            relatedRepositories: {
                work: {
                    owner: 'Ntermast',
                    repo: 'Compare-Cloud-Pricing',
                },
                website: {
                    owner: 'Ntermast',
                    repo: 'Compare-Cloud-Pricing-Website',
                },
            },
        });
    });

    it('does not restore .works/works.yml settings for data repo imports when disabled', async () => {
        const workRepository = {
            findByOwnerAndSlug: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
                id: 'dir-1',
                slug: 'compare-cloud-pricing',
                name: 'Compare Cloud Pricing',
                owner: 'Ntermast',
                organization: false,
                gitProvider: 'github',
            }),
            update: jest.fn().mockResolvedValue(undefined),
        };

        const generationHistoryRepository = {
            createEntry: jest.fn().mockResolvedValue({
                id: 'history-1',
                startedAt: new Date('2026-04-24T00:00:00.000Z'),
            }),
        };

        const sourceRepoAnalyzer = {
            parseGitUrl: jest.fn().mockReturnValue({
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing-data',
                provider: 'github',
            }),
            checkSlugConflicts: jest.fn().mockResolvedValue({
                hasConflict: false,
                conflictingRepos: [],
                suggestedSlug: 'compare-cloud-pricing',
            }),
        };

        const worksConfigService = {
            loadFromRepository: jest.fn(),
            parseRepositoryReference: jest.fn(),
        };
        const worksConfigRestoreService = createWorksConfigRestoreServiceMock();

        const service = new WorkImportService(
            workRepository as any,
            generationHistoryRepository as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
            } as any,
            sourceRepoAnalyzer as any,
            {} as any,
            worksConfigService as any,
            worksConfigRestoreService as any,
            {} as any,
            {
                validateSelectedProviders: jest.fn().mockResolvedValue(undefined),
                validateRequiredProvidersForPipeline: jest.fn().mockResolvedValue(undefined),
            } as any,
            {
                emit: jest.fn(),
            } as any,
        );

        const dispatchImportTask = jest.fn().mockResolvedValue(undefined);
        (service as any).dispatchImportTask = dispatchImportTask;

        const result = await service.initiateImport(
            {
                sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing-data',
                sourceType: ImportSourceTypeEnum.DATA_REPO,
                name: 'Compare Cloud Pricing',
                gitProvider: 'github',
                deployProvider: 'vercel',
                organization: false,
                restoreWorksConfig: false,
            } as any,
            {
                id: 'user-1',
                username: 'Ntermast',
            } as any,
        );

        expect(result.status).toBe('success');
        expect(worksConfigService.loadFromRepository).not.toHaveBeenCalled();
        expect(worksConfigRestoreService.applyPipelineSettings).not.toHaveBeenCalled();
        expect(worksConfigRestoreService.validateProviderSettings).not.toHaveBeenCalled();
        expect(worksConfigRestoreService.validateRepositoryTargets).not.toHaveBeenCalled();
        expect(worksConfigRestoreService.buildSourceRepository).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceType: ImportSourceTypeEnum.DATA_REPO,
                sourceRole: 'data',
                worksConfig: null,
            }),
        );
        expect(dispatchImportTask.mock.calls[0][6]).toBeNull();
    });
});

describe('WorkImportService.syncWork', () => {
    it('does not treat linked existing works as source-syncable imports', async () => {
        const importExecutor = {
            importFromDataRepo: jest.fn(),
            importFromAwesomeReadme: jest.fn(),
            importFromWorksConfig: jest.fn(),
        };

        const service = new WorkImportService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            importExecutor as any,
            {} as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {} as any,
            {
                emit: jest.fn(),
            } as any,
        );

        const work = {
            id: 'dir-1',
            sourceRepository: {
                url: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing',
                type: ImportSourceTypeEnum.LINK_EXISTING,
                importedAt: new Date('2026-04-24T00:00:00.000Z'),
            },
        } as any;

        const result = await service.syncWork(work, {
            id: 'user-1',
            username: 'Ntermast',
        } as any);

        expect(result).toMatchObject({
            success: false,
            workId: 'dir-1',
            error: 'Linked works use existing repositories directly and cannot be synced from an import source.',
        });
        expect(importExecutor.importFromDataRepo).not.toHaveBeenCalled();
        expect(importExecutor.importFromAwesomeReadme).not.toHaveBeenCalled();
        expect(importExecutor.importFromWorksConfig).not.toHaveBeenCalled();
    });

    it('updates the in-memory work source repository before works config sync import runs', async () => {
        const importExecutor = {
            importFromWorksConfig: jest.fn().mockResolvedValue({
                success: true,
                workId: 'dir-1',
                itemsImported: 0,
            }),
        };

        const service = new WorkImportService(
            {
                update: jest.fn().mockResolvedValue(undefined),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {
                getAccessToken: jest.fn().mockResolvedValue('token'),
                getWebUrl: jest
                    .fn()
                    .mockReturnValue('https://github.com/Ntermast/Compare-Cloud-Pricing'),
            } as any,
            {} as any,
            importExecutor as any,
            {
                loadFromRepository: jest.fn().mockResolvedValue({
                    initialPrompt: 'Build everything',
                    websiteRepo: 'Ntermast/Compare-Cloud-Pricing-Website',
                    websiteRepositoryTarget: {
                        owner: 'Ntermast',
                        repo: 'Compare-Cloud-Pricing-Website',
                    },
                }),
            } as any,
            createWorksConfigRestoreServiceMock() as any,
            {} as any,
            {} as any,
            {
                emit: jest.fn(),
            } as any,
        );

        const work = {
            id: 'dir-1',
            gitProvider: 'github',
            scheduledUpdatesEnabled: false,
            sourceRepository: {
                url: 'https://github.com/Ntermast/Compare-Cloud-Pricing',
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing',
                type: ImportSourceTypeEnum.WORKS_CONFIG,
                importedAt: new Date('2026-04-24T00:00:00.000Z'),
                relatedRepositories: {
                    website: {
                        owner: 'Ntermast',
                        repo: 'old-website-repo',
                    },
                },
            },
        } as any;

        const result = await service.syncWork(work, {
            id: 'user-1',
            username: 'Ntermast',
        } as any);

        expect(result.success).toBe(true);
        expect(importExecutor.importFromWorksConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                work: expect.objectContaining({
                    sourceRepository: expect.objectContaining({
                        relatedRepositories: expect.objectContaining({
                            website: {
                                owner: 'Ntermast',
                                repo: 'Compare-Cloud-Pricing-Website',
                            },
                        }),
                    }),
                }),
            }),
        );
    });
});
