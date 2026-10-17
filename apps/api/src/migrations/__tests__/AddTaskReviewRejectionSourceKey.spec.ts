import { DataSource } from 'typeorm';
import { AddTaskReviewRejectionSourceKey1795162000000 } from '../1795162000000-AddTaskReviewRejectionSourceKey';

/**
 * Item 11 — `task_review_rejections.sourceKey` + the partial unique index that
 * makes a redelivered GitHub webhook a no-op. Asserted on the PHYSICAL schema
 * (better-sqlite3), including the behaviour the index exists for.
 */
describe('AddTaskReviewRejectionSourceKey1795162000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskReviewRejectionSourceKey1795162000000();

    const insert = (id: string, sourceKey: string | null) =>
        dataSource.query(
            `INSERT INTO "task_review_rejections" ("id", "taskId", "source", "feedback", "sourceKey") VALUES (?, 't1', 'pull-request', 'fix it', ?)`,
            [id, sourceKey],
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "task_review_rejections" (
                "id" varchar PRIMARY KEY NOT NULL,
                "taskId" varchar NOT NULL,
                "source" varchar(16) NOT NULL,
                "feedback" text NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "task_review_rejections" ("id", "taskId", "source", "feedback") VALUES ('old', 't1', 'gate', 'legacy')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable sourceKey and refuses a second row for the same Task + source', async () => {
        await migration.up(dataSource.createQueryRunner());

        const indexes = (await dataSource.query(
            `PRAGMA index_list("task_review_rejections")`,
        )) as Array<{
            name: string;
            unique: number;
        }>;
        expect(
            indexes.find((index) => index.name === 'uq_task_review_rejection_task_source')?.unique,
        ).toBe(1);

        await insert('a', 'issue_comment:42');
        await expect(insert('b', 'issue_comment:42')).rejects.toThrow(/UNIQUE/i);
        // Rows with no source never collide.
        await insert('c', null);
        await insert('d', null);
        await insert('e', 'review:42');
        expect(
            await dataSource.query(`SELECT COUNT(*) AS n FROM "task_review_rejections"`),
        ).toEqual([{ n: 5 }]);
    });

    it('is idempotent and reversible', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        const columns = (await dataSource.query(
            `PRAGMA table_info("task_review_rejections")`,
        )) as Array<{
            name: string;
        }>;
        expect(columns.some((column) => column.name === 'sourceKey')).toBe(false);
    });
});
