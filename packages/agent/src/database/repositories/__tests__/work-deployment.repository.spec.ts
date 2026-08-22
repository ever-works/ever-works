import type { Repository, SelectQueryBuilder } from 'typeorm';
import { WorkDeploymentRepository } from '../work-deployment.repository';
import { DeploymentEnvironment, WorkDeployment } from '../../../entities/work-deployment.entity';

describe('WorkDeploymentRepository', () => {
    it('uses a correlated latest-row query instead of loading all deployment history', async () => {
        const rows = [
            { id: 'd2', workId: 'w1' },
            { id: 'd4', workId: 'w2' },
        ] as WorkDeployment[];
        const subquery = buildQueryBuilder<WorkDeployment>();
        subquery.getQuery.mockReturnValue('(SELECT latest.id)');
        const query = buildQueryBuilder<WorkDeployment>();
        query.subQuery.mockReturnValue(subquery as never);
        query.getMany.mockResolvedValue(rows);
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValue(query),
            find: jest.fn(),
        } as unknown as Repository<WorkDeployment>;
        const service = new WorkDeploymentRepository(repository);

        const result = await service.findLatestForWorks(
            ['w1', 'w2'],
            DeploymentEnvironment.PRODUCTION,
        );

        expect(repository.find as jest.Mock).not.toHaveBeenCalled();
        expect(subquery.orderBy).toHaveBeenCalledWith('latest.createdAt', 'DESC');
        expect(subquery.addOrderBy).toHaveBeenCalledWith('latest.id', 'DESC');
        expect(subquery.limit).toHaveBeenCalledWith(1);
        expect(query.andWhere).toHaveBeenCalledWith('deployment.id = (SELECT latest.id)');
        expect(result).toEqual(
            new Map([
                ['w1', rows[0]],
                ['w2', rows[1]],
            ]),
        );
    });
});

function buildQueryBuilder<TEntity>() {
    const query = {} as jest.Mocked<SelectQueryBuilder<TEntity>>;
    for (const method of [
        'select',
        'from',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'limit',
        'setParameters',
    ] as const) {
        query[method] = jest.fn().mockReturnValue(query) as never;
    }
    query.subQuery = jest.fn() as never;
    query.getQuery = jest.fn() as never;
    query.getMany = jest.fn() as never;
    return query;
}
