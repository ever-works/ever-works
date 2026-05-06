import { ConflictException, NotFoundException } from '@nestjs/common';
import { TemplateCatalogService } from './template-catalog.service';

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
            findBuiltInByRepositoryCoordinates: jest.fn(),
            hasRecentDiscoveredBuiltInTemplates: jest.fn(),
            findById: jest.fn(),
            upsert: jest.fn(),
            updateById: jest.fn(),
        };
        userTemplatePreferenceRepository = {
            findByUserAndKind: jest.fn(),
            upsertDefault: jest.fn(),
        };
        workRepository = {
            countByUserAndWebsiteTemplateId: jest.fn(),
            countByUserAndInheritedWebsiteTemplateSelection: jest.fn(),
        };
        gitFacade = {
            hasValidCredentials: jest.fn().mockResolvedValue(false),
            getAccessToken: jest.fn().mockResolvedValue(null),
            listRepositories: jest.fn(),
            listPublicRepositories: jest.fn(),
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
            syncBranches: ['develop'],
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
                syncBranches: ['develop'],
            }),
        );
        expect(result.name).toBe('New Name');
        expect(result.isDefault).toBe(true);
    });

    it('preserves omitted metadata fields during partial custom template updates', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            name: 'Old Name',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: 'https://example.com/old.png',
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
            name: 'Renamed',
            description: 'Old description',
            framework: 'Next.js',
            previewImageUrl: 'https://example.com/old.png',
            repositoryUrl: 'https://github.com/user/repo',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            isActive: true,
            metadata: {},
        });
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        await service.updateCustomTemplateForUser(
            {
                kind: 'website',
                templateId: 'custom-1',
                name: 'Renamed',
            },
            'user-1',
        );

        expect(templateRepository.updateById).toHaveBeenCalledWith(
            'custom-1',
            expect.objectContaining({
                name: 'Renamed',
                description: 'Old description',
                framework: 'Next.js',
                previewImageUrl: 'https://example.com/old.png',
                branch: 'main',
                syncBranches: ['main'],
            }),
        );
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

    it('rejects archiving a custom template that is the current default for inheriting works', async () => {
        templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            isActive: true,
        });
        workRepository.countByUserAndWebsiteTemplateId.mockResolvedValue(0);
        workRepository.countByUserAndInheritedWebsiteTemplateSelection.mockResolvedValue(3);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
            templateId: 'custom-1',
        });
        templateRepository.findVisibleById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            sourceType: 'custom',
            isActive: true,
        });

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
        workRepository.countByUserAndInheritedWebsiteTemplateSelection.mockResolvedValue(0);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

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

    it('does not sync discovered templates during a normal list read when discovery is fresh', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.listTemplatesForUser('website', 'user-1');

        expect(gitFacade.listRepositories).not.toHaveBeenCalled();
        expect(gitFacade.listPublicRepositories).not.toHaveBeenCalled();
        expect(result).toEqual({
            defaultTemplateId: 'classic',
            templates: [],
        });
    });

    it('syncs discovered templates during a list read when discovery is stale', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(false);
        gitFacade.getAccessToken.mockResolvedValue(null);
        gitFacade.listPublicRepositories.mockResolvedValueOnce([]);
        templateRepository.findVisibleByKind.mockResolvedValue([]);
        userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);

        const result = await service.listTemplatesForUser('website', 'user-1');

        expect(gitFacade.listPublicRepositories).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            defaultTemplateId: 'classic',
            templates: [],
        });
    });

    it('refreshes discovered standard templates for website catalogs', async () => {
        templateRepository.hasRecentDiscoveredBuiltInTemplates.mockResolvedValue(true);
        gitFacade.getAccessToken.mockResolvedValue(null);
        const firstPageRepositories = Array.from({ length: 100 }, (_, index) => ({
            name: `repo-${index}`,
            owner: 'ever-works',
            url: `https://github.com/ever-works/repo-${index}`,
            fullName: `ever-works/repo-${index}`,
            defaultBranch: 'main',
            description: `Repository ${index}`,
        }));
        firstPageRepositories[0] = {
            name: 'directory-web-template',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/directory-web-template',
            fullName: 'ever-works/directory-web-template',
            defaultBranch: 'main',
            description: 'Classic template',
        };
        firstPageRepositories[1] = {
            name: 'docs',
            owner: 'ever-works',
            url: 'https://github.com/ever-works/docs',
            fullName: 'ever-works/docs',
            defaultBranch: 'main',
            description: 'Docs',
        };
        gitFacade.listPublicRepositories
            .mockResolvedValueOnce(firstPageRepositories)
            .mockResolvedValueOnce([]);
        templateRepository.findBuiltInByRepositoryCoordinates.mockResolvedValue({
            id: 'classic',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'directory-web-template',
            isActive: true,
        });
        templateRepository.findById.mockResolvedValue({
            id: 'directory-web-template',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'directory-web-template',
            isActive: true,
        });
        templateRepository.findVisibleByKind.mockResolvedValue([
            {
                id: 'classic',
                kind: 'website',
                sourceType: 'built_in',
                name: 'Classic',
                description: 'Classic template',
                framework: null,
                previewImageUrl: null,
                repositoryUrl: 'https://github.com/ever-works/directory-web-template',
                repositoryOwner: 'ever-works',
                repositoryName: 'directory-web-template',
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
        expect(gitFacade.listPublicRepositories).toHaveBeenCalledTimes(2);
        expect(gitFacade.listPublicRepositories).toHaveBeenNthCalledWith(
            1,
            'github',
            1,
            100,
            expect.objectContaining({
                owner: 'ever-works',
                type: 'org',
            }),
        );
        expect(templateRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'classic',
                sourceType: 'built_in',
                repositoryName: 'directory-web-template',
            }),
        );
        expect(templateRepository.updateById).toHaveBeenCalledWith('directory-web-template', {
            isActive: false,
        });
        expect(result.templates[0]).toEqual(
            expect.objectContaining({
                id: 'classic',
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

    it('swallows startup seed errors during module init', async () => {
        const warnSpy = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);
        templateRepository.upsert.mockRejectedValue(new Error('db unavailable'));

        await expect(service.onModuleInit()).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                'Failed to seed built-in templates during startup: db unavailable',
            ),
        );
    });
});
