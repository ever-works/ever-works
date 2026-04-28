import { BadRequestException } from '@nestjs/common';
import { WorksConfigImportPlannerService } from '../services/works-config-import-planner.service';

describe('WorksConfigImportPlannerService', () => {
    const createService = () =>
        new WorksConfigImportPlannerService(
            {
                parseRepositoryReference: jest.fn((value?: string) => {
                    if (!value) return undefined;
                    const [owner, repo] = value.split('/');
                    return repo ? { owner, repo } : { repo: owner };
                }),
            } as any,
            {} as any,
        );

    it('rejects website_repo targets that point at the source repository', () => {
        const service = createService();

        expect(() =>
            service.validateRepositoryTargets(
                { owner: 'Ntermast', repo: 'Compare-Cloud-Pricing' },
                {
                    initialPrompt: 'Build everything',
                    websiteRepo: 'Ntermast/Compare-Cloud-Pricing',
                    websiteRepositoryTarget: {
                        owner: 'Ntermast',
                        repo: 'Compare-Cloud-Pricing',
                    },
                },
            ),
        ).toThrow(BadRequestException);
    });

    it('builds data repo source metadata without treating the data repo as the directory repo', () => {
        const service = createService();

        const sourceRepository = service.buildSourceRepository({
            sourceUrl: 'https://github.com/Ntermast/Compare-Cloud-Pricing-data',
            sourceOwner: 'Ntermast',
            sourceRepo: 'Compare-Cloud-Pricing-data',
            sourceType: 'data_repo',
            sourceRole: 'data',
            worksConfig: {
                initialPrompt: 'Build everything',
                websiteRepo: 'Ntermast/Compare-Cloud-Pricing-Website',
                websiteRepositoryTarget: {
                    owner: 'Ntermast',
                    repo: 'Compare-Cloud-Pricing-Website',
                },
            },
        });

        expect(sourceRepository.relatedRepositories).toMatchObject({
            data: {
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing-data',
            },
            website: {
                owner: 'Ntermast',
                repo: 'Compare-Cloud-Pricing-Website',
            },
        });
        expect(sourceRepository.relatedRepositories?.directory).toBeUndefined();
    });
});
