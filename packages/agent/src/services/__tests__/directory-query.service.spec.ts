jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { DirectoryQueryService } from '../directory-query.service';
import { DirectoryMemberRole, GenerateStatusType } from '@src/entities/types';

describe('DirectoryQueryService', () => {
    const user = { id: 'user-1' } as any;

    let directoryRepository: any;
    let directoryMemberRepository: any;
    let dataGenerator: any;
    let generationHistoryRepository: any;
    let ownershipService: any;
    let service: DirectoryQueryService;

    beforeEach(() => {
        directoryRepository = {
            findAllAccessible: jest.fn(),
            countAllAccessible: jest.fn(),
        };
        directoryMemberRepository = {
            getAccessibleDirectoryIds: jest.fn(),
            getMemberRolesForDirectories: jest.fn(),
        };
        dataGenerator = {};
        generationHistoryRepository = {
            findLatestPositiveItemCounts: jest.fn(),
        };
        ownershipService = {};

        service = new DirectoryQueryService(
            directoryRepository,
            directoryMemberRepository,
            dataGenerator as any,
            generationHistoryRepository,
            ownershipService as any,
        );
    });

    it('recovers the last known positive items count for errored directories', async () => {
        const directory = {
            id: 'dir-1',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.ERROR },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        directoryMemberRepository.getAccessibleDirectoryIds.mockResolvedValue([]);
        directoryRepository.findAllAccessible.mockResolvedValue([directory]);
        directoryRepository.countAllAccessible.mockResolvedValue(1);
        directoryMemberRepository.getMemberRolesForDirectories.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(
            new Map([['dir-1', 42]]),
        );

        const result = await service.getDirectories({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([
            'dir-1',
        ]);
        expect(result.directories[0]).toEqual(
            expect.objectContaining({
                id: 'dir-1',
                itemsCount: 42,
                userRole: DirectoryMemberRole.OWNER,
            }),
        );
    });

    it('does not override zero counts for completed directories', async () => {
        const directory = {
            id: 'dir-2',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.GENERATED },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        directoryMemberRepository.getAccessibleDirectoryIds.mockResolvedValue([]);
        directoryRepository.findAllAccessible.mockResolvedValue([directory]);
        directoryRepository.countAllAccessible.mockResolvedValue(1);
        directoryMemberRepository.getMemberRolesForDirectories.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        const result = await service.getDirectories({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([]);
        expect(result.directories[0]).toEqual(
            expect.objectContaining({
                id: 'dir-2',
                itemsCount: 0,
            }),
        );
    });
});
