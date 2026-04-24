jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));

import { DirectoryImportService } from '../directory-import.service';
import { ImportSourceTypeEnum } from '@src/dto/import-directory.dto';

describe('DirectoryImportService.analyzeRepository', () => {
    it('does not surface the source works.yml repo as a slug conflict', async () => {
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

        const service = new DirectoryImportService(
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
            {} as any,
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

        const service = new DirectoryImportService(
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
            {} as any,
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
});
