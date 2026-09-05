import { DataSource, Table } from 'typeorm';
import { AddExternalIssueLinkRegressionCount1789600000000 } from '../1789600000000-AddExternalIssueLinkRegressionCount';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 *
 * The assertions are against the PHYSICAL schema (`PRAGMA table_info`),
 * not against "an INSERT failed": the properties that matter here are
 * that the column exists, that it is NOT NULL with a `0` default, and
 * that the rows written before the migration read `0` rather than NULL —
 * a link that has never re-opened work. Watching an INSERT fail would
 * prove a weaker property and is flaky under load.
 */
describe('AddExternalIssueLinkRegressionCount1789600000000', () => {
    let dataSource: DataSource;
    const migration = new AddExternalIssueLinkRegressionCount1789600000000();

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
                name: 'external_issue_links',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'source', type: 'varchar', length: '100' },
                    { name: 'externalIssueId', type: 'varchar', length: '200' },
                    { name: 'externalKey', type: 'varchar', length: '100', isNullable: true },
                    { name: 'title', type: 'varchar', length: '500', isNullable: true },
                    { name: 'url', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'lastIngestedEventId', type: 'uuid', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO "external_issue_links" ("id", "userId", "taskId", "source", "externalIssueId", "externalKey") VALUES (?, ?, ?, ?, ?, ?)`,
            ['link-1', 'user-1', 'task-1', 'github', 'octo/site#42', 'octo/site#42'],
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

    async function physicalColumn(): Promise<
        { name: string; type: string; notnull: number; dflt_value: string | null } | undefined
    > {
        const rows: Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
        }> = await dataSource.query(`PRAGMA table_info("external_issue_links")`);
        return rows.find((row) => row.name === 'regressionCount');
    }

    it('adds a NOT NULL integer column defaulted to 0', async () => {
        await runUp();

        const column = await physicalColumn();
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(1);
        expect(String(column?.type).toLowerCase()).toContain('int');
        expect(String(column?.dflt_value)).toContain('0');
    });

    it('leaves links written before the migration reading 0, never NULL', async () => {
        await runUp();

        expect(
            await dataSource.query(
                `SELECT "id", "regressionCount" FROM "external_issue_links" WHERE "id" = ?`,
                ['link-1'],
            ),
        ).toEqual([{ id: 'link-1', regressionCount: 0 }]);
    });

    it('records a re-opening count once applied', async () => {
        await runUp();
        await dataSource.query(
            `UPDATE "external_issue_links" SET "regressionCount" = ? WHERE "id" = ?`,
            [2, 'link-1'],
        );

        expect(
            await dataSource.query(
                `SELECT "regressionCount" FROM "external_issue_links" WHERE "id" = ?`,
                ['link-1'],
            ),
        ).toEqual([{ regressionCount: 2 }]);
    });

    it('is idempotent on re-run and reversible through the query runner', async () => {
        await runUp();
        await runUp();
        expect(await physicalColumn()).toBeDefined();

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
        expect(await physicalColumn()).toBeUndefined();
        // The row survives the drop — down() removes a column, not history.
        expect(
            await dataSource.query(`SELECT "id" FROM "external_issue_links" WHERE "id" = ?`, [
                'link-1',
            ]),
        ).toEqual([{ id: 'link-1' }]);

        const second = dataSource.createQueryRunner();
        await migration.down(second);
        await second.release();
        expect(await physicalColumn()).toBeUndefined();
    });

    it('is a no-op when the table does not exist yet (ordering safety)', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('external_issue_links');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
