jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { WorkQueryService } from '../work-query.service';
import { WorkMemberRole, GenerateStatusType } from '@src/entities/types';

describe('WorkQueryService', () => {
    const user = { id: 'user-1' } as any;

    let workRepository: any;
    let workMemberRepository: any;
    let dataGenerator: any;
    let generationHistoryRepository: any;
    let ownershipService: any;
    let service: WorkQueryService;

    beforeEach(() => {
        workRepository = {
            findAllAccessible: jest.fn(),
            countAllAccessible: jest.fn(),
        };
        workMemberRepository = {
            getAccessibleWorkIds: jest.fn(),
            getMemberRolesForWorks: jest.fn(),
        };
        dataGenerator = {};
        generationHistoryRepository = {
            findLatestPositiveItemCounts: jest.fn(),
        };
        ownershipService = {};

        service = new WorkQueryService(
            workRepository,
            workMemberRepository,
            dataGenerator as any,
            generationHistoryRepository,
            ownershipService as any,
        );
    });

    it('recovers the last known positive items count for errored works', async () => {
        const work = {
            id: 'dir-1',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.ERROR },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(
            new Map([['dir-1', 42]]),
        );

        const result = await service.getWorks({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([
            'dir-1',
        ]);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'dir-1',
                itemsCount: 42,
                userRole: WorkMemberRole.OWNER,
            }),
        );
    });

    it('does not override zero counts for completed works', async () => {
        const work = {
            id: 'dir-2',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.GENERATED },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        const result = await service.getWorks({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([]);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'dir-2',
                itemsCount: 0,
            }),
        );
    });
});
