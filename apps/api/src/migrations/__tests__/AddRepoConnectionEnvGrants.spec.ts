import { DataSource, Table } from 'typeorm';
import { AddRepoConnectionEnvGrants1789200000000 } from '../1789200000000-AddRepoConnectionEnvGrants';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 *
 * What matters for run secrets: an existing registry row comes out with a
 * NULL grant list — "this repository grants nothing", which is exactly the
 * refusal every runner already performs — re-running is a no-op, and
 * `down()` reverses it without touching the encrypted `envFiles` beside it.
 */
describe('AddRepoConnectionEnvGrants1789200000000', () => {
    let dataSource: DataSource;
    const migration = new AddRepoConnectionEnvGrants1789200000000();

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
                name: 'repo_connections',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '200' },
                    { name: 'url', type: 'varchar', length: '512' },
                    { name: 'envFiles', type: 'text', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO repo_connections (id, "userId", name, url, "envFiles") VALUES (?, ?, ?, ?, ?)`,
            ['repo-1', 'user-1', 'platform', 'https://github.com/ever-works/ever-works.git', null],
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

    it('adds a nullable envGrants column and leaves existing repositories granting nothing', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('repo_connections');
        await runner.release();
        expect(table?.findColumnByName('envGrants')).toMatchObject({ isNullable: true });
        expect(
            await dataSource.query(
                `SELECT id, "envGrants", "envFiles" FROM repo_connections WHERE id = ?`,
                ['repo-1'],
            ),
        ).toEqual([{ id: 'repo-1', envGrants: null, envFiles: null }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        const runner = dataSource.createQueryRunner();
        expect(
            (await runner.getTable('repo_connections'))?.findColumnByName('envGrants'),
        ).toBeDefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('repo_connections'))?.findColumnByName('envGrants'),
        ).toBeUndefined();
        await migration.down(runner);
        expect(
            (await runner.getTable('repo_connections'))?.findColumnByName('envGrants'),
        ).toBeUndefined();
        // The encrypted env-file column is untouched by either direction.
        expect(
            (await runner.getTable('repo_connections'))?.findColumnByName('envFiles'),
        ).toBeDefined();
        await runner.release();
    });
});
