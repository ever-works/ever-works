import { DataSource, Table } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { TaskAgentReview, TaskApprover } from '@ever-works/agent/entities';
import { AddTaskAgentReviews1790300000000 } from '../1790300000000-AddTaskAgentReviews';

/**
 * Reviewer agent stage (slice AD, EW-811) — schema.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * Assertions are against the PHYSICAL schema (`PRAGMA table_info`,
 * `PRAGMA index_list`) rather than against a query that happens to
 * succeed: a column that exists under a different name, or a unique index
 * created as an ordinary one, would pass an insert-shaped test and still
 * let a Task that re-enters review buy a second model run.
 */
describe('AddTaskAgentReviews1790300000000', () => {
    let dataSource: DataSource;
    const migration = new AddTaskAgentReviews1790300000000();

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
                name: 'task_approvers',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'approverType', type: 'varchar', length: '8' },
                    { name: 'approverId', type: 'uuid' },
                    {
                        name: 'approvalState',
                        type: 'varchar',
                        length: '16',
                        default: "'pending'",
                    },
                    { name: 'approvedAt', type: 'timestamp', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO task_approvers (id, "taskId", "approverType", "approverId", "approvalState") VALUES (?, ?, ?, ?, ?)`,
            ['app-1', 'task-1', 'agent', 'agent-1', 'pending'],
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

    /**
     * The ENTITY's own column metadata — not a list typed into this file.
     *
     * The check below used to compare the migration against a hand-written
     * list of names, so an entity column added (or re-typed, or made
     * nullable) without touching the migration still passed here, still
     * passed the wiring spec (which builds its schema with `synchronize`),
     * and failed only on production Postgres, which runs migrations and
     * nothing else. Metadata is built from the real `ENTITIES` inventory
     * the API boots with; nothing is synchronised.
     */
    async function entityColumns(
        target: Function,
    ): Promise<Array<{ name: string; nullable: boolean; length: string }>> {
        const metadataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: false,
        });
        await metadataSource.initialize();
        try {
            return metadataSource.getMetadata(target).columns.map((column) => ({
                name: column.databaseName,
                nullable: column.isNullable,
                length: String(column.length ?? ''),
            }));
        } finally {
            await metadataSource.destroy();
        }
    }

    /** `PRAGMA table_info` with the declared type, for length checks. */
    async function physical(
        table: string,
    ): Promise<Record<string, { notnull: number; type: string }>> {
        const rows: Array<{ name: string; notnull: number; type: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return Object.fromEntries(
            rows.map((row) => [row.name, { notnull: row.notnull, type: row.type }]),
        );
    }

    it('creates EXACTLY the columns the TaskAgentReview entity declares — names, nullability, lengths', async () => {
        await runUp();
        const table = await physical('task_agent_reviews');
        const declared = await entityColumns(TaskAgentReview);

        expect(Object.keys(table).sort()).toEqual(declared.map((column) => column.name).sort());
        for (const column of declared) {
            // `notnull` is 1 for NOT NULL; a nullable entity column must be
            // nullable in the database and vice versa.
            expect({ column: column.name, notnull: table[column.name].notnull }).toEqual({
                column: column.name,
                notnull: column.nullable ? 0 : 1,
            });
            if (column.length) {
                expect({ column: column.name, type: table[column.name].type }).toEqual({
                    column: column.name,
                    type: expect.stringContaining(`(${column.length})`),
                });
            }
        }
    });

    it('adds to task_approvers only columns the TaskApprover entity declares, with matching shape', async () => {
        const before = new Set(Object.keys(await physical('task_approvers')));
        await runUp();
        const after = await physical('task_approvers');
        const declared = new Map(
            (await entityColumns(TaskApprover)).map((column) => [column.name, column]),
        );
        const added = Object.keys(after).filter((name) => !before.has(name));

        expect(added.length).toBeGreaterThan(0);
        for (const name of added) {
            const column = declared.get(name);
            expect({ name, declared: Boolean(column) }).toEqual({ name, declared: true });
            expect({ name, notnull: after[name].notnull }).toEqual({
                name,
                notnull: column!.nullable ? 0 : 1,
            });
            if (column!.length) {
                expect(after[name].type).toContain(`(${column!.length})`);
            }
        }
    });

    it('creates the review ledger with every column the entity declares', async () => {
        await runUp();
        const ledger = await columns('task_agent_reviews');
        expect(Object.keys(ledger).sort()).toEqual(
            [
                'approverId',
                'ciState',
                'claimKey',
                'createdAt',
                'decidedAt',
                'headSha',
                'id',
                'organizationId',
                'prNumber',
                'refusalCode',
                'reviewerAgentId',
                'runId',
                'state',
                'summary',
                'taskId',
                'tenantId',
                'workId',
            ].sort(),
        );
        // The five that carry the decision are NOT NULL. `headSha` is one
        // of them on purpose: a review that is not about a commit cannot
        // be checked for staleness later.
        expect(ledger.taskId.notnull).toBe(1);
        expect(ledger.reviewerAgentId.notnull).toBe(1);
        expect(ledger.approverId.notnull).toBe(1);
        expect(ledger.claimKey.notnull).toBe(1);
        expect(ledger.headSha.notnull).toBe(1);
        // Everything a dispatch might not know yet is nullable.
        expect(ledger.runId.notnull).toBe(0);
        expect(ledger.summary.notnull).toBe(0);
        expect(ledger.decidedAt.notnull).toBe(0);
    });

    it('makes (taskId, claimKey) UNIQUE — the guard against a review storm', async () => {
        await runUp();
        const indices: Array<{ name: string; unique: number }> = await dataSource.query(
            `PRAGMA index_list("task_agent_reviews")`,
        );
        const claim = indices.find((index) => index.name === 'uq_task_agent_review_claim');
        expect(claim).toBeDefined();
        expect(claim?.unique).toBe(1);
        const claimColumns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("uq_task_agent_review_claim")`,
        );
        expect(claimColumns.map((column) => column.name)).toEqual(['taskId', 'claimKey']);

        expect(indices.some((index) => index.name === 'idx_task_agent_review_task')).toBe(true);
        // The run-binding lookup the verdict path authorizes on.
        const run = indices.find((index) => index.name === 'idx_task_agent_review_run');
        expect(run).toBeDefined();
        expect(run?.unique).toBe(0);
        const runColumns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("idx_task_agent_review_run")`,
        );
        expect(runColumns.map((column) => column.name)).toEqual(['runId']);
        const reviewer = indices.find((index) => index.name === 'idx_task_agent_review_reviewer');
        expect(reviewer).toBeDefined();
        // Non-unique on purpose: one reviewer legitimately reviews the
        // same Task again on a NEW commit.
        expect(reviewer?.unique).toBe(0);
    });

    it('enforces that uniqueness at the database, and scopes it to ONE Task', async () => {
        await runUp();
        const insert = (taskId: string, claimKey: string) =>
            dataSource.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha") VALUES (?, ?, ?, ?, ?, ?)`,
                [`${taskId}-${claimKey}`, taskId, 'agent-1', 'app-1', claimKey, 'abc123'],
            );

        await insert('task-1', 'agent-review:agent-1:abc123');
        await expect(insert('task-1', 'agent-review:agent-1:abc123')).rejects.toThrow();
        // A different Task, and a different head, both go through.
        await expect(insert('task-2', 'agent-review:agent-1:abc123')).resolves.toBeDefined();
        await expect(insert('task-1', 'agent-review:agent-1:def456')).resolves.toBeDefined();
    });

    it('defaults a fresh review row to `dispatched`', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha") VALUES (?, ?, ?, ?, ?, ?)`,
            ['r1', 'task-1', 'agent-1', 'app-1', 'agent-review:agent-1:abc', 'abc'],
        );
        const rows = await dataSource.query(`SELECT state FROM task_agent_reviews WHERE id = ?`, [
            'r1',
        ]);
        expect(rows[0].state).toBe('dispatched');
    });

    it('adds the three approver provenance columns, all nullable, preserving existing rows', async () => {
        await runUp();
        const approvers = await columns('task_approvers');
        expect(approvers.decidedVia).toBeDefined();
        expect(approvers.decidedByRunId).toBeDefined();
        expect(approvers.decidedHeadSha).toBeDefined();
        expect(approvers.decidedVia.notnull).toBe(0);
        expect(approvers.decidedByRunId.notnull).toBe(0);
        expect(approvers.decidedHeadSha.notnull).toBe(0);

        // The pre-existing row survives, with NULL provenance — which is
        // exactly right: nobody decided it.
        const rows = await dataSource.query(
            `SELECT "approvalState", "decidedVia" FROM task_approvers WHERE id = ?`,
            ['app-1'],
        );
        expect(rows[0]).toEqual({ approvalState: 'pending', decidedVia: null });
    });

    it('is idempotent — a partially applied database converges', async () => {
        await runUp();
        await expect(runUp()).resolves.toBeUndefined();
        expect(Object.keys(await columns('task_agent_reviews'))).toHaveLength(17);
        expect(Object.keys(await columns('task_approvers'))).toHaveLength(9);
    });

    it('down() removes both halves through the query-runner primitives', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_agent_reviews'`,
        );
        expect(tables).toHaveLength(0);
        const approvers = await columns('task_approvers');
        expect(approvers.decidedVia).toBeUndefined();
        expect(approvers.decidedByRunId).toBeUndefined();
        expect(approvers.decidedHeadSha).toBeUndefined();
        // …and the original columns are untouched. sqlite rebuilds the
        // table on a column drop, so this is not free.
        expect(Object.keys(approvers).sort()).toEqual(
            ['approvalState', 'approvedAt', 'approverId', 'approverType', 'id', 'taskId'].sort(),
        );
    });
});
