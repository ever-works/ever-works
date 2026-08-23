import { DataSource, type Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { AgentRepository } from './agent.repository';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('AgentRepository null-Tenant Organization SQL', () => {
    describe('better-sqlite3 behavior', () => {
        let dataSource: DataSource;
        let agents: Repository<Agent>;
        let userId: string;

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'better-sqlite3',
                database: ':memory:',
                entities: ENTITIES,
                synchronize: true,
            });
            await dataSource.initialize();

            const users = dataSource.getRepository(User);
            const user = await users.save(
                users.create({
                    username: 'null-tenant-agent-scope',
                    email: 'null-tenant-agent-scope@example.com',
                    password: 'x',
                } as Partial<User>),
            );
            userId = user.id;
            agents = dataSource.getRepository(Agent);
            await agents.save([
                agents.create({
                    userId,
                    tenantId: null,
                    organizationId: ORGANIZATION_ID,
                    scope: AgentScope.TENANT,
                    name: 'Legacy Organization Agent',
                    slug: 'legacy-organization-agent',
                    status: AgentStatus.ACTIVE,
                    permissions: {},
                } as Partial<Agent>),
                agents.create({
                    userId,
                    tenantId: TENANT_ID,
                    organizationId: ORGANIZATION_ID,
                    scope: AgentScope.TENANT,
                    name: 'Tenant Organization Agent',
                    slug: 'tenant-organization-agent',
                    status: AgentStatus.ACTIVE,
                    permissions: {},
                } as Partial<Agent>),
            ]);
        });

        afterAll(async () => {
            if (dataSource?.isInitialized) await dataSource.destroy();
        });

        it('returns only the exact null-Tenant Organization row', async () => {
            const repository = new AgentRepository(agents);

            const result = await repository.findByUserIdScoped(
                userId,
                {},
                { tenantId: null, organizationId: ORGANIZATION_ID },
            );

            expect(result.rows.map((row) => row.slug)).toEqual(['legacy-organization-agent']);
            expect(result.total).toBe(1);
        });
    });

    it('emits quoted PostgreSQL identifiers and never binds a null Tenant to equality', async () => {
        const dataSource = new DataSource({
            type: 'postgres',
            host: '127.0.0.1',
            username: 'unused',
            password: 'unused',
            database: 'unused',
            entities: ENTITIES,
        });
        await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
        const orm = dataSource.getRepository(Agent);
        const query = orm.createQueryBuilder('agent');
        let emitted: [string, unknown[]] | undefined;
        jest.spyOn(query, 'getCount').mockImplementation(async () => {
            emitted = query.getQueryAndParameters();
            return 0;
        });
        jest.spyOn(query, 'getMany').mockResolvedValue([]);
        jest.spyOn(orm, 'createQueryBuilder').mockReturnValue(query);

        await new AgentRepository(orm).findByUserIdScoped(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            {},
            { tenantId: null, organizationId: ORGANIZATION_ID },
        );

        expect(emitted).toBeDefined();
        expect(emitted![0]).toContain('"agent"."tenantId" IS NULL');
        expect(emitted![0]).toContain('"agent"."organizationId" =');
        expect(emitted![1]).toContain(ORGANIZATION_ID);
        expect(emitted![1]).not.toContain(null);
    });
});
