import { DataSource, Table } from 'typeorm';
import { AddEmailMessageAttachments1795061530000 } from '../1795061530000-AddEmailMessageAttachments';

/**
 * EW-P4-3 — `email_messages.attachments`. In-memory better-sqlite3 harness,
 * asserting the PHYSICAL schema through `PRAGMA`.
 */
describe('AddEmailMessageAttachments1795061530000', () => {
    let dataSource: DataSource;
    const migration = new AddEmailMessageAttachments1795061530000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: unknown }>
    > => dataSource.query(`PRAGMA table_info("email_messages")`);

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
                    { name: 'subject', type: 'varchar', length: '998' },
                ],
            }),
        );
        await runner.query(`INSERT INTO email_messages (id, "userId", subject) VALUES (?, ?, ?)`, [
            'm-1',
            'user-1',
            'Hello',
        ]);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function run(step: 'up' | 'down'): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration[step](runner);
        await runner.release();
    }

    it('adds a nullable, default-free attachments column; existing rows read NULL', async () => {
        await run('up');
        const column = (await columns()).find((c) => c.name === 'attachments');
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
        expect(await dataSource.query(`SELECT "attachments" FROM email_messages`)).toEqual([
            { attachments: null },
        ]);
    });

    it('stores a JSON list', async () => {
        await run('up');
        const list = [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 3, stored: true }];
        await dataSource.query(`UPDATE email_messages SET "attachments" = ? WHERE id = ?`, [
            JSON.stringify(list),
            'm-1',
        ]);
        const [row] = await dataSource.query(`SELECT "attachments" FROM email_messages`);
        expect(JSON.parse(row.attachments)).toEqual(list);
    });

    it('is idempotent and down() removes the column but keeps the rows', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        expect((await columns()).filter((c) => c.name === 'attachments')).toHaveLength(1);
        await run('down');
        expect((await columns()).map((c) => c.name)).not.toContain('attachments');
        expect(await dataSource.query(`SELECT id FROM email_messages`)).toEqual([{ id: 'm-1' }]);
    });
});
