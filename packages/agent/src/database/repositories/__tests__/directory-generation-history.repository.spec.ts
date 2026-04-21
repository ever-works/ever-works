import type { Repository } from 'typeorm';
import { DirectoryGenerationHistoryRepository } from '../directory-generation-history.repository';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';

describe('DirectoryGenerationHistoryRepository', () => {
    let repository: jest.Mocked<Pick<Repository<DirectoryGenerationHistory>, 'find'>>;
    let service: DirectoryGenerationHistoryRepository;

    beforeEach(() => {
        repository = {
            find: jest.fn(),
        };

        service = new DirectoryGenerationHistoryRepository(
            repository as unknown as Repository<DirectoryGenerationHistory>,
        );
    });

    it('returns early for an empty directory list', async () => {
        await expect(service.findLatestPositiveItemCounts([])).resolves.toEqual(new Map());
        expect(repository.find).not.toHaveBeenCalled();
    });

    it('fetches history in bounded pages until every directory has a count', async () => {
        repository.find
            .mockResolvedValueOnce(
                Array.from({ length: 20 }, (_, index) => ({
                    directoryId: 'dir-a',
                    totalItemsCount: 100 - index,
                })) as DirectoryGenerationHistory[],
            )
            .mockResolvedValueOnce([
                {
                    directoryId: 'dir-b',
                    totalItemsCount: 42,
                },
            ] as DirectoryGenerationHistory[]);

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

    it('deduplicates requested directory ids before querying', async () => {
        repository.find.mockResolvedValueOnce([
            {
                directoryId: 'dir-a',
                totalItemsCount: 7,
            },
        ] as DirectoryGenerationHistory[]);

        await service.findLatestPositiveItemCounts(['dir-a', 'dir-a']);

        expect(repository.find).toHaveBeenCalledWith({
            where: expect.objectContaining({
                directoryId: expect.anything(),
            }),
            order: { startedAt: 'DESC', createdAt: 'DESC' },
            take: 10,
            skip: 0,
        });
    });
});
