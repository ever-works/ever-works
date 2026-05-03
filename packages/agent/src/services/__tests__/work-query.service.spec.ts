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

    /**
     * Regression test for the post-rename incident where production users
     * suddenly saw an empty Works list despite their data still being in
     * `works.userId`. The list query passes `user.id` straight through
     * to `findAllAccessible` — this test pins that handoff so a future
     * refactor that, say, derives `userId` from a different field can't
     * silently filter out everyone's data.
     */
    it('passes the authenticated user.id through to findAllAccessible (regression)', async () => {
        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([]);
        workRepository.countAllAccessible.mockResolvedValue(0);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        await service.getWorks({ limit: 20, offset: 0 }, user);

        expect(workRepository.findAllAccessible).toHaveBeenCalledTimes(1);
        const arg = workRepository.findAllAccessible.mock.calls[0][0];
        expect(arg.userId).toBe(user.id);
        expect(arg.limit).toBe(20);
        expect(arg.offset).toBe(0);
        expect(arg.memberWorkIds).toEqual([]);

        expect(workRepository.countAllAccessible).toHaveBeenCalledWith(
            expect.objectContaining({ userId: user.id }),
        );
    });

    it('returns existing work rows owned by user (regression for empty-list bug)', async () => {
        // Regression: after the rename, a logged-in user must still see
        // their pre-rename Work rows surfaced through the listing query
        // with the OWNER role.
        const legacyWork = {
            id: 'legacy-pre-rename-id',
            userId: user.id,
            owner: 'pre-rename-owner',
            slug: 'my-old-work',
            name: 'My Old Work',
            itemsCount: 5,
            generateStatus: { status: GenerateStatusType.GENERATED },
            getRepoOwner: jest.fn().mockReturnValue('pre-rename-owner'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([legacyWork]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        const result = await service.getWorks({}, user);

        expect(result.total).toBe(1);
        expect(result.works).toHaveLength(1);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'legacy-pre-rename-id',
                slug: 'my-old-work',
                userRole: WorkMemberRole.OWNER,
            }),
        );
    });
});
