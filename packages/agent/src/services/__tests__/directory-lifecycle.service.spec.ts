jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));

jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));

jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

const previousMinimalRepo = process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = 'directory-web-template-minimal';

import { NotFoundException } from '@nestjs/common';
import { DirectoryLifecycleService } from '../directory-lifecycle.service';
import { GenerateStatusType } from '@src/entities/types';

describe('DirectoryLifecycleService', () => {
    const user = { id: 'user-1' } as any;

    let directoryRepository: any;
    let dataGenerator: any;
    let markdownGenerator: any;
    let websiteGenerator: any;
    let websiteUpdateService: any;
    let ownershipService: any;
    let deployFacade: any;
    let gitFacade: any;
    let service: DirectoryLifecycleService;

    afterAll(() => {
        if (previousMinimalRepo === undefined) {
            delete process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
        } else {
            process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = previousMinimalRepo;
        }
    });

    beforeEach(() => {
        directoryRepository = {
            create: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            updateGenerateStatus: jest.fn(),
        };
        dataGenerator = {
            getItems: jest.fn(),
            getDataSyncSnapshot: jest.fn(),
        };
        markdownGenerator = {
            removeRepository: jest.fn(),
        };
        websiteGenerator = {
            removeRepository: jest.fn(),
            initialize: jest.fn(),
        };
        websiteUpdateService = {
            updateRepository: jest.fn().mockResolvedValue({
                method: 'create-using-template',
                message: 'updated',
            }),
        };
        ownershipService = {
            ensureCanEdit: jest.fn(),
            ensureIsOwner: jest.fn(),
        };
        deployFacade = {
            getAvailableProviders: jest.fn().mockReturnValue([]),
        };
        gitFacade = {
            hasValidCredentials: jest.fn().mockResolvedValue(false),
            repositoryExists: jest.fn(),
        };

        service = new DirectoryLifecycleService(
            directoryRepository,
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            websiteUpdateService,
            ownershipService,
            deployFacade,
            gitFacade,
        );
    });

    it('does not clear generateStatus when sync finds zero items', async () => {
        const directory = {
            id: 'dir-1',
            itemsCount: 12,
            generateStatus: {
                status: GenerateStatusType.GENERATED,
            },
            lastPullRequest: null,
            readmeConfig: {},
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });
        dataGenerator.getDataSyncSnapshot.mockResolvedValue({
            itemsCount: 0,
            prUpdate: null,
            readmeTemplate: null,
        });

        await service.syncFromDataRepository(directory.id, user);

        expect(directoryRepository.update).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                itemsCount: 0,
            }),
        );
        expect(directoryRepository.update).not.toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                generateStatus: null,
            }),
        );
    });

    it('rejects website template changes after website repository initialization', async () => {
        const directory = {
            id: 'dir-1',
            name: 'Test Directory',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });

        await expect(
            service.updateDirectory(directory.id, { websiteTemplateId: 'minimal' } as any, user),
        ).rejects.toThrow(
            'Website template cannot be changed after the website repository has been initialized.',
        );
    });

    it('returns a no-op switch mode when the selected template is already active', async () => {
        const directory = {
            id: 'dir-1',
            slug: 'test-directory',
            name: 'Test Directory',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });

        const result = await service.switchWebsiteTemplate(directory.id, 'classic', user);

        expect(result.switchMode).toBe('no_change');
        expect(result.repositoryRecreated).toBe(false);
        expect(directoryRepository.update).not.toHaveBeenCalled();
        expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
    });

    it('resets the website repository from the selected template after initialization', async () => {
        const directory = {
            id: 'dir-1',
            slug: 'test-directory',
            name: 'Test Directory',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });

        const result = await service.switchWebsiteTemplate(directory.id, 'minimal', user);

        expect(directoryRepository.update).toHaveBeenCalledWith(
            directory.id,
            expect.objectContaining({
                websiteTemplateId: 'minimal',
                websiteTemplateLastCommit: null,
                websiteTemplateLastError: null,
                websiteTemplateLastUpdatedAt: null,
                websiteTemplateLastCheckedAt: null,
            }),
        );
        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(directory, user);
        expect(websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(result.repositoryRecreated).toBe(false);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_reset');
        expect(result.websiteTemplateId).toBe('minimal');
    });

    it('recreates the website repository only when the existing website repo is missing', async () => {
        const directory = {
            id: 'dir-1',
            slug: 'test-directory',
            name: 'Test Directory',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });
        websiteUpdateService.updateRepository.mockRejectedValueOnce(
            new NotFoundException(
                "Website repository 'ever-works/test-directory-website' does not exist",
            ),
        );

        const result = await service.switchWebsiteTemplate(directory.id, 'minimal', user);

        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(directory, user);
        expect(websiteGenerator.initialize).toHaveBeenCalledWith(
            directory,
            user,
            'create-using-template',
        );
        expect(result.repositoryRecreated).toBe(true);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_recreated');
    });

    it('does not persist the template switch when updating the existing website repo fails', async () => {
        const directory = {
            id: 'dir-1',
            slug: 'test-directory',
            name: 'Test Directory',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-directory-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ directory });
        websiteUpdateService.updateRepository.mockRejectedValueOnce(new Error('sync failed'));

        await expect(service.switchWebsiteTemplate(directory.id, 'minimal', user)).rejects.toThrow(
            'sync failed',
        );

        expect(directoryRepository.update).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(directory.websiteTemplateId).toBe('classic');
        expect(directory.websiteTemplateLastCommit).toBe('abc123');
        expect(directory.websiteTemplateLastError).toBe('old error');
    });
});
