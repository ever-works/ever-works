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
    const deleted: Record<string, unknown>[] = [];
    const repository = {
        createQueryBuilder: jest.fn(() => query),
        delete: jest.fn(async (criteria: Record<string, unknown>) => {
            deleted.push(criteria);
            return { affected: 1 };
        }),
    } as unknown as Repository<MissionWork>;
    return { repository, selected, predicates, parameters, deleted };
}

describe('MissionWorkRepository Organization scope', () => {
    it('returns relation ownership, constrains the joined Work to the active Organization, and leaves the edge row to follow its validated Mission endpoint', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        await (repository.listForMissionWithWork as any)('mission-1', 'user-1', EVER_SCOPE);

        expect(harness.selected).toEqual(
            expect.arrayContaining([
                'rel.tenantId AS "tenantId"',
                'rel.organizationId AS "organizationId"',
            ]),
        );
        // The edge row is a pure join keyed by its validated endpoints;
        // filtering it by its own STAMP would hide legacy pre-stamping
        // relations (upgrade-from-account backfills missions/works but not
        // mission_works) from their own owner.
        expect(harness.predicates.join('\n')).not.toContain('rel.tenantId');
        expect(harness.predicates.join('\n')).not.toContain('rel.organizationId IS');
        expect(harness.predicates.join('\n')).toContain('rel.userId');
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

        expect(harness.predicates.join('\n')).toContain('work.organizationId IS NULL');
        expect(harness.predicates.join('\n')).not.toContain('rel.organizationId IS NULL');
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
        expect(harness.predicates.join('\n')).not.toContain('rel.tenantId');
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
        expect(predicates).toContain('work.tenantId IS NULL');
        expect(predicates).not.toContain('rel.tenantId IS NULL');
        expect(predicates).not.toContain('tenantId = :scopeTenantId');
        expect(parameters).not.toHaveProperty('scopeTenantId');
    });

    it('detaches by the validated endpoint keys alone, never by the edge stamp', async () => {
        const harness = queryHarness();
        const repository = new MissionWorkRepository(harness.repository);

        const removed = await repository.detach({
            missionId: 'mission-1',
            workId: 'work-1',
            userId: 'user-1',
            relation: 'created',
            scope: EVER_SCOPE,
        });

        // The calling service already ownership-validated the Mission in the
        // active scope; a stamp-filtered delete would leave a legacy
        // (pre-stamping) edge of an in-scope Mission permanently
        // un-detachable (404 forever).
        expect(removed).toBe(true);
        expect(harness.repository.createQueryBuilder).not.toHaveBeenCalled();
        expect(harness.deleted).toEqual([
            {
                missionId: 'mission-1',
                workId: 'work-1',
                userId: 'user-1',
                relation: 'created',
            },
        ]);
    });

    it('issues the real detach as a plain criteria delete with only scalar endpoint keys', async () => {
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
        const captured: unknown[] = [];
        jest.spyOn(orm, 'delete').mockImplementation(async (criteria: unknown) => {
            captured.push(criteria);
            return { affected: 1, raw: [] } as DeleteResult;
        });

        await new MissionWorkRepository(orm).detach({
            missionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            relation: 'created',
            scope: EVER_SCOPE,
        });

        expect(captured).toEqual([
            {
                missionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                relation: 'created',
            },
        ]);
        const criteria = captured[0] as Record<string, unknown>;
        expect(criteria).not.toHaveProperty('tenantId');
        expect(criteria).not.toHaveProperty('organizationId');
        expect(Object.values(criteria).every((value) => typeof value === 'string')).toBe(true);
    });
});
