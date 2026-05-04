import type { Repository } from 'typeorm';
import { WorkGenerationHistoryRepository } from '../work-generation-history.repository';
import { WorkGenerationHistory } from '@src/entities/work-generation-history.entity';

describe('WorkGenerationHistoryRepository', () => {
    let repository: jest.Mocked<Pick<Repository<WorkGenerationHistory>, 'find'>>;
    let service: WorkGenerationHistoryRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
        };

        service = new WorkGenerationHistoryRepository(
            repository as unknown as Repository<WorkGenerationHistory>,
        );
    });

    it('returns early for an empty work list', async () => {
        await expect(service.findLatestPositiveItemCounts([])).resolves.toEqual(new Map());
        expect(repository.find).not.toHaveBeenCalled();
    });

    it('fetches history in bounded pages until every work has a count', async () => {
        repository.find
            .mockResolvedValueOnce(
                Array.from({ length: 20 }, (_, index) => ({
                    workId: 'dir-a',
                    totalItemsCount: 100 - index,
                })) as WorkGenerationHistory[],
            )
            .mockResolvedValueOnce([
                {
                    workId: 'dir-b',
                    totalItemsCount: 42,
                },
            ] as WorkGenerationHistory[]);

        const result = await service.findLatestPositiveItemCounts(['dir-a', 'dir-b']);

        expect(repository.find).toHaveBeenNthCalledWith(1, {
            where: expect.any(Object),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 20,
            skip: 0,
        });
        expect(repository.find).toHaveBeenNthCalledWith(2, {
            where: expect.any(Object),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 20,
            skip: 20,
        });
        expect(result).toEqual(
            new Map([
                ['dir-a', 100],
                ['dir-b', 42],
            ]),
        );
    });

    it('deduplicates requested work ids before querying', async () => {
        repository.find.mockResolvedValueOnce([
            {
                workId: 'dir-a',
                totalItemsCount: 7,
            },
        ] as WorkGenerationHistory[]);

        await service.findLatestPositiveItemCounts(['dir-a', 'dir-a']);

        expect(repository.find).toHaveBeenCalledWith({
            where: expect.objectContaining({
                workId: expect.anything(),
            }),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 10,
            skip: 0,
        });
    });
});
