import { DataSource } from 'typeorm';
import { AddAgentRunDelegationScope1784810000000 } from '../1784810000000-AddAgentRunDelegationScope';

/**
 * Migration test for `agent_runs.delegationScope` — the column that makes
 * a delegated child run actually CONFINED to the scope it was admitted
 * under.
 *
 * Uses the same in-memory better-sqlite3 harness as the sibling migration
 * specs. What matters here is unglamorous but load-bearing:
 *
 *  - existing rows survive with NULL, which every reader treats as "no
 *    additional restriction" (nothing predating the column was dispatched
 *    with a scope, so that is the correct reading rather than a lenient
 *    one);
 *  - up() is idempotent, because the house pattern is forward-only with
 *    per-step guards and re-running must not throw;
 *  - down() actually removes it.
 */
describe('AddAgentRunDelegationScope1784810000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunDelegationScope1784810000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of `agent_runs` this migration touches.
        await dataSource.query(`
            CREATE TABLE "agent_runs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "agentId" varchar NOT NULL,
                "userId" varchar NOT NULL,
                "status" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "agentId", "userId", "status") VALUES ('r1', 'a1', 'u1', 'completed')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the column and leaves existing rows NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(`SELECT "delegationScope" FROM "agent_runs"`);
        expect(rows).toHaveLength(1);
        // NULL, not '' and not a default scope: an existing run was never
        // delegated, and inventing an empty allowlist would strip every
        // tool from it.
        expect(rows[0].delegationScope).toBeNull();

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    it('down() removes the column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        const table = await runner.getTable('agent_runs');
        expect(table?.findColumnByName('delegationScope')).toBeUndefined();

        await runner.release();
    });

    it('round-trips a scope value', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const scope = JSON.stringify({ allowedTools: ['getSkillBody'], workId: 'w1' });
        await dataSource.query(`UPDATE "agent_runs" SET "delegationScope" = ? WHERE "id" = 'r1'`, [
            scope,
        ]);

        const rows = await dataSource.query(
            `SELECT "delegationScope" FROM "agent_runs" WHERE "id" = 'r1'`,
        );
        expect(JSON.parse(rows[0].delegationScope)).toEqual({
            allowedTools: ['getSkillBody'],
            workId: 'w1',
        });

        await runner.release();
    });
});
