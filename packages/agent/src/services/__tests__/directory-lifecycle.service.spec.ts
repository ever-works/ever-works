jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));

jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));

import { DirectoryLifecycleService } from '../directory-lifecycle.service';
import { GenerateStatusType } from '@src/entities/types';

describe('DirectoryLifecycleService', () => {
    const user = { id: 'user-1' } as any;

    let directoryRepository: any;
    let dataGenerator: any;
    let markdownGenerator: any;
    let websiteGenerator: any;
    let ownershipService: any;
    let deployFacade: any;
    let service: DirectoryLifecycleService;

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
        };
        ownershipService = {
            ensureCanEdit: jest.fn(),
            ensureIsOwner: jest.fn(),
        };
        deployFacade = {
            getAvailableProviders: jest.fn().mockReturnValue([]),
        };

        service = new DirectoryLifecycleService(
            directoryRepository,
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            ownershipService,
            deployFacade,
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
});
