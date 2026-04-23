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
