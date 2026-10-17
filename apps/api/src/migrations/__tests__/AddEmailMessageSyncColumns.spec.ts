import { DataSource } from 'typeorm';
import { AddEmailMessageSyncColumns1795130300000 } from '../1795130300000-AddEmailMessageSyncColumns';

/**
 * EW-P4-2 — `email_messages.updatedAt` (backfilled from `createdAt`),
 * `version` and the keyset index, on in-memory better-sqlite3 (the PHYSICAL
 * schema through `PRAGMA`): idempotent, `down` drops exactly what `up` added,
 * and a missing table is skipped.
 */
describe('AddEmailMessageSyncColumns1795130300000', () => {
    let dataSource: DataSource;
    const migration = new AddEmailMessageSyncColumns1795130300000();

    const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("email_messages")`);
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("email_messages")`)) as Array<{
                name: string;
            }>
        ).map((row) => row.name);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "email_messages" ("id" varchar PRIMARY KEY, "organizationId" varchar, "subject" varchar, "createdAt" datetime NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "email_messages" ("id", "organizationId", "subject", "createdAt") VALUES ('m-1', 'org-1', 'Hello', '2026-10-01 08:00:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds updatedAt (existing rows = their createdAt), version 1 and the keyset index, idempotently', async () => {
        await run('up');
        await run('up');
        const names = (await columns()).map((column) => column.name);
        expect(names.filter((name) => name === 'updatedAt')).toHaveLength(1);
        expect(names.filter((name) => name === 'version')).toHaveLength(1);
        expect(await dataSource.query(`SELECT "updatedAt", version FROM "email_messages"`)).toEqual(
            [{ updatedAt: '2026-10-01 08:00:00', version: 1 }],
        );
        expect(await indexNames()).toContain('idx_email_messages_org_updated');
    });

    it('down() drops the columns and the index and keeps the rows', async () => {
        await run('up');
        await run('down');
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('updatedAt');
        expect(names).not.toContain('version');
        expect(await indexNames()).not.toContain('idx_email_messages_org_updated');
        expect(await dataSource.query(`SELECT id FROM "email_messages"`)).toEqual([{ id: 'm-1' }]);
    });

    it('is a no-op without the table', async () => {
        await dataSource.query(`DROP TABLE "email_messages"`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
