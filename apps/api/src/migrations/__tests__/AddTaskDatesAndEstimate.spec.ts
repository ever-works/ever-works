import { DataSource } from 'typeorm';
import { AddTaskDatesAndEstimate1795110000000 } from '../1795110000000-AddTaskDatesAndEstimate';

/**
 * EW-P2-3 — `tasks.dueAt`, `startAt`, `estimateMinutes`, `dueSoonNotifiedAt`
 * and `idx_tasks_due_soon`, on the in-memory better-sqlite3 harness the
 * sibling migration specs use. The per-driver timestamp spelling is pinned
 * separately.
 */
describe('AddTaskDatesAndEstimate1795110000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskDatesAndEstimate1795110000000();
    const NEW = ['dueAt', 'startAt', 'estimateMinutes', 'dueSoonNotifiedAt'];

    const columns = async (): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA table_info("tasks")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexes = async (): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("tasks")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
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
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY, "title" varchar(200) NOT NULL, "status" varchar(16) NOT NULL DEFAULT 'backlog')`,
        );
        await dataSource.query(`INSERT INTO "tasks" ("id","title") VALUES ('t1','Existing')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the four nullable columns and the due-soon index; existing rows read NULL', async () => {
        await run('up');
        expect(await columns()).toEqual(expect.arrayContaining(NEW));
        expect(await indexes()).toContain('idx_tasks_due_soon');
        const [row] = await dataSource.query(
            `SELECT "dueAt","startAt","estimateMinutes","dueSoonNotifiedAt" FROM "tasks" WHERE "id"='t1'`,
        );
        expect(row).toEqual({
            dueAt: null,
            startAt: null,
            estimateMinutes: null,
            dueSoonNotifiedAt: null,
        });
    });

    it('is idempotent and down() removes exactly what up() added', async () => {
        await run('up');
        await run('up');
        await run('down');
        await run('down');
        const cols = await columns();
        for (const name of NEW) expect(cols).not.toContain(name);
        expect(cols).toEqual(expect.arrayContaining(['id', 'title', 'status']));
        expect(await indexes()).not.toContain('idx_tasks_due_soon');
    });

    it('spells timestamps the way TypeORM maps Date per driver', () => {
        expect(AddTaskDatesAndEstimate1795110000000.dateType('postgres')).toBe('timestamp');
        expect(AddTaskDatesAndEstimate1795110000000.dateType('mysql')).toBe('datetime');
        expect(AddTaskDatesAndEstimate1795110000000.dateType('better-sqlite3')).toBe('datetime');
    });
});
