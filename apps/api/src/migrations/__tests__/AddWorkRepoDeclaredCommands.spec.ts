import { DataSource, Table } from 'typeorm';
import { AddWorkRepoDeclaredCommands1789900000000 } from '../1789900000000-AddWorkRepoDeclaredCommands';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 *
 * What matters for EW-807: an existing Work comes out with a NULL policy —
 * which the normalizer resolves to `off`, so the repository's own
 * `.works/works.yml` is not consulted for commands and nothing that used
 * to be graded changes. Re-running is a no-op, `down()` reverses it, and
 * neither direction touches the `checkDefaults` column beside it.
 *
 * Assertions go against the PHYSICAL schema (`PRAGMA table_info`) as well
 * as TypeORM's own view of it: `getTable` reads a metadata projection, and
 * a migration that satisfied the projection while leaving the table
 * unchanged would be exactly the bug this spec is for.
 */
describe('AddWorkRepoDeclaredCommands1789900000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkRepoDeclaredCommands1789900000000();

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info('works')`);
        return rows.map((row) => row.name);
    }

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
                name: 'works',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '200' },
                    { name: 'checkDefaults', type: 'text', isNullable: true },
                    { name: 'checksPolicy', type: 'varchar', length: '12', default: `'off'` },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO works (id, "userId", name, "checkDefaults") VALUES (?, ?, ?, ?)`,
            ['work-1', 'user-1', 'platform', '[{"id":"tests","command":"pnpm test"}]'],
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

    it('adds a nullable repoDeclaredCommands column and leaves existing Works reading nothing', async () => {
        expect(await columnNames()).not.toContain('repoDeclaredCommands');
        await runUp();

        expect(await columnNames()).toContain('repoDeclaredCommands');
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('works');
        await runner.release();
        expect(table?.findColumnByName('repoDeclaredCommands')).toMatchObject({ isNullable: true });

        // NULL is `{ mode: 'off' }`: the repository's file is not consulted
        // for commands, and the Work's own checkDefaults are untouched.
        expect(
            await dataSource.query(
                `SELECT id, "repoDeclaredCommands", "checkDefaults" FROM works WHERE id = ?`,
                ['work-1'],
            ),
        ).toEqual([
            {
                id: 'work-1',
                repoDeclaredCommands: null,
                checkDefaults: '[{"id":"tests","command":"pnpm test"}]',
            },
        ]);
    });

    it('accepts a policy document once applied', async () => {
        await runUp();
        await dataSource.query(`UPDATE works SET "repoDeclaredCommands" = ? WHERE id = ?`, [
            '{"mode":"allowlist","allow":["pnpm test"]}',
            'work-1',
        ]);
        expect(
            await dataSource.query(`SELECT "repoDeclaredCommands" FROM works WHERE id = ?`, [
                'work-1',
            ]),
        ).toEqual([{ repoDeclaredCommands: '{"mode":"allowlist","allow":["pnpm test"]}' }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        expect(await columnNames()).toContain('repoDeclaredCommands');

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
        expect(await columnNames()).not.toContain('repoDeclaredCommands');

        const second = dataSource.createQueryRunner();
        await migration.down(second);
        await second.release();
        expect(await columnNames()).not.toContain('repoDeclaredCommands');

        // The gate columns beside it survive both directions.
        expect(await columnNames()).toEqual(
            expect.arrayContaining(['checkDefaults', 'checksPolicy']),
        );
        expect(
            await dataSource.query(`SELECT "checkDefaults" FROM works WHERE id = ?`, ['work-1']),
        ).toEqual([{ checkDefaults: '[{"id":"tests","command":"pnpm test"}]' }]);
    });
});
