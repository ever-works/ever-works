import { DataSource } from 'typeorm';
import { CreateExternalIdentities1792120000000 } from '../1792120000000-CreateExternalIdentities';

/**
 * APW-12 (Ever ID) — `1792120000000-CreateExternalIdentities` against an
 * in-memory better-sqlite3 DataSource (the sibling migration specs' harness).
 *
 * Plan §3.1/§3.6: the table, the two named unique constraints that ARE the
 * linking rules, the user index, the cascading foreign key; `down()` drops
 * exactly what `up()` created; both directions are idempotent.
 */
describe('CreateExternalIdentities1792120000000', () => {
    let dataSource: DataSource;
    const migration = new CreateExternalIdentities1792120000000();

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
        await dataSource.query('PRAGMA foreign_keys = ON');
        await dataSource.query('CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)');
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
    });
    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const insert = (id: string, userId: string, issuer: string, subject: string) =>
        dataSource.query(
            `INSERT INTO "external_identities" ("id", "userId", "issuer", "subject", "emailAtLink", "emailVerifiedAtLink", "linkedVia", "linkedAt")
             VALUES (?, ?, ?, ?, 'p@example.com', 1, 'settings', CURRENT_TIMESTAMP)`,
            [id, userId, issuer, subject],
        );

    it('creates the table with the FR-31 columns and no token column', async () => {
        await run('up');

        const columns: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("external_identities")`,
        );
        expect(columns.map((column) => column.name).sort()).toEqual(
            [
                'createdAt',
                'delegatedClients',
                'emailAtLink',
                'emailVerifiedAtLink',
                'id',
                'issuer',
                'lastLoginAt',
                'linkedAt',
                'linkedVia',
                'subject',
                'tenantId',
                'updatedAt',
                'userId',
            ].sort(),
        );
        const nullable = Object.fromEntries(
            columns.map((column) => [column.name, column.notnull === 0]),
        );
        expect(nullable).toMatchObject({
            lastLoginAt: true,
            delegatedClients: true,
            tenantId: true,
            issuer: false,
        });
    });

    it('enforces one account per pair and one pair per account per issuer', async () => {
        await run('up');
        await insert('a', 'u1', 'https://id.example.test', 's1');

        await expect(insert('b', 'u2', 'https://id.example.test', 's1')).rejects.toThrow();
        await expect(insert('c', 'u1', 'https://id.example.test', 's2')).rejects.toThrow();
        await expect(insert('d', 'u1', 'https://other.example.test', 's2')).resolves.toBeDefined();
    });

    it('cascades the delete of the account', async () => {
        await run('up');
        await insert('a', 'u1', 'https://id.example.test', 's1');

        await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u1'`);

        expect(await dataSource.query(`SELECT * FROM "external_identities"`)).toEqual([]);
    });

    it('is idempotent and its down drops exactly the table', async () => {
        await run('up');
        await run('up');
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'external_identities'`,
        );
        expect(indexes.map((index) => index.name)).toContain('idx_external_identities_user');

        await run('down');
        await run('down');
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        );
        expect(tables.map((table) => table.name)).toEqual(['users']);
    });
});
