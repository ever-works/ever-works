import type { Repository } from 'typeorm';
import type { Agent } from '../../entities/agent.entity';
import { AgentRepository } from './agent.repository';

const EVER_SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};

function queryHarness() {
    const predicates: string[] = [];
    const parameters: Record<string, unknown>[] = [];
    const query = {
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
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn(async () => 0),
        getMany: jest.fn(async () => []),
    };
    const repository = {
        createQueryBuilder: jest.fn(() => query),
    } as unknown as Repository<Agent>;
    return { repository, predicates, parameters };
}

describe('AgentRepository Organization scope', () => {
    it('constrains list queries to the exact active Tenant and Organization', async () => {
        const harness = queryHarness();
        const repository = new AgentRepository(harness.repository);

        await repository.findByUserIdScoped('user-1', {}, EVER_SCOPE);

        expect(harness.predicates.join('\n')).toContain('agent.tenantId = :scopeTenantId');
        expect(harness.predicates.join('\n')).toContain(
            'agent.organizationId = :scopeOrganizationId',
        );
        expect(Object.assign({}, ...harness.parameters)).toMatchObject({
            scopeTenantId: EVER_SCOPE.tenantId,
            scopeOrganizationId: EVER_SCOPE.organizationId,
        });
    });

    it('personal scope includes current-Tenant and legacy rows but excludes other Tenants', async () => {
        const harness = queryHarness();
        const repository = new AgentRepository(harness.repository);

        await repository.findByUserIdScoped(
            'user-1',
            {},
            {
                tenantId: EVER_SCOPE.tenantId,
                organizationId: null,
            },
        );

        expect(harness.predicates.join('\n')).toContain('agent.organizationId IS NULL');
        expect(harness.predicates.join('\n')).toContain(
            '(agent.tenantId = :scopeTenantId OR agent.tenantId IS NULL)',
        );
    });
});
