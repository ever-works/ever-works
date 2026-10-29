import { DataSource, Table } from 'typeorm';
import { AddTaskDeliveryState1792080000000 } from '../1792080000000-AddTaskDeliveryState';

/**
 * APW-08 T9 — the delivery columns on `tasks` (plan §3.1, §3.5 slot `00`).
 *
 * In-memory better-sqlite3, asserting against the PHYSICAL schema (`PRAGMA table_info`,
 * `PRAGMA index_list`, `sqlite_master`) — a unique index created as an ordinary one, or a
 * partial one created without its predicate, would pass an insert-shaped test and still let a
 * merge be recorded twice.
 */
describe('AddTaskDeliveryState1792080000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskDeliveryState1792080000000();
    const ADDED = [
        'deliveryBuildId',
        'deliveryClosedById',
        'deliveryDeploymentId',
        'deliveryState',
        'deliveryUpdatedAt',
        'followUpKey',
        'mergeCommitSha',
    ];

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
                name: 'tasks',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'title', type: 'varchar', length: '500' },
                    { name: 'prNumber', type: 'int', isNullable: true },
                    { name: 'prState', type: 'varchar', length: '16', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO tasks (id, "userId", "workId", title, "prNumber", "prState") VALUES (?, ?, ?, ?, ?, ?)`,
            ['task-1', 'user-1', 'work-1', 'Fix the booking form', 7, 'merged'],
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

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info("tasks")`);
        return rows.map((row) => row.name).sort();
    }

    async function indexSql(name: string): Promise<string | null> {
        const rows: Array<{ sql: string | null }> = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
            [name],
        );
        return rows[0]?.sql ?? null;
    }

    it('adds the seven nullable delivery columns', async () => {
        await run('up');
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("tasks")`,
        );
        const added = rows.filter((row) => ADDED.includes(row.name));
        expect(added.map((row) => row.name).sort()).toEqual(ADDED);
        for (const row of added) expect(row.notnull).toBe(0);
    });

    it('leaves every existing Task untracked (deliveryState NULL) and every existing column intact', async () => {
        const before = await columnNames();
        await run('up');
        const after = await columnNames();
        expect(after).toEqual([...before, ...ADDED].sort());
        const [task] = await dataSource.query(`SELECT * FROM tasks WHERE id = 'task-1'`);
        expect(task.deliveryState).toBeNull();
        expect(task.mergeCommitSha).toBeNull();
        expect(task.followUpKey).toBeNull();
        expect(task.title).toBe('Fix the booking form');
        expect(task.prState).toBe('merged');
    });

    it('creates the due index, the PARTIAL unique merge index and the unique follow-up key', async () => {
        await run('up');
        expect(await indexSql('idx_tasks_delivery_due')).toMatch(
            /\("deliveryState", "deliveryUpdatedAt"\)/,
        );
        const merge = await indexSql('uq_tasks_work_merge_commit');
        expect(merge).toMatch(/CREATE UNIQUE INDEX/);
        expect(merge).toMatch(/\("workId", "mergeCommitSha"\)/);
        expect(merge).toMatch(/WHERE "mergeCommitSha" IS NOT NULL/);
        expect(await indexSql('uq_tasks_follow_up_key')).toMatch(/CREATE UNIQUE INDEX/);
    });

    it('makes "a merge is recorded once" a database guarantee (S29)', async () => {
        await run('up');
        await dataSource.query(
            `UPDATE tasks SET "mergeCommitSha" = 'abc', "deliveryState" = 'merged' WHERE id = 'task-1'`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO tasks (id, "userId", "workId", title, "mergeCommitSha") VALUES ('task-2', 'user-1', 'work-1', 'Twin', 'abc')`,
            ),
        ).rejects.toThrow(/UNIQUE/);
        // Untracked Tasks (NULL merge commit) never collide.
        await dataSource.query(
            `INSERT INTO tasks (id, "userId", "workId", title) VALUES ('task-3', 'user-1', 'work-1', 'Other')`,
        );
        await dataSource.query(
            `INSERT INTO tasks (id, "userId", "workId", title) VALUES ('task-4', 'user-1', 'work-1', 'Another')`,
        );
    });

    it('accepts the full 82-character follow-up key and refuses a duplicate (APW08-G23)', async () => {
        await run('up');
        const key = `followup:${'a'.repeat(36)}:${'b'.repeat(36)}`;
        expect(key).toHaveLength(82);
        await dataSource.query(`UPDATE tasks SET "followUpKey" = ? WHERE id = 'task-1'`, [key]);
        await expect(
            dataSource.query(
                `INSERT INTO tasks (id, "userId", title, "followUpKey") VALUES ('task-2', 'user-1', 'Twin', ?)`,
                [key],
            ),
        ).rejects.toThrow(/UNIQUE/);
    });

    it('is a no-op when run twice', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        expect((await columnNames()).filter((name) => ADDED.includes(name))).toHaveLength(7);
    });

    it('down() removes exactly the seven columns and three indexes', async () => {
        const before = await columnNames();
        await run('up');
        await run('down');
        expect(await columnNames()).toEqual(before);
        for (const name of [
            'idx_tasks_delivery_due',
            'uq_tasks_work_merge_commit',
            'uq_tasks_follow_up_key',
        ]) {
            expect(await indexSql(name)).toBeNull();
        }
        const [task] = await dataSource.query(`SELECT * FROM tasks WHERE id = 'task-1'`);
        expect(task.title).toBe('Fix the booking form');
    });

    it('down() is safe where up() never ran, and both skip a missing table', async () => {
        await expect(run('down')).resolves.toBeUndefined();
        await dataSource.query(`DROP TABLE tasks`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
