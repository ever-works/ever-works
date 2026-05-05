import { ConflictException, NotFoundException } from '@nestjs/common';
import { TemplateCatalogService } from '../template-catalog.service';

describe('TemplateCatalogService', () => {
    let templateRepository: any;
    let userTemplatePreferenceRepository: any;
    let workRepository: any;
    let gitFacade: any;
    let service: TemplateCatalogService;

    beforeEach(() => {
        templateRepository = {
            findVisibleByKind: jest.fn(),
            findVisibleById: jest.fn(),
            findOwnedCustomById: jest.fn(),
            findOwnedCustomByRepositoryUrl: jest.fn(),
            findOwnedCustomByRepositoryCoordinates: jest.fn(),
            upsert: jest.fn(),
            updateById: jest.fn(),
        };
        userTemplatePreferenceRepository = {
            findByUserAndKind: jest.fn(),
            upsertDefault: jest.fn(),
        };
        workRepository = {
            countByUserAndWebsiteTemplateId: jest.fn(),
        };
        gitFacade = {
            hasValidCredentials: jest.fn().mockResolvedValue(false),
            listRepositories: jest.fn(),
            getUser: jest.fn(),
            getOrganizations: jest.fn(),
            forkRepository: jest.fn(),
            getWebUrl: jest.fn(),
        };

        service = new TemplateCatalogService(
            templateRepository,
            userTemplatePreferenceRepository,
            workRepository,
            gitFacade,
        );
    });

    it('updates editable metadata for a custom template', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'Old Name',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: null,
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        templateRepository.updateById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'New Name',
            description: 'New description',
            framework: 'Astro',
            previewImageUrl: 'https://example.com/preview.png',
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'develop',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
            templateId: 'custom-1',
        });
        templateRepository.findVisibleById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            isActive: true,
        });

        const result = await service.updateCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
                name: 'New Name',
                description: 'New description',
                framework: 'Astro',
                previewImageUrl: 'https://example.com/preview.png',
                branch: 'develop',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith(
            'custom-1',
            expect.objectContaining({
                name: 'New Name',
                description: 'New description',
                framework: 'Astro',
                previewImageUrl: 'https://example.com/preview.png',
                branch: 'develop',
            }),
        );
        expect(result.name).toBe('New Name');
        expect(result.isDefault).toBe(true);
    });

    it('rejects archiving a custom template that is still assigned to works', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(2);

        await expect(
            service.archiveCustomTemplateForUser(
                {
                    kind: 'website',
                    templateId: 'custom-1',
                },
                'user-1',
            ),
        ).rejects.toThrow(ConflictException);

        expect(templateRepository.updateById).not.toHaveBeenCalled();
    });

    it('archives an unused custom template', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(0);

        const result = await service.archiveCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith('custom-1', {
            isActive: false,
        });
        expect(result).toEqual({
            templateId: 'custom-1',
            archived: true,
        });
    });

    it('refreshes discovered standard templates for website catalogs', async () => {
        gitFacade.hasValidCredentials.mockResolvedValue(true);
        gitFacade.listRepositories.mockResolvedValue([
            {
                name: 'next-template',
                owner: 'ever-works',
                url: 'https://github.com/ever-works/next-template',
                fullName: 'ever-works/next-template',
                defaultBranch: 'main',
                description: 'Next template',
            },
            {
                name: 'docs',
                owner: 'ever-works',
                url: 'https://github.com/ever-works/docs',
                fullName: 'ever-works/docs',
                defaultBranch: 'main',
                description: 'Docs',
            },
        ]);
        templateRepository.findVisibleByKind.mockResolvedValue([
            {
                id: 'next-template',
                kind: 'website',
                sourceType: 'built_in',
                name: 'Next Template',
                description: 'Next template',
                framework: 'Next.js',
                previewImageUrl: null,
                repositoryUrl: 'https://github.com/ever-works/next-template',
                repositoryOwner: 'ever-works',
                repositoryName: 'next-template',
                branch: 'main',
                syncBranches: ['main'],
                betaBranch: null,
                isActive: true,
                ownerUserId: null,
                metadata: { discoveredFromOrganization: 'ever-works' },
            },
        ]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.refreshTemplatesForUser('website', 'user-1');

        expect(templateRepository.upsert).toHaveBeenCalledTimes(1);
        expect(templateRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'next-template',
                sourceType: 'built_in',
                repositoryName: 'next-template',
            }),
        );
        expect(result.templates[0]).toEqual(
            expect.objectContaining({
                id: 'next-template',
                originType: 'standard',
            }),
        );
    });

    it('rejects updates for custom templates the user does not own', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue(null);

        await expect(
            service.updateCustomTemplateForUser(
                {
                    kind: 'website',
                    templateId: 'custom-1',
                },
                'user-1',
            ),
        ).rejects.toThrow(NotFoundException);
    });
});
