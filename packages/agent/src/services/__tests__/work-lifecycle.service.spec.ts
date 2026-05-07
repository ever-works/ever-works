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
// Concrete GitHub repo name — bulk rename incorrectly produced
// `work-web-template-minimal`; the real repo is
// https://github.com/ever-works/directory-web-minimal-template
process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = 'directory-web-minimal-template';

import { NotFoundException } from '@nestjs/common';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { GenerateStatusType } from '@src/entities/types';

describe('WorkLifecycleService', () => {
    const user = { id: 'user-1' } as any;

    let workRepository: any;
    let dataGenerator: any;
    let markdownGenerator: any;
    let websiteGenerator: any;
    let websiteUpdateService: any;
    let ownershipService: any;
    let deployFacade: any;
    let templateCatalogService: any;
    let websiteRepositoryState: any;
    let service: WorkLifecycleService;

    afterAll(() => {
        if (previousMinimalRepo === undefined) {
            delete process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
        } else {
            process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = previousMinimalRepo;
        }
    });

    beforeEach(() => {
        workRepository = {
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
        templateCatalogService = {
            getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
            getVisibleTemplateForUser: jest.fn().mockImplementation(async (_kind, templateId) => ({
                id: templateId,
            })),
        };
        websiteRepositoryState = {
            isInitialized: jest.fn().mockResolvedValue(false),
        };

        service = new WorkLifecycleService(
            workRepository,
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            websiteUpdateService,
            ownershipService,
            deployFacade,
            templateCatalogService,
            websiteRepositoryState,
        );
    });

    it('does not clear generateStatus when sync finds zero items', async () => {
        const work = {
            id: 'dir-1',
            itemsCount: 12,
            generateStatus: {
                status: GenerateStatusType.GENERATED,
            },
            lastPullRequest: null,
            readmeConfig: {},
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        dataGenerator.getDataSyncSnapshot.mockResolvedValue({
            itemsCount: 0,
            prUpdate: null,
            readmeTemplate: null,
        });

        await service.syncFromDataRepository(work.id, user);

        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                itemsCount: 0,
            }),
        );
        expect(workRepository.update).not.toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                generateStatus: null,
            }),
        );
    });

    it('rejects website template changes after website repository initialization', async () => {
        const work = {
            id: 'dir-1',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        await expect(
            service.updateWork(work.id, { websiteTemplateId: 'minimal' } as any, user),
        ).rejects.toThrow(
            'Website template cannot be changed after the website repository has been initialized.',
        );
    });

    it('returns a no-op switch mode when the selected template is already active', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        const result = await service.switchWebsiteTemplate(work.id, 'classic', user);

        expect(result.switchMode).toBe('no_change');
        expect(result.repositoryRecreated).toBe(false);
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
    });

    it('resets the website repository from the selected template after initialization', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
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
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        const result = await service.switchWebsiteTemplate(work.id, 'minimal', user);

        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                websiteTemplateId: 'minimal',
                websiteTemplateLastCommit: null,
                websiteTemplateLastError: null,
                websiteTemplateLastUpdatedAt: null,
                websiteTemplateLastCheckedAt: null,
            }),
        );
        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        expect(websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(result.repositoryRecreated).toBe(false);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_reset');
        expect(result.websiteTemplateId).toBe('minimal');
    });

    it('recreates the website repository only when the existing website repo is missing', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
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
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);
        websiteUpdateService.updateRepository.mockRejectedValueOnce(
            new NotFoundException(
                "Website repository 'ever-works/test-work-website' does not exist",
            ),
        );

        const result = await service.switchWebsiteTemplate(work.id, 'minimal', user);

        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        expect(websiteGenerator.initialize).toHaveBeenCalledWith(
            work,
            user,
            'create-using-template',
        );
        expect(result.repositoryRecreated).toBe(true);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_recreated');
    });

    it('does not persist the template switch when updating the existing website repo fails', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
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
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);
        websiteUpdateService.updateRepository.mockRejectedValueOnce(new Error('sync failed'));

        await expect(service.switchWebsiteTemplate(work.id, 'minimal', user)).rejects.toThrow(
            'sync failed',
        );

        expect(workRepository.update).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(work.websiteTemplateId).toBe('classic');
        expect(work.websiteTemplateLastCommit).toBe('abc123');
        expect(work.websiteTemplateLastError).toBe('old error');
    });
});
