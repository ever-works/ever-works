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

    it('builds data repo source metadata without treating the data repo as the work repo', () => {
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
        expect(sourceRepository.relatedRepositories?.work).toBeUndefined();
    });

    it('can snapshot works config metadata without assigning the source repo a work role', () => {
        const service = createService();

        const sourceRepository = service.buildSourceRepository({
            sourceUrl: 'https://github.com/awesome/awesome-testing',
            sourceOwner: 'awesome',
            sourceRepo: 'awesome-testing',
            sourceType: 'awesome_readme',
            sourceRole: null,
            worksConfig: {
                initialPrompt: 'Build from the README',
                websiteRepo: 'ever-works/awesome-testing-site',
                websiteRepositoryTarget: {
                    owner: 'ever-works',
                    repo: 'awesome-testing-site',
                },
            },
        });

        expect(sourceRepository.relatedRepositories).toEqual({
            website: {
                owner: 'ever-works',
                repo: 'awesome-testing-site',
            },
        });
        expect(sourceRepository.worksConfig).toMatchObject({
            initialPrompt: 'Build from the README',
            websiteRepo: 'ever-works/awesome-testing-site',
        });
    });
});
