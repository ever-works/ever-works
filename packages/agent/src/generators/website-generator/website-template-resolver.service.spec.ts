import { WebsiteTemplateResolverService } from './website-template-resolver.service';

describe('WebsiteTemplateResolverService', () => {
    let templateRepository: any;
    let userTemplatePreferenceRepository: any;
    let service: WebsiteTemplateResolverService;

    beforeEach(() => {
        templateRepository = {
            findById: jest.fn(),
        };
        userTemplatePreferenceRepository = {
            findByUserAndKind: jest.fn(),
        };

        service = new WebsiteTemplateResolverService(
            templateRepository,
            userTemplatePreferenceRepository,
        );
    });

    it('returns active catalog templates when available', async () => {
        templateRepository.findById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            isActive: true,
            name: 'Custom',
            description: 'Custom template',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
        });

        await expect(service.resolve('custom-1')).resolves.toEqual(
            expect.objectContaining({
                id: 'custom-1',
                owner: 'user',
                repo: 'repo',
                branch: 'main',
            }),
        );
    });

    it('throws when a non-static template id is unavailable or inactive', async () => {
        const errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        templateRepository.findById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            isActive: false,
        });

        await expect(service.resolve('custom-1')).rejects.toThrow(
            'Website template "custom-1" is unavailable or inactive.',
        );

        expect(errorSpy).toHaveBeenCalledWith(
            'Website template "custom-1" is unavailable or inactive and cannot be resolved',
        );
    });

    it('still resolves static built-in template ids', async () => {
        templateRepository.findById.mockResolvedValue(null);

        await expect(service.resolve('classic')).resolves.toEqual(
            expect.objectContaining({
                id: 'classic',
                repo: 'directory-web-template',
            }),
        );
    });
});
