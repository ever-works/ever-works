import { DataSource, Table } from 'typeorm';
import { AddWorkAppSpecBlueprintUpgradeRun1796600000000 } from '../1796600000000-AddWorkAppSpecBlueprintUpgradeRun';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What matters:
 * the three run columns are added nullable, an existing state row survives untouched
 * with NULLs (no run was ever requested for it), re-running is a no-op, and `down()`
 * removes exactly the three columns.
 */
describe('AddWorkAppSpecBlueprintUpgradeRun1796600000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkAppSpecBlueprintUpgradeRun1796600000000();
    const RUN_COLUMNS = ['blueprintUpgradeStatus', 'blueprintUpgradeError', 'blueprintUpgradeRequestedAt'];

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
                name: 'work_app_spec_states',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'workId', type: 'uuid' },
                    { name: 'trackedBranch', type: 'varchar', length: '255' },
                    { name: 'blueprintId', type: 'varchar', length: '64', isNullable: true },
                    { name: 'blueprintVersion', type: 'varchar', length: '32', isNullable: true },
                    { name: 'blueprintUpgradePr', type: 'text', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO work_app_spec_states (id, "workId", "trackedBranch", "blueprintId", "blueprintVersion") VALUES (?, ?, ?, ?, ?)`,
            ['state-1', 'work-1', 'main', 'umami', '0.1.0'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function run(direction: 'up' | 'down'): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    }

    async function table() {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable('work_app_spec_states');
        await runner.release();
        return found;
    }

    it('adds the three run columns, all nullable', async () => {
        await run('up');
        const states = await table();
        for (const column of RUN_COLUMNS) {
            expect(states?.findColumnByName(column)).toMatchObject({ isNullable: true });
        }
    });

    it('leaves an existing row untouched, with no invented run', async () => {
        await run('up');
        expect(
            await dataSource.query(
                `SELECT "blueprintId", "blueprintVersion", "blueprintUpgradeStatus", "blueprintUpgradeError", "blueprintUpgradeRequestedAt" FROM work_app_spec_states WHERE id = ?`,
                ['state-1'],
            ),
        ).toEqual([
            {
                blueprintId: 'umami',
                blueprintVersion: '0.1.0',
                blueprintUpgradeStatus: null,
                blueprintUpgradeError: null,
                blueprintUpgradeRequestedAt: null,
            },
        ]);
    });

    it('is a no-op when run twice', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        const states = await table();
        expect(states?.columns.filter((column) => RUN_COLUMNS.includes(column.name))).toHaveLength(3);
    });

    it('down() removes exactly the three columns and keeps the rest', async () => {
        await run('up');
        await run('down');
        const states = await table();
        for (const column of RUN_COLUMNS) {
            expect(states?.findColumnByName(column)).toBeUndefined();
        }
        expect(states?.findColumnByName('blueprintUpgradePr')).toBeDefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
