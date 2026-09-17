import { DataSource } from 'typeorm';
import { AddAgentRunModelRouting1791160100000 } from '../1791160100000-AddAgentRunModelRouting';

/**
 * Migration test for `agent_runs.modelRouting` (AW-16).
 *
 * The one property that matters most: an existing Run reads back with no
 * routing record. A Run that predates the column never claims a model it
 * cannot prove answered it.
 */
describe('AddAgentRunModelRouting1791160100000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunModelRouting1791160100000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "agent_runs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "status" varchar NOT NULL,
                "totalTokens" integer,
                "costCents" integer
            )
        `);
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "status", "totalTokens", "costCents") VALUES ('r1', 'completed', 1200, 4)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable column and leaves every existing run without a routing record', async () => {
        await run('up');
        const [row] = await dataSource.query(
            `SELECT "modelRouting", "totalTokens", "costCents" FROM "agent_runs" WHERE "id" = 'r1'`,
        );
        expect(row).toEqual({ modelRouting: null, totalTokens: 1200, costCents: 4 });
    });

    it('stores a routing record', async () => {
        await run('up');
        const routing = JSON.stringify({ provider: 'provider-a', model: 'm', outcome: 'answered' });
        await dataSource.query(`UPDATE "agent_runs" SET "modelRouting" = ? WHERE "id" = 'r1'`, [
            routing,
        ]);
        const [row] = await dataSource.query(`SELECT "modelRouting" FROM "agent_runs"`);
        expect(JSON.parse(row.modelRouting)).toMatchObject({ provider: 'provider-a' });
    });

    it('is idempotent', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down() drops only the column it added', async () => {
        await run('up');
        await run('down');
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('agent_runs');
        await runner.release();
        expect(table?.columns.map((column) => column.name).sort()).toEqual([
            'costCents',
            'id',
            'status',
            'totalTokens',
        ]);
        const [row] = await dataSource.query(`SELECT "totalTokens" FROM "agent_runs"`);
        expect(row.totalTokens).toBe(1200);
    });

    it('does nothing when agent_runs does not exist', async () => {
        await dataSource.query(`DROP TABLE "agent_runs"`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
