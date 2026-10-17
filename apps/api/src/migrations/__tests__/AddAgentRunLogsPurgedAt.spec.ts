import { DataSource } from 'typeorm';
import { AddAgentRunLogsPurgedAt1795162100000 } from '../1795162100000-AddAgentRunLogsPurgedAt';

/** Slice AT — `agent_runs.logsPurgedAt` + its purge index, on the physical schema. */
describe('AddAgentRunLogsPurgedAt1795162100000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunLogsPurgedAt1795162100000();

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
                "status" varchar(16) NOT NULL,
                "finishedAt" datetime
            )
        `);
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "status", "finishedAt") VALUES ('r1', 'completed', '2026-01-01 00:00:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable, default-free logsPurgedAt and the purge index, rows untouched', async () => {
        await migration.up(dataSource.createQueryRunner());
        const column = (
            (await dataSource.query(`PRAGMA table_info("agent_runs")`)) as Array<{
                name: string;
                notnull: number;
                dflt_value: string | null;
            }>
        ).find((candidate) => candidate.name === 'logsPurgedAt');
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
        const indexes = (await dataSource.query(`PRAGMA index_list("agent_runs")`)) as Array<{
            name: string;
        }>;
        expect(indexes.map((index) => index.name)).toContain('idx_agent_runs_logs_purge');
        expect(await dataSource.query(`SELECT "logsPurgedAt" FROM "agent_runs"`)).toEqual([
            { logsPurgedAt: null },
        ]);
    });

    it('is idempotent and reversible', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        const columns = (await dataSource.query(`PRAGMA table_info("agent_runs")`)) as Array<{
            name: string;
        }>;
        expect(columns.some((column) => column.name === 'logsPurgedAt')).toBe(false);
    });
});
