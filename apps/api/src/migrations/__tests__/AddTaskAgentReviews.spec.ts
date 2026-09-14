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
                // Greptile P1-C on PR #2419: the lifetime budget slot.
                'slot',
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
        // …and so is the budget slot: a review holding no slot would be a
        // run the budget constraint cannot see (a NULL never collides in a
        // unique index, on either engine).
        expect(ledger.slot.notnull).toBe(1);
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
        // `slot` is NOT NULL since Greptile P1-C, so every insert names one.
        // Each insert below takes a slot of its own, so the only constraint
        // that can refuse the duplicate is the CLAIM index under test.
        const insert = (taskId: string, claimKey: string, slot: number) =>
            dataSource.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha", "slot") VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    `${taskId}-${claimKey}-${slot}`,
                    taskId,
                    'agent-1',
                    'app-1',
                    claimKey,
                    'abc123',
                    slot,
                ],
            );

        await insert('task-1', 'agent-review:agent-1:abc123', 0);
        await expect(insert('task-1', 'agent-review:agent-1:abc123', 1)).rejects.toThrow(/UNIQUE/);
        // A different Task, and a different head, both go through.
        await expect(insert('task-2', 'agent-review:agent-1:abc123', 0)).resolves.toBeDefined();
        await expect(insert('task-1', 'agent-review:agent-1:def456', 2)).resolves.toBeDefined();
    });

    it('makes (taskId, slot) UNIQUE — the lifetime budget is a database constraint (Greptile P1-C)', async () => {
        await runUp();
        const indices: Array<{ name: string; unique: number }> = await dataSource.query(
            `PRAGMA index_list("task_agent_reviews")`,
        );
        const slot = indices.find((index) => index.name === 'uq_task_agent_review_slot');
        expect(slot).toBeDefined();
        expect(slot?.unique).toBe(1);
        const slotColumns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("uq_task_agent_review_slot")`,
        );
        expect(slotColumns.map((column) => column.name)).toEqual(['taskId', 'slot']);

        // Enforced, not decorative: two DISTINCT claims (different reviewer,
        // different head — nothing the claim index can see as the same)
        // cannot both take slot 0 of one Task. That is the race Greptile
        // executed. Another Task's slot 0, and this Task's slot 1, are free.
        const insert = (id: string, taskId: string, claimKey: string, slot: number) =>
            dataSource.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha", "slot") VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [id, taskId, 'agent-1', 'app-1', claimKey, 'abc123', slot],
            );
        await insert('a', 'task-1', 'agent-review:agent-1:abc123', 0);
        await expect(insert('b', 'task-1', 'agent-review:agent-2:def456', 0)).rejects.toThrow(
            /UNIQUE/,
        );
        await expect(
            insert('c', 'task-2', 'agent-review:agent-2:def456', 0),
        ).resolves.toBeDefined();
        await expect(
            insert('d', 'task-1', 'agent-review:agent-2:def456', 1),
        ).resolves.toBeDefined();
        // …and a slot is not optional.
        await expect(
            dataSource.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha") VALUES (?, ?, ?, ?, ?, ?)`,
                ['e', 'task-1', 'agent-3', 'app-1', 'agent-review:agent-3:abc123', 'abc123'],
            ),
        ).rejects.toThrow(/NOT NULL/);
    });

    it('defaults a fresh review row to `dispatched`', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha", "slot") VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['r1', 'task-1', 'agent-1', 'app-1', 'agent-review:agent-1:abc', 'abc', 0],
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
        // 18, not 17: the `slot` column Greptile P1-C added. Still exact —
        // a second run adds nothing.
        expect(Object.keys(await columns('task_agent_reviews'))).toHaveLength(18);
        const indices: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("task_agent_reviews")`,
        );
        expect(indices.filter((index) => index.name === 'uq_task_agent_review_slot')).toHaveLength(
            1,
        );
        expect(Object.keys(await columns('task_approvers'))).toHaveLength(9);
    });

    it('converges a ledger created WITHOUT the budget slot — backfilled per Task, NOT NULL, uniquely indexed', async () => {
        // A `task_agent_reviews` table from this migration's earlier revision
        // (or `synchronize` from the earlier entity): every column but
        // `slot`, and populated. `createTable` is skipped for an existing
        // table, so this used to reach `createIndex(['taskId', 'slot'])` on a
        // column that did not exist and throw.
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'task_agent_reviews',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'reviewerAgentId', type: 'uuid' },
                    { name: 'approverId', type: 'uuid' },
                    { name: 'claimKey', type: 'varchar', length: '200' },
                    { name: 'headSha', type: 'varchar', length: '64' },
                    { name: 'prNumber', type: 'int', isNullable: true },
                    { name: 'ciState', type: 'varchar', length: '16', isNullable: true },
                    { name: 'runId', type: 'uuid', isNullable: true },
                    { name: 'state', type: 'varchar', length: '24', default: "'dispatched'" },
                    { name: 'refusalCode', type: 'varchar', length: '64', isNullable: true },
                    { name: 'summary', type: 'text', isNullable: true },
                    { name: 'decidedAt', type: 'timestamp', isNullable: true },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
        );
        const seed = async (id: string, taskId: string, head: string, createdAt: string) =>
            runner.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [id, taskId, 'agent-1', 'app-1', `agent-review:agent-1:${head}`, head, createdAt],
            );
        // Inserted out of claim order on purpose; two rows share a timestamp
        // so the `id` tie-break is exercised too.
        await seed('r-3', 'task-1', 'ccc', '2026-09-03 00:00:00');
        await seed('r-1', 'task-1', 'aaa', '2026-09-01 00:00:00');
        await seed('r-2b', 'task-1', 'bbb', '2026-09-02 00:00:00');
        await seed('r-2a', 'task-1', 'bb0', '2026-09-02 00:00:00');
        await seed('r-x', 'task-2', 'aaa', '2026-09-05 00:00:00');
        await runner.release();

        await runUp();

        // The physical shape is exactly the entity's, as on the createTable
        // path — `slot` NOT NULL.
        const table = await physical('task_agent_reviews');
        const declared = await entityColumns(TaskAgentReview);
        expect(Object.keys(table).sort()).toEqual(declared.map((column) => column.name).sort());
        expect(table.slot.notnull).toBe(1);

        // Every existing row survived and holds a dense, per-Task slot in
        // claim order.
        const rows: Array<{ id: string; taskId: string; slot: number }> = await dataSource.query(
            `SELECT id, "taskId", slot FROM task_agent_reviews ORDER BY "taskId", slot`,
        );
        expect(rows.map((row) => [row.taskId, row.id, Number(row.slot)])).toEqual([
            ['task-1', 'r-1', 0],
            ['task-1', 'r-2a', 1],
            ['task-1', 'r-2b', 2],
            ['task-1', 'r-3', 3],
            ['task-2', 'r-x', 0],
        ]);

        // …and the budget index exists, is UNIQUE, and is enforced.
        const indices: Array<{ name: string; unique: number }> = await dataSource.query(
            `PRAGMA index_list("task_agent_reviews")`,
        );
        expect(indices.find((index) => index.name === 'uq_task_agent_review_slot')?.unique).toBe(1);
        expect(indices.find((index) => index.name === 'uq_task_agent_review_claim')?.unique).toBe(
            1,
        );
        await expect(
            dataSource.query(
                `INSERT INTO task_agent_reviews (id, "taskId", "reviewerAgentId", "approverId", "claimKey", "headSha", "slot") VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ['r-dup', 'task-1', 'agent-2', 'app-2', 'agent-review:agent-2:ddd', 'ddd', 0],
            ),
        ).rejects.toThrow(/UNIQUE/);

        // A second run changes nothing.
        await expect(runUp()).resolves.toBeUndefined();
        expect(Object.keys(await columns('task_agent_reviews'))).toHaveLength(18);
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
