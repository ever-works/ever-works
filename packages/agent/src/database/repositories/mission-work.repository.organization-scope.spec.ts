import type { Repository } from 'typeorm';
import type { MissionWork } from '../../entities/mission-work.entity';
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
});
