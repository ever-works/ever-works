import { DataSource } from 'typeorm';
import { CreateAgentCollaborators1786800000000 } from '../1786800000000-CreateAgentCollaborators';

/**
 * Migration test for the `agent_collaborators` table.
 *
 * Same in-memory better-sqlite3 harness as the sibling specs — CI/e2e
 * run sqlite while production runs Postgres, so passing here is what
 * proves the portable Table API usage actually is portable.
 */
describe('CreateAgentCollaborators1786800000000', () => {
    let dataSource: DataSource;
    const migration = new CreateAgentCollaborators1786800000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the table with every expected column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('agent_collaborators');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'userId',
            'agentId',
            'collaboratorAgentId',
            'enabled',
            'tenantId',
            'organizationId',
            'createdAt',
            'updatedAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('rejects a second row for the same (agentId, collaboratorAgentId) pair', async () => {
        // The unique index is what makes the PUT endpoint an upsert
        // rather than an accumulating history of duplicate rules.
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO "agent_collaborators"
                    ("id","userId","agentId","collaboratorAgentId","enabled","createdAt","updatedAt")
                 VALUES ('${id}','u1','agent-a','agent-b',1,'2026-08-14','2026-08-14')`,
            );

        await expect(insert('c1')).resolves.not.toThrow();
        await expect(insert('c2')).rejects.toThrow();

        await runner.release();
    });

    it('allows the same collaborator on DIFFERENT parent agents', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await dataSource.query(
            `INSERT INTO "agent_collaborators"
                ("id","userId","agentId","collaboratorAgentId","enabled","createdAt","updatedAt")
             VALUES ('c1','u1','agent-a','agent-b',1,'2026-08-14','2026-08-14')`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "agent_collaborators"
                    ("id","userId","agentId","collaboratorAgentId","enabled","createdAt","updatedAt")
                 VALUES ('c2','u1','agent-c','agent-b',0,'2026-08-14','2026-08-14')`,
            ),
        ).resolves.not.toThrow();

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('agent_collaborators')).toBe(false);

        await runner.release();
    });
});
