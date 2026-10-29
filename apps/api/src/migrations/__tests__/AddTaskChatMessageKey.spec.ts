import { DataSource, Table, TableIndex } from 'typeorm';
import { AddTaskChatMessageKey1792330000000 } from '../1792330000000-AddTaskChatMessageKey';

/**
 * APW-08 T54 — keyed Task-thread posts on `task_chat_messages` (plan §3.5 slot `03`).
 *
 * In-memory better-sqlite3, asserting against the PHYSICAL schema (`PRAGMA table_info`,
 * `sqlite_master`): SQLite recreates the table to widen `authorId`, which is exactly the step that
 * could lose a row, an index or a value if it went wrong.
 */
describe('AddTaskChatMessageKey1792330000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskChatMessageKey1792330000000();
    const ADDED = ['messageKey', 'messageParams'];

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
                name: 'task_chat_messages',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'authorType', type: 'varchar', length: '16' },
                    { name: 'authorId', type: 'uuid' },
                    { name: 'body', type: 'text' },
                    { name: 'createdAt', type: 'datetime', default: "datetime('now')" },
                ],
            }),
        );
        await runner.createIndex(
            'task_chat_messages',
            new TableIndex({ name: 'idx_task_chat_author', columnNames: ['authorType', 'authorId'] }),
        );
        for (const [id, type, author, body] of [
            ['m-1', 'user', 'user-1', 'Please add an SMS reminder.'],
            ['m-2', 'agent', 'agent-1', 'Opened pull request #7.'],
            ['m-3', 'integration', 'key-1', 'Synced from Slack.'],
        ]) {
            await runner.query(
                `INSERT INTO task_chat_messages (id, "taskId", "authorType", "authorId", body) VALUES (?, 'task-1', ?, ?, ?)`,
                [id, type, author, body],
            );
        }
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

    async function columns(): Promise<Array<{ name: string; notnull: number; type: string }>> {
        return dataSource.query(`PRAGMA table_info("task_chat_messages")`);
    }

    async function authors(): Promise<Array<{ id: string; authorType: string; authorId: string | null }>> {
        return dataSource.query(
            `SELECT id, "authorType", "authorId" FROM task_chat_messages ORDER BY id`,
        );
    }

    it('adds the two nullable key columns', async () => {
        await run('up');
        const added = (await columns()).filter((column) => ADDED.includes(column.name));
        expect(added.map((column) => column.name).sort()).toEqual(ADDED);
        for (const column of added) expect(column.notnull).toBe(0);
        expect(added.find((column) => column.name === 'messageKey')?.type).toMatch(/varchar\(64\)/i);
    });

    it('widens authorId to nullable and every existing row keeps its authorId', async () => {
        const before = await authors();
        expect((await columns()).find((column) => column.name === 'authorId')?.notnull).toBe(1);

        await run('up');

        expect((await columns()).find((column) => column.name === 'authorId')?.notnull).toBe(0);
        expect(await authors()).toEqual(before);
        const [row] = await dataSource.query(`SELECT * FROM task_chat_messages WHERE id = 'm-2'`);
        expect(row).toMatchObject({ body: 'Opened pull request #7.', messageKey: null, messageParams: null });
    });

    it('accepts a system post with no author, a key and its params', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO task_chat_messages (id, "taskId", "authorType", "authorId", body, "messageKey", "messageParams") VALUES ('m-4', 'task-1', 'system', NULL, 'Live at https://bookings.example.app.', 'deliveryPosts.live', ?)`,
            [JSON.stringify({ url: 'https://bookings.example.app' })],
        );
        const [row] = await dataSource.query(`SELECT * FROM task_chat_messages WHERE id = 'm-4'`);
        expect(row).toMatchObject({ authorType: 'system', authorId: null, messageKey: 'deliveryPosts.live' });
        expect(JSON.parse(row.messageParams)).toEqual({ url: 'https://bookings.example.app' });
    });

    it('keeps the author index through the table rebuild', async () => {
        await run('up');
        const [index] = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_chat_author'`,
        );
        expect(index?.sql).toMatch(/\("authorType", "authorId"\)/);
    });

    it('is a no-op when run twice', async () => {
        await run('up');
        const once = await columns();
        await expect(run('up')).resolves.toBeUndefined();
        expect(await columns()).toEqual(once);
        expect((await authors()).map((row) => row.authorId)).toEqual(['user-1', 'agent-1', 'key-1']);
    });

    it('down() drops only the two added columns: authorId stays nullable, rows and authors stay', async () => {
        const before = (await columns()).map((column) => column.name).sort();
        await run('up');
        await dataSource.query(
            `INSERT INTO task_chat_messages (id, "taskId", "authorType", "authorId", body, "messageKey") VALUES ('m-4', 'task-1', 'system', NULL, 'Deploying.', 'deliveryPosts.deploying')`,
        );

        await run('down');

        expect((await columns()).map((column) => column.name).sort()).toEqual(before);
        expect((await columns()).find((column) => column.name === 'authorId')?.notnull).toBe(0);
        expect(await authors()).toEqual([
            { id: 'm-1', authorType: 'user', authorId: 'user-1' },
            { id: 'm-2', authorType: 'agent', authorId: 'agent-1' },
            { id: 'm-3', authorType: 'integration', authorId: 'key-1' },
            { id: 'm-4', authorType: 'system', authorId: null },
        ]);
        // And down() twice is a no-op too.
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('does nothing when the table does not exist yet', async () => {
        await dataSource.query(`DROP TABLE task_chat_messages`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
