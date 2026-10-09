import { DataSource, Table } from 'typeorm';
import { AddAgentRunFleetCliSession1795010000000 } from '../1795010000000-AddAgentRunFleetCliSession';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters: existing runs survive with a NULL record (no fleet session
 * was ever kept, which is the true history) and their `cliSessionId`
 * untouched, the column takes the JSON the reconciler writes later,
 * re-running is a no-op, and `down()` drops only that column.
 */
describe('AddAgentRunFleetCliSession1795010000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunFleetCliSession1795010000000();

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
                name: 'agent_runs',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'cliSessionId', type: 'varchar', length: '128', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO agent_runs (id, "userId", status, "cliSessionId") VALUES (?, ?, ?, ?)`,
            ['run-1', 'user-1', 'completed', 'cloud-terminal-session'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function column() {
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('agent_runs');
        await runner.release();
        return table?.findColumnByName('fleetCliSession');
    }

    it('adds a nullable text column and leaves every existing run without a fleet session', async () => {
        await runUp();

        expect(await column()).toMatchObject({ isNullable: true, type: 'text' });
        expect(
            await dataSource.query(
                `SELECT id, status, "cliSessionId", "fleetCliSession" FROM agent_runs WHERE id = ?`,
                ['run-1'],
            ),
        ).toEqual([
            {
                id: 'run-1',
                status: 'completed',
                cliSessionId: 'cloud-terminal-session',
                fleetCliSession: null,
            },
        ]);
    });

    it('stores the JSON record once written, and clears back to NULL', async () => {
        await runUp();
        const record = JSON.stringify({
            sessionId: '3f0e9a52-7b1c-4d2e-9a8f-0c1d2e3f4a5b',
            nodeId: '11111111-1111-4111-8111-111111111111',
            provider: 'claude-code',
        });

        await dataSource.query(`UPDATE agent_runs SET "fleetCliSession" = ? WHERE id = ?`, [
            record,
            'run-1',
        ]);
        const [written] = await dataSource.query(
            `SELECT "fleetCliSession" FROM agent_runs WHERE id = ?`,
            ['run-1'],
        );
        expect(JSON.parse(written.fleetCliSession)).toEqual(JSON.parse(record));

        await dataSource.query(`UPDATE agent_runs SET "fleetCliSession" = NULL WHERE id = ?`, [
            'run-1',
        ]);
        const [cleared] = await dataSource.query(
            `SELECT "fleetCliSession" FROM agent_runs WHERE id = ?`,
            ['run-1'],
        );
        expect(cleared.fleetCliSession).toBeNull();
    });

    it('is idempotent on re-run and reversible, dropping only its own column', async () => {
        await runUp();
        await runUp();
        expect(await column()).toBeDefined();

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await migration.down(runner);
        const table = await runner.getTable('agent_runs');
        await runner.release();

        expect(table?.findColumnByName('fleetCliSession')).toBeUndefined();
        expect(table?.columns.map((c) => c.name).sort()).toEqual(
            ['cliSessionId', 'id', 'status', 'userId'].sort(),
        );
    });

    it('does nothing on a database without the table', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('agent_runs');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
