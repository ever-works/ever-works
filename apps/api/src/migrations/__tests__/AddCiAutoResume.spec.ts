import { DataSource, Table } from 'typeorm';
import { AddCiAutoResume1789800000000 } from '../1789800000000-AddCiAutoResume';

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — schema.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * Assertions are against the PHYSICAL schema (`PRAGMA table_info`,
 * `PRAGMA index_list`) rather than against a query that happens to
 * succeed: a column that exists under a different name, or a unique
 * index created as an ordinary one, would pass an insert-shaped test and
 * still let a redelivered check event buy a second model run.
 */
describe('AddCiAutoResume1789800000000', () => {
    let dataSource: DataSource;
    const migration = new AddCiAutoResume1789800000000();

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
                    { name: 'title', type: 'varchar', length: '500' },
                    { name: 'prNumber', type: 'int', isNullable: true },
                    { name: 'ciState', type: 'varchar', length: '16', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO tasks (id, "userId", title, "prNumber", "ciState") VALUES (?, ?, ?, ?, ?)`,
            ['task-1', 'user-1', 'Add the login button', 42, 'failing'],
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

    /** The physical column list, straight from sqlite. */
    async function columns(table: string): Promise<Record<string, { notnull: number }>> {
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return Object.fromEntries(rows.map((row) => [row.name, { notnull: row.notnull }]));
    }

    it('creates the attempt ledger with every column the entity declares', async () => {
        await runUp();
        const ledger = await columns('task_ci_auto_resume_attempts');
        expect(Object.keys(ledger).sort()).toEqual(
            [
                'claimKey',
                'createdAt',
                'detail',
                'failureKey',
                'headSha',
                'id',
                'organizationId',
                'resumedRunId',
                'sourceRunId',
                'taskId',
                'tenantId',
                'trigger',
                'workId',
            ].sort(),
        );
        // The three that carry the decision are NOT NULL; everything a
        // delivery might not know is nullable.
        expect(ledger.taskId.notnull).toBe(1);
        expect(ledger.trigger.notnull).toBe(1);
        expect(ledger.claimKey.notnull).toBe(1);
        expect(ledger.headSha.notnull).toBe(0);
        expect(ledger.failureKey.notnull).toBe(0);
        expect(ledger.resumedRunId.notnull).toBe(0);
    });

    it('makes (taskId, claimKey) UNIQUE — the guard against a resume storm', async () => {
        await runUp();
        const indices: Array<{ name: string; unique: number }> = await dataSource.query(
            `PRAGMA index_list("task_ci_auto_resume_attempts")`,
        );
        const claim = indices.find((index) => index.name === 'uq_task_ci_auto_resume_claim');
        expect(claim).toBeDefined();
        expect(claim?.unique).toBe(1);
        const claimColumns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("uq_task_ci_auto_resume_claim")`,
        );
        expect(claimColumns.map((column) => column.name)).toEqual(['taskId', 'claimKey']);

        expect(indices.some((index) => index.name === 'idx_task_ci_auto_resume_task')).toBe(true);
    });

    it('enforces that uniqueness at the database, and scopes it to ONE Task', async () => {
        await runUp();
        const insert = (taskId: string, claimKey: string) =>
            dataSource.query(
                `INSERT INTO task_ci_auto_resume_attempts (id, "taskId", trigger, "claimKey") VALUES (?, ?, ?, ?)`,
                [`${taskId}-${claimKey}`, taskId, 'ci', claimKey],
            );

        await insert('task-1', 'ci:abc123');
        await expect(
            dataSource.query(
                `INSERT INTO task_ci_auto_resume_attempts (id, "taskId", trigger, "claimKey") VALUES (?, ?, ?, ?)`,
                ['second', 'task-1', 'ci', 'ci:abc123'],
            ),
        ).rejects.toThrow(/UNIQUE/i);

        // A different head, and another Task's identical head, are both fine.
        await expect(insert('task-1', 'ci:def456')).resolves.toBeDefined();
        await expect(insert('task-2', 'ci:abc123')).resolves.toBeDefined();
    });

    it('adds the three Task columns as nullable and leaves existing rows untouched', async () => {
        await runUp();
        const tasks = await columns('tasks');
        for (const column of ['ciHeadSha', 'ciHeadSeenAt', 'ciAutoResumeNoticedAt']) {
            expect(tasks[column]).toBeDefined();
            expect(tasks[column].notnull).toBe(0);
        }
        expect(
            await dataSource.query(
                `SELECT "ciState", "ciHeadSha", "ciHeadSeenAt", "ciAutoResumeNoticedAt" FROM tasks WHERE id = ?`,
                ['task-1'],
            ),
        ).toEqual([
            {
                ciState: 'failing',
                ciHeadSha: null,
                ciHeadSeenAt: null,
                ciAutoResumeNoticedAt: null,
            },
        ]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        expect(Object.keys(await columns('tasks'))).toContain('ciHeadSha');

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        const after = await columns('tasks');
        for (const column of ['ciHeadSha', 'ciHeadSeenAt', 'ciAutoResumeNoticedAt']) {
            expect(after[column]).toBeUndefined();
        }
        expect(Object.keys(await columns('task_ci_auto_resume_attempts'))).toHaveLength(0);

        // …and a second down() is a no-op, not a crash.
        const again = dataSource.createQueryRunner();
        await expect(migration.down(again)).resolves.toBeUndefined();
        await again.release();
    });

    it('is a no-op when `tasks` does not exist yet (ordering safety)', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('tasks');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();
        // The ledger is still created — it has no dependency on `tasks`.
        expect(Object.keys(await columns('task_ci_auto_resume_attempts')).length).toBeGreaterThan(
            0,
        );
    });
});
