import { DataSource, Table } from 'typeorm';
import { AddMergeApprovalBinding1789700000000 } from '../1789700000000-AddMergeApprovalBinding';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 *
 * Assertions are against the PHYSICAL schema — `PRAGMA table_info` and
 * `PRAGMA index_list` — rather than against TypeORM's own view of it.
 * The metadata reader is the thing under test as much as the DDL is: a
 * migration that satisfies `getTable()` but leaves the table unchanged
 * would pass a metadata-only check and fail in production. Watching an
 * INSERT fail is not a substitute either — that only proves *a*
 * constraint exists, not that the column does.
 */
describe('AddMergeApprovalBinding1789700000000', () => {
    let dataSource: DataSource;
    const migration = new AddMergeApprovalBinding1789700000000();

    const TASK_COLUMNS = [
        'prHeadSha',
        'prReviewApprovedSha',
        'prReviewApprovedAt',
        'prReviewApprovedBy',
        'mergeRefusedSha',
        'mergeRefusedCode',
    ] as const;

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
                name: 'agent_action_proposals',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'agentId', type: 'uuid' },
                    { name: 'actionType', type: 'varchar', length: '32' },
                    { name: 'title', type: 'varchar', length: '200' },
                    { name: 'payload', type: 'text' },
                    { name: 'riskFlags', type: 'text' },
                    { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'tasks',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'slug', type: 'varchar', length: '16' },
                    { name: 'title', type: 'varchar', length: '200' },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'prNumber', type: 'int', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO agent_action_proposals (id, "userId", "agentId", "actionType", title, payload, "riskFlags", status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['p-1', 'user-1', 'agent-1', 'spawn_agent', 'Spawn a helper', '{}', '[]', 'pending'],
        );
        await runner.query(
            `INSERT INTO tasks (id, "userId", slug, title, status, "prNumber") VALUES (?, ?, ?, ?, ?, ?)`,
            ['t-1', 'user-1', 'T-1', 'Ship the thing', 'in_review', 7],
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

    async function physicalColumns(table: string): Promise<Map<string, string>> {
        const rows: Array<{ name: string; type: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return new Map(rows.map((row) => [row.name, row.type]));
    }

    async function physicalIndexes(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("${table}")`,
        );
        return rows.map((row) => row.name);
    }

    it('adds subjectKey to agent_action_proposals as a nullable varchar', async () => {
        expect((await physicalColumns('agent_action_proposals')).has('subjectKey')).toBe(false);
        await runUp();

        const columns = await physicalColumns('agent_action_proposals');
        expect(columns.get('subjectKey')).toMatch(/varchar\(200\)/i);

        const notNull: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("agent_action_proposals")`,
        );
        expect(notNull.find((row) => row.name === 'subjectKey')?.notnull).toBe(0);
    });

    it('leaves every existing proposal with a NULL subject — none of them was about a merge', async () => {
        await runUp();
        expect(
            await dataSource.query(
                `SELECT id, "subjectKey" FROM agent_action_proposals WHERE id = ?`,
                ['p-1'],
            ),
        ).toEqual([{ id: 'p-1', subjectKey: null }]);
    });

    it('creates the lookup index the merge gate probes on every merge', async () => {
        await runUp();
        expect(await physicalIndexes('agent_action_proposals')).toContain(
            'idx_agent_action_proposals_subject',
        );
        const info: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_info("idx_agent_action_proposals_subject")`,
        );
        expect(info.map((row) => row.name)).toEqual(['actionType', 'subjectKey']);
    });

    // The index is UNIQUE, and that is a correctness property rather than
    // a performance one: `requestMergeApproval` is a check-then-create
    // whose callers live in two processes (the two-minute PR-status sweep
    // in the worker, and `?refresh=true` in the API), so only the database
    // can stop both of them filing an approval for the same commit. Two
    // pending rows would put two Approve buttons in the Inbox for one
    // merge, and a later click on the second would grant a fresh 24h
    // validity window over a head the first already covered.

    it('makes the subject index UNIQUE', async () => {
        await runUp();
        const rows: Array<{ name: string; unique: number }> = await dataSource.query(
            `PRAGMA index_list("agent_action_proposals")`,
        );
        const index = rows.find((row) => row.name === 'idx_agent_action_proposals_subject');
        expect(index).toBeDefined();
        expect(index!.unique).toBe(1);
    });

    it('refuses a SECOND pending proposal for the same subject key', async () => {
        await runUp();
        const key = `merge:9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77:42:${'a'.repeat(40)}`;
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO agent_action_proposals (id, "userId", "agentId", "actionType", title, payload, "riskFlags", status, "subjectKey") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    'user-1',
                    'agent-1',
                    'merge_pull_request',
                    'Merge PR #42',
                    '{}',
                    '[]',
                    'pending',
                    key,
                ],
            );
        await insert('p-merge-1');
        await expect(insert('p-merge-2')).rejects.toThrow(/UNIQUE/i);
    });

    it('leaves NULL subject keys unconstrained — the rest of the queue is untouched', async () => {
        // NULLs are DISTINCT in a unique index on both SQLite and
        // Postgres, so every non-merge proposal is as unconstrained as it
        // was before this migration.
        await runUp();
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO agent_action_proposals (id, "userId", "agentId", "actionType", title, payload, "riskFlags", status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, 'user-1', 'agent-1', 'spawn_agent', 'Spawn a helper', '{}', '[]', 'pending'],
            );
        await insert('p-2');
        await insert('p-3');
        expect(await dataSource.query(`SELECT COUNT(*) AS n FROM agent_action_proposals`)).toEqual([
            { n: 3 },
        ]);
    });

    it('stores a full subject key without truncating the head SHA', async () => {
        await runUp();
        // 200 chars is the declared width; a truncated head SHA would turn
        // an exact-match lookup into a prefix match.
        const key = `merge:9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77:42:${'a'.repeat(40)}`;
        await dataSource.query(`UPDATE agent_action_proposals SET "subjectKey" = ? WHERE id = ?`, [
            key,
            'p-1',
        ]);
        const [row] = await dataSource.query(
            `SELECT "subjectKey" FROM agent_action_proposals WHERE id = ?`,
            ['p-1'],
        );
        expect(row.subjectKey).toBe(key);
    });

    it('adds the PR head / review / merge-refusal columns to tasks, all nullable', async () => {
        await runUp();
        const columns = await physicalColumns('tasks');
        for (const name of TASK_COLUMNS) {
            expect(columns.has(name)).toBe(true);
        }
        expect(columns.get('prHeadSha')).toMatch(/varchar\(64\)/i);
        expect(columns.get('prReviewApprovedBy')).toMatch(/varchar\(128\)/i);
        expect(columns.get('mergeRefusedSha')).toMatch(/varchar\(64\)/i);
        expect(columns.get('mergeRefusedCode')).toMatch(/varchar\(64\)/i);

        const info: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("tasks")`,
        );
        for (const name of TASK_COLUMNS) {
            expect(info.find((row) => row.name === name)?.notnull).toBe(0);
        }
    });

    it('leaves existing Tasks with no recorded head, review or merge refusal', async () => {
        await runUp();
        expect(
            await dataSource.query(
                `SELECT "prHeadSha", "prReviewApprovedSha", "prReviewApprovedAt", "prReviewApprovedBy", "mergeRefusedSha", "mergeRefusedCode" FROM tasks WHERE id = ?`,
                ['t-1'],
            ),
        ).toEqual([
            {
                prHeadSha: null,
                prReviewApprovedSha: null,
                prReviewApprovedAt: null,
                prReviewApprovedBy: null,
                mergeRefusedSha: null,
                mergeRefusedCode: null,
            },
        ]);
    });

    it('is idempotent on re-run', async () => {
        await runUp();
        await runUp();
        const columns = await physicalColumns('tasks');
        for (const name of TASK_COLUMNS) expect(columns.has(name)).toBe(true);
        expect(
            (await physicalIndexes('agent_action_proposals')).filter(
                (name) => name === 'idx_agent_action_proposals_subject',
            ),
        ).toHaveLength(1);
    });

    it('down() removes every column and the index, and is itself idempotent', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        expect((await physicalColumns('agent_action_proposals')).has('subjectKey')).toBe(false);
        expect(await physicalIndexes('agent_action_proposals')).not.toContain(
            'idx_agent_action_proposals_subject',
        );
        const tasks = await physicalColumns('tasks');
        for (const name of TASK_COLUMNS) expect(tasks.has(name)).toBe(false);

        const second = dataSource.createQueryRunner();
        await migration.down(second);
        await second.release();
        expect((await physicalColumns('agent_action_proposals')).has('subjectKey')).toBe(false);
    });

    it('down() preserves the rows it did not add', async () => {
        await runUp();
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
        expect(await dataSource.query(`SELECT id FROM agent_action_proposals`)).toEqual([
            { id: 'p-1' },
        ]);
        expect(await dataSource.query(`SELECT id, "prNumber" FROM tasks`)).toEqual([
            { id: 't-1', prNumber: 7 },
        ]);
    });
});
