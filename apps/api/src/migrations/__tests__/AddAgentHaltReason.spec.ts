import { DataSource, Table } from 'typeorm';
import { AddAgentHaltReason1791230000000 } from '../1791230000000-AddAgentHaltReason';

/**
 * Same in-memory better-sqlite3 harness as the sibling agent migration
 * specs. What matters: an agent that is ALREADY paused survives with a
 * NULL reason (nobody recorded why, and we do not invent one), the
 * repeat counter starts at 0 rather than NULL, re-running is a no-op,
 * and `down()` reverses all eight columns.
 */
describe('AddAgentHaltReason1791230000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentHaltReason1791230000000();

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
                name: 'agents',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '120' },
                    { name: 'slug', type: 'varchar', length: '80' },
                    { name: 'status', type: 'varchar', length: '16', default: "'draft'" },
                    { name: 'errorCount', type: 'int', default: 0 },
                    { name: 'pauseAfterFailures', type: 'int', default: 3 },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO agents (id, "userId", name, slug, status) VALUES (?, ?, ?, ?, ?)`,
            ['agent-1', 'user-1', 'research', 'research', 'paused'],
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

    it('adds the seven nullable halt columns plus a zeroed repeat counter', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const agents = await runner.getTable('agents');
        await runner.release();

        for (const column of [
            'haltReason',
            'haltNote',
            'haltedAt',
            'haltedByUserId',
            'haltedRunId',
            'haltDetail',
            'haltRepeatReason',
        ]) {
            expect(agents?.findColumnByName(column)).toMatchObject({ isNullable: true });
        }
        expect(agents?.findColumnByName('haltRepeatCount')).toMatchObject({ isNullable: false });
    });

    it('leaves an already-paused agent with no invented reason, time or author', async () => {
        await runUp();
        expect(
            await dataSource.query(
                `SELECT status, "haltReason", "haltedAt", "haltedByUserId", "haltRepeatCount" FROM agents WHERE id = ?`,
                ['agent-1'],
            ),
        ).toEqual([
            {
                status: 'paused',
                haltReason: null,
                haltedAt: null,
                haltedByUserId: null,
                haltRepeatCount: 0,
            },
        ]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect((await runner.getTable('agents'))?.findColumnByName('haltReason')).toBeDefined();

        await migration.down(runner);
        const afterDown = await runner.getTable('agents');
        for (const column of [
            'haltReason',
            'haltNote',
            'haltedAt',
            'haltedByUserId',
            'haltedRunId',
            'haltDetail',
            'haltRepeatCount',
            'haltRepeatReason',
        ]) {
            expect(afterDown?.findColumnByName(column)).toBeUndefined();
        }
        // The agent row itself survives a revert — only the new values go.
        expect(await runner.query(`SELECT id, status FROM agents`)).toEqual([
            { id: 'agent-1', status: 'paused' },
        ]);

        await migration.down(runner);
        expect(
            (await runner.getTable('agents'))?.findColumnByName('haltRepeatCount'),
        ).toBeUndefined();
        await runner.release();
    });
});
