import { SourceRepoAnalyzerService } from '../source-repo-analyzer.service';

describe('SourceRepoAnalyzerService.checkSlugConflicts', () => {
    it('checks only derived repos when explicit repo names are provided', async () => {
        const repositoryExists = jest
            .fn()
            .mockImplementation(
                async (_owner: string, repo: string) => repo === 'compare-cloud-pricing-data',
            );

        const service = new SourceRepoAnalyzerService(
            {
                repositoryExists,
            } as any,
            {} as any,
        );

        const result = await service.checkSlugConflicts(
            'ever-works',
            'compare-cloud-pricing',
            'token',
            'github',
            {
                includeRepoNames: ['compare-cloud-pricing-data', 'compare-cloud-pricing-website'],
            },
        );

        expect(result.hasConflict).toBe(true);
        expect(result.conflictingRepos).toEqual(['compare-cloud-pricing-data']);
        expect(repositoryExists).not.toHaveBeenCalledWith(
            'ever-works',
            'compare-cloud-pricing',
            expect.anything(),
        );
    });

    it('rewrites explicit derived repo names when suggesting an alternative slug', async () => {
        const checkedRepos: string[] = [];
        const repositoryExists = jest
            .fn()
            .mockImplementation(async (_owner: string, repo: string) => {
                checkedRepos.push(repo);
                return (
                    repo === 'compare-cloud-pricing-data' ||
                    repo === 'compare-cloud-pricing-website'
                );
            });

        const service = new SourceRepoAnalyzerService(
            {
                repositoryExists,
            } as any,
            {} as any,
        );

        const result = await service.checkSlugConflicts(
            'ever-works',
            'compare-cloud-pricing',
            'token',
            'github',
            {
                includeRepoNames: ['compare-cloud-pricing-data', 'compare-cloud-pricing-website'],
            },
        );

        expect(result.suggestedSlug).toBe('compare-cloud-pricing-2');
        expect(checkedRepos).toContain('compare-cloud-pricing-2-data');
        expect(checkedRepos).toContain('compare-cloud-pricing-2-website');
    });
});

describe('SourceRepoAnalyzerService.analyzeRepository', () => {
    it('classifies repos with data/ and works.yml as data_repo', async () => {
        const worksConfig = {
            initialPrompt: 'Keep it updated',
            raw: {},
        };

        const gitFacade = {
            isConfigured: jest.fn().mockReturnValue(true),
            getRepository: jest.fn().mockResolvedValue({
                isPrivate: false,
                permissions: { push: true },
            }),
            getWorkContents: jest
                .fn()
                .mockResolvedValueOnce([
                    { name: 'works.yml', type: 'file', path: 'works.yml' },
                    { name: 'data', type: 'dir', path: 'data' },
                    { name: 'README.md', type: 'file', path: 'README.md' },
                ])
                .mockResolvedValueOnce([{ name: 'item-a', type: 'dir', path: 'data/item-a' }]),
        };

        const worksConfigService = {
            loadFromRepository: jest.fn().mockResolvedValue(worksConfig),
        };

        const service = new SourceRepoAnalyzerService(gitFacade as any, worksConfigService as any);

        const result = await service.analyzeRepository(
            'https://github.com/ever-works/compare-cloud-pricing-data',
            'token',
        );

        expect(result.detectedType).toBe('data_repo');
        expect(result.worksConfig).toMatchObject({
            initialPrompt: 'Keep it updated',
        });
        expect(result.structure).toMatchObject({
            hasDataFolder: true,
            hasWorksConfig: true,
            itemCount: 1,
        });
    });

    it('classifies repos with works.yml but without data/ as works_config', async () => {
        const gitFacade = {
            isConfigured: jest.fn().mockReturnValue(true),
            getRepository: jest.fn().mockResolvedValue({
                isPrivate: false,
                permissions: { push: true },
            }),
            getWorkContents: jest
                .fn()
                .mockResolvedValue([{ name: 'works.yml', type: 'file', path: 'works.yml' }]),
        };

        const worksConfigService = {
            loadFromRepository: jest.fn().mockResolvedValue({
                initialPrompt: 'Build everything',
                raw: {},
            }),
        };

        const service = new SourceRepoAnalyzerService(gitFacade as any, worksConfigService as any);

        const result = await service.analyzeRepository(
            'https://github.com/ever-works/compare-cloud-pricing',
            'token',
        );

        expect(result.detectedType).toBe('works_config');
        expect(result.structure).toMatchObject({
            hasDataFolder: false,
            hasWorksConfig: true,
        });
    });

    it('classifies awesome README repos with works.yml as awesome_readme', async () => {
        const gitFacade = {
            isConfigured: jest.fn().mockReturnValue(true),
            getRepository: jest.fn().mockResolvedValue({
                isPrivate: false,
                permissions: { push: true },
            }),
            getWorkContents: jest.fn().mockResolvedValue([
                { name: 'works.yml', type: 'file', path: 'works.yml' },
                { name: 'README.md', type: 'file', path: 'README.md' },
            ]),
            getFileContent: jest.fn().mockResolvedValue({
                content: [
                    '# Awesome Testing',
                    '- [Tool 1](https://example.com/1)',
                    '- [Tool 2](https://example.com/2)',
                    '- [Tool 3](https://example.com/3)',
                    '- [Tool 4](https://example.com/4)',
                    '- [Tool 5](https://example.com/5)',
                ].join('\n'),
            }),
        };

        const worksConfigService = {
            loadFromRepository: jest.fn().mockResolvedValue({
                initialPrompt: 'Use this config',
                raw: {},
            }),
        };

        const service = new SourceRepoAnalyzerService(gitFacade as any, worksConfigService as any);

        const result = await service.analyzeRepository(
            'https://github.com/ever-works/awesome-testing',
            'token',
        );

        expect(result.detectedType).toBe('awesome_readme');
        expect(result.worksConfig).toMatchObject({
            initialPrompt: 'Use this config',
        });
        expect(result.structure).toMatchObject({
            hasDataFolder: false,
            hasWorksConfig: true,
            hasReadme: true,
            itemCount: 5,
        });
    });
});
