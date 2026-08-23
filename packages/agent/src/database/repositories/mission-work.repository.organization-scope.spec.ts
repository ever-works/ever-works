import { DataSource, type DeleteResult, type Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { MissionWork } from '../../entities/mission-work.entity';
import { MissionWorkRepository } from './mission-work.repository';

const EVER_SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};

function queryHarness() {
    const selected: string[] = [];
    const predicates: string[] = [];
    const parameters: Record<string, unknown>[] = [];
    const query = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn((columns: string[]) => {
            selected.push(...columns);
            return query;
        }),
        where: jest.fn((predicate: string, params?: Record<string, unknown>) => {
            predicates.push(predicate);
            if (params) parameters.push(params);
            return query;
        }),
        andWhere: jest.fn((predicate: string, params?: Record<string, unknown>) => {
            predicates.push(predicate);
            if (params) parameters.push(params);
            return query;
        }),
        orderBy: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 1 })),
        getRawMany: jest.fn(async () => []),
    };
    const repository = {
        createQueryBuilder: jest.fn(() => query),
    } as unknown as Repository<MissionWork>;
    return { repository, selected, predicates, parameters };
}

describe('MissionWorkRepository Organization scope', () => {
    it('returns relation ownership and constrains both relation and Work to the active Organization', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await (repository.listForMissionWithWork as any)('mission-1', 'user-1', EVER_SCOPE);

        expect(harness.selected).toEqual(
            expect.arrayContaining([
                'rel.tenantId AS "tenantId"',
                'rel.organizationId AS "organizationId"',
            ]),
        );
        expect(harness.predicates.join('\n')).toContain('rel.tenantId');
        expect(harness.predicates.join('\n')).toContain('rel.organizationId');
        expect(harness.predicates.join('\n')).toContain('work.tenantId');
        expect(harness.predicates.join('\n')).toContain('work.organizationId');
        expect(Object.assign({}, ...harness.parameters)).toMatchObject({
            scopeTenantId: EVER_SCOPE.tenantId,
            scopeOrganizationId: EVER_SCOPE.organizationId,
        });
    });

    it('keeps legacy personal relations visible but excludes every Organization relation', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await (repository.listForMissionWithWork as any)('mission-1', 'user-1', {
            tenantId: EVER_SCOPE.tenantId,
            organizationId: null,
        });

        expect(harness.predicates.join('\n')).toContain('rel.organizationId IS NULL');
        expect(harness.predicates.join('\n')).toContain('work.organizationId IS NULL');
    });

    it('constrains the reverse relation lookup and its Mission parent to the active Organization', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await (repository.listForWorkWithMission as any)('work-1', 'user-1', EVER_SCOPE);

        expect(harness.selected).toEqual(
            expect.arrayContaining([
                'rel.tenantId AS "tenantId"',
                'rel.organizationId AS "organizationId"',
            ]),
        );
        expect(harness.predicates.join('\n')).toContain('mission.tenantId');
        expect(harness.predicates.join('\n')).toContain('mission.organizationId');
    });

    it('uses canonical IS NULL semantics for an Organization whose Tenant is null', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await repository.listForMissionWithWork('mission-1', 'user-1', {
            tenantId: null,
            organizationId: EVER_SCOPE.organizationId,
        });

        const predicates = harness.predicates.join('\n');
        const parameters = Object.assign({}, ...harness.parameters);
        expect(predicates).toContain('rel.tenantId IS NULL');
        expect(predicates).toContain('work.tenantId IS NULL');
        expect(predicates).not.toContain('tenantId = :scopeTenantId');
        expect(parameters).not.toHaveProperty('scopeTenantId');
    });

    it('builds scoped detach from portable property criteria with no scope object parameter', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await repository.detach({
            missionId: 'mission-1',
            workId: 'work-1',
            userId: 'user-1',
            relation: 'created',
            scope: EVER_SCOPE,
        });

        expect(harness.repository.createQueryBuilder).toHaveBeenCalledWith();
        expect(
            (harness.repository.createQueryBuilder as jest.Mock).mock.results[0].value.where,
        ).toHaveBeenCalledWith([
            {
                missionId: 'mission-1',
                workId: 'work-1',
                userId: 'user-1',
                relation: 'created',
                ...EVER_SCOPE,
            },
        ]);
    });

    it('emits portable quoted PostgreSQL detach SQL with only scalar ownership parameters', async () => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const orm = dataSource.getRepository(MissionWork);
        const query = orm.createQueryBuilder().delete().from(MissionWork);
        let emitted: [string, unknown[]] | undefined;
        let namedParameters: Record<string, unknown> | undefined;
        jest.spyOn(query, 'execute').mockImplementation(async () => {
            emitted = query.getQueryAndParameters();
            namedParameters = query.getParameters();
            return { affected: 1, raw: [] } as DeleteResult;
        });
        jest.spyOn(orm, 'createQueryBuilder').mockReturnValue({
            delete: jest.fn(() => query),
        } as never);

        await new MissionWorkRepository(orm).detach({
            missionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            relation: 'created',
            scope: EVER_SCOPE,
        });

        expect(emitted).toBeDefined();
        expect(emitted![0]).toContain('"missionId"');
        expect(emitted![0]).toContain('"workId"');
        expect(emitted![0]).toContain('"userId"');
        expect(emitted![0]).toContain('"tenantId"');
        expect(emitted![0]).toContain('"organizationId"');
        expect(emitted![1]).toHaveLength(6);
        expect(Object.values(namedParameters ?? {})).toHaveLength(6);
        expect(Object.values(namedParameters ?? {})).not.toContainEqual(EVER_SCOPE);
        expect(
            Object.values(namedParameters ?? {}).every((value) => typeof value === 'string'),
        ).toBe(true);
    });
});
