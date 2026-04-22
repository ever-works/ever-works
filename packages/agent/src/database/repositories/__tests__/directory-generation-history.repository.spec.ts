import type { Repository } from 'typeorm';
import { DirectoryGenerationHistoryRepository } from '../directory-generation-history.repository';
import { DirectoryGenerationHistory } from '@src/entities/directory-generation-history.entity';

describe('DirectoryGenerationHistoryRepository', () => {
    let queryBuilder: {
        select: jest.Mock;
        addSelect: jest.Mock;
        where: jest.Mock;
        andWhere: jest.Mock;
        subQuery: jest.Mock;
        from: jest.Mock;
        getQuery: jest.Mock;
        getRawMany: jest.Mock;
    };
    let repository: jest.Mocked<Pick<Repository<DirectoryGenerationHistory>, 'createQueryBuilder'>>;
    let service: DirectoryGenerationHistoryRepository;

    beforeEach(() => {
        queryBuilder = {
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            subQuery: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            getQuery: jest.fn().mockReturnValue('SELECT 1'),
            getRawMany: jest.fn(),
        };

        repository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };

        service = new DirectoryGenerationHistoryRepository(
            repository as unknown as Repository<DirectoryGenerationHistory>,
        );
    });

    it('returns early for an empty directory list', async () => {
        await expect(service.findLatestPositiveItemCounts([])).resolves.toEqual(new Map());
        expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns the latest positive item count for each requested directory in one query', async () => {
        queryBuilder.getRawMany.mockResolvedValueOnce([
            { directoryId: 'dir-a', totalItemsCount: 100 },
            { directoryId: 'dir-b', totalItemsCount: '42' },
        ]);

        const result = await service.findLatestPositiveItemCounts(['dir-a', 'dir-b']);

        expect(repository.createQueryBuilder).toHaveBeenCalledWith('history');
        expect(queryBuilder.where).toHaveBeenCalledWith(
            'history.directoryId IN (:...directoryIds)',
            {
                directoryIds: ['dir-a', 'dir-b'],
            },
        );
        expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
        expect(result).toEqual(
            new Map([
                ['dir-a', 100],
                ['dir-b', 42],
            ]),
        );
    });

    it('deduplicates requested directory ids before querying', async () => {
        queryBuilder.getRawMany.mockResolvedValueOnce([
            { directoryId: 'dir-a', totalItemsCount: 7 },
        ]);

        await service.findLatestPositiveItemCounts(['dir-a', 'dir-a']);

        expect(queryBuilder.where).toHaveBeenCalledWith(
            'history.directoryId IN (:...directoryIds)',
            {
                directoryIds: ['dir-a'],
            },
        );
    });

    it('uses the largest positive count when multiple latest rows tie on timestamps', async () => {
        queryBuilder.getRawMany.mockResolvedValueOnce([
            { directoryId: 'dir-a', totalItemsCount: 7 },
            { directoryId: 'dir-a', totalItemsCount: 11 },
        ]);

        const result = await service.findLatestPositiveItemCounts(['dir-a']);

        expect(result).toEqual(new Map([['dir-a', 11]]));
    });
});
