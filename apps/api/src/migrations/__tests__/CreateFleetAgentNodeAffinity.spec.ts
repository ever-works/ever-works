import { DataSource, Table } from 'typeorm';
import { CreateFleetAgentNodeAffinity1786940000000 } from '../1786940000000-CreateFleetAgentNodeAffinity';

describe('CreateFleetAgentNodeAffinity1786940000000', () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'fleet_jobs',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'status', type: 'varchar', length: '16' },
                ],
            }),
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await new CreateFleetAgentNodeAffinity1786940000000().up(runner);
        await runner.release();
    }

    it('adds the target snapshot and creates the affinity table with the entity indexes', async () => {
        const seed = dataSource.createQueryRunner();
        await seed.query(`INSERT INTO fleet_jobs (id, "userId", status) VALUES (?, ?, ?)`, [
            'job-1',
            'user-1',
            'queued',
        ]);
        await seed.release();

        await runUp();

        const runner = dataSource.createQueryRunner();
        const jobs = await runner.getTable('fleet_jobs');
        const affinities = await runner.getTable('fleet_agent_node_affinities');
        await runner.release();

        expect(jobs?.findColumnByName('targetNodeId')).toMatchObject({ isNullable: true });
        expect(jobs?.indices.map((index) => index.name)).toContain('idx_fleet_jobs_target_status');
        expect(await dataSource.query(`SELECT id FROM fleet_jobs WHERE id = ?`, ['job-1'])).toEqual(
            [{ id: 'job-1' }],
        );
        expect(affinities?.columns.map((column) => column.name).sort()).toEqual(
            [
                'id',
                'userId',
                'organizationId',
                'agentId',
                'nodeId',
                'createdAt',
                'updatedAt',
            ].sort(),
        );
        expect(affinities?.indices.map((index) => index.name).sort()).toEqual(
            ['idx_fleet_agent_node_affinity_node', 'uq_fleet_agent_node_affinity_scope'].sort(),
        );
    });

    it('enforces one target per owner, Organization, and Agent while allowing another Organization', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const insert = (id: string, organizationId: string, nodeId: string) =>
            runner.query(
                `INSERT INTO fleet_agent_node_affinities
                   (id, "userId", "organizationId", "agentId", "nodeId")
                 VALUES (?, ?, ?, ?, ?)`,
                [id, 'user-1', organizationId, 'agent-1', nodeId],
            );

        await insert('affinity-1', 'organization-1', 'node-1');
        await expect(insert('affinity-2', 'organization-1', 'node-2')).rejects.toThrow();
        await expect(insert('affinity-3', 'organization-2', 'node-2')).resolves.not.toThrow();
        await runner.release();
    });

    it('is idempotent and its rollback path preserves existing Fleet data', async () => {
        await runUp();
        await expect(runUp()).resolves.not.toThrow();

        const runner = dataSource.createQueryRunner();
        await new CreateFleetAgentNodeAffinity1786940000000().down(runner);
        expect(await runner.hasTable('fleet_jobs')).toBe(true);
        expect(await runner.hasTable('fleet_agent_node_affinities')).toBe(true);
        expect(
            (await runner.getTable('fleet_jobs'))?.findColumnByName('targetNodeId'),
        ).toBeDefined();
        await runner.release();
    });
});
