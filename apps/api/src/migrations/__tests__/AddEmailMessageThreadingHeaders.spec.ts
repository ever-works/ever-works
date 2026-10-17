import { DataSource, Table } from 'typeorm';
import { AddEmailMessageThreadingHeaders1795061520000 } from '../1795061520000-AddEmailMessageThreadingHeaders';

/**
 * EW-P4-3 — RFC threading columns on `email_messages`.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting the PHYSICAL schema through `PRAGMA`.
 */
describe('AddEmailMessageThreadingHeaders1795061520000', () => {
    let dataSource: DataSource;
    const migration = new AddEmailMessageThreadingHeaders1795061520000();

    const physicalColumns = async (): Promise<
        Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("email_messages")`);
    const indexNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(`PRAGMA index_list("email_messages")`)) as Array<{
                name: string;
            }>
        ).map((index) => index.name);

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
                name: 'email_messages',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'direction', type: 'varchar', length: '16' },
                    { name: 'subject', type: 'varchar', length: '998' },
                    { name: 'providerMessageId', type: 'varchar', length: '200', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO email_messages (id, "userId", direction, subject, "providerMessageId") VALUES (?, ?, ?, ?, ?)`,
            ['m-1', 'user-1', 'inbound', 'Hello', 'pm-1'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function runDown(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    it('adds the three nullable, default-free threading columns and the lookup index', async () => {
        await runUp();
        const columns = await physicalColumns();
        for (const name of ['messageIdHeader', 'inReplyTo', 'references']) {
            const column = columns.find((candidate) => candidate.name === name);
            expect(column).toBeDefined();
            expect(column?.notnull).toBe(0);
            expect(column?.dflt_value).toBeNull();
        }
        expect(await indexNames()).toContain('idx_email_messages_user_message_id_header');
    });

    it('leaves existing rows untouched, with unknown (NULL) headers', async () => {
        await runUp();
        const rows = await dataSource.query(
            `SELECT "providerMessageId", "messageIdHeader", "inReplyTo", "references" FROM email_messages`,
        );
        expect(rows).toEqual([
            { providerMessageId: 'pm-1', messageIdHeader: null, inReplyTo: null, references: null },
        ]);
    });

    it('stores and reads back the reserved-word column `references`', async () => {
        await runUp();
        await dataSource.query(
            `UPDATE email_messages SET "messageIdHeader" = ?, "references" = ? WHERE id = ?`,
            ['a@x', JSON.stringify(['root@x', 'a@x']), 'm-1'],
        );
        const [row] = await dataSource.query(
            `SELECT "references" FROM email_messages WHERE "userId" = ? AND "messageIdHeader" = ?`,
            ['user-1', 'a@x'],
        );
        expect(JSON.parse(row.references)).toEqual(['root@x', 'a@x']);
    });

    it('is idempotent: a second up() converges instead of throwing', async () => {
        await runUp();
        await expect(runUp()).resolves.toBeUndefined();
        const names = (await physicalColumns()).map((column) => column.name);
        expect(names.filter((name) => name === 'messageIdHeader')).toHaveLength(1);
        expect(names.filter((name) => name === 'references')).toHaveLength(1);
    });

    it('down() removes the columns and the index and keeps the rows', async () => {
        await runUp();
        await runDown();
        const names = (await physicalColumns()).map((column) => column.name);
        expect(names).not.toContain('messageIdHeader');
        expect(names).not.toContain('inReplyTo');
        expect(names).not.toContain('references');
        expect(await indexNames()).not.toContain('idx_email_messages_user_message_id_header');
        const rows = await dataSource.query(`SELECT id, "providerMessageId" FROM email_messages`);
        expect(rows).toEqual([{ id: 'm-1', providerMessageId: 'pm-1' }]);
    });

    it('is a no-op when the table does not exist', async () => {
        await dataSource.query(`DROP TABLE email_messages`);
        await expect(runUp()).resolves.toBeUndefined();
        await expect(runDown()).resolves.toBeUndefined();
    });
});
