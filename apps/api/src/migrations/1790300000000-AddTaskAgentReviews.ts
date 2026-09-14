import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Reviewer agent stage (self-build slice AD, EW-811, closes finding R18).
 *
 * ## One table — the review ledger, which IS the review budget
 *
 * `task_agent_reviews` holds one row per review RUN. The
 * `(taskId, claimKey)` index is **UNIQUE and load-bearing**: the claim key
 * is `agent-review:<reviewerAgentId>:<headSha>`, so a Task that leaves and
 * re-enters `in_review` on the same commit, a retried transition, two API
 * replicas handling one transition, and a review run that transitions its
 * own Task all resolve to the SAME key — and therefore to exactly one row
 * and exactly one model run on one of six fleet PCs. Counting rows for a
 * Task is counting runs, never transitions.
 *
 * The lifetime budget is a SECOND unique index, `(taskId, slot)`: every
 * review holds a slot number in `[0, maxRuns)`, so the database — not a
 * count read beforehand — refuses the run past the budget. A count read
 * before the insert let two concurrent planners each see the last slot
 * free and dispatch two runs with `TASK_AGENT_REVIEW_MAX_RUNS=1` (Greptile
 * P1-C on PR #2419, reproduced by execution). A plain INSERT against a
 * unique index is atomic on both engines this migration serves, so the
 * bound needs no lock and no engine-specific SQL.
 *
 * The row is also the only durable link between a review run and the
 * `task_approvers` row that run may write: `runId` is bound before the run
 * is enqueued, and the verdict tool is handed the speaking run's id from
 * platform state, so "did the platform dispatch THIS run for this review?"
 * is answered by `idx_task_agent_review_run`, and a run with no open row
 * — including any other run of the same agent — can record no verdict.
 *
 * No foreign key to `tasks` or `agents`: the ledger is the spend record
 * and must outlive a deleted Task, the same way `task_ci_auto_resume_
 * attempts` and `fleet_audit` do.
 *
 * ## Three additive, nullable columns on `task_approvers`
 *
 * Before this slice `approvalState` carried NO provenance — nothing on the
 * row said who or what decided, at which commit, or from which run. That
 * was tolerable while nothing ever wrote the column (the repository's
 * `setState` had zero production callers); it stops being tolerable the
 * moment an AGENT can write it.
 *
 *  1. `decidedVia` — `user` | `agent-review`. NULL on every existing row.
 *  2. `decidedByRunId` — the review run whose verdict wrote it.
 *  3. `decidedHeadSha` — the commit the decision was rendered against, so
 *     an approval for code that has since been force-pushed away cannot
 *     read as current.
 *
 * These are PROVENANCE, not authorization. `task_approvers` gates exactly
 * one transition (`in_review → done`). The human approval a merge requires
 * lives in `agent_action_proposals`, keyed
 * `merge:<taskId>:<prNumber>:<headSha>`, and
 * `MergeApprovalService.verifyMergeApproval` refuses anything whose
 * `decidedVia` is not the literal `'user'` with a non-null human decider.
 * `'agent-review'` is not a value in that column's vocabulary and this
 * migration does not touch that table.
 *
 * Forward-only with existence guards so a partially applied database
 * converges; portable `Table` / `TableColumn` DDL because CI and the e2e
 * stack run better-sqlite3 while production runs Postgres. `down()` uses
 * the query-runner primitives rather than raw `ALTER TABLE … DROP COLUMN`,
 * which sqlite cannot execute for every column shape.
 */
export class AddTaskAgentReviews1790300000000 implements MigrationInterface {
    name = 'AddTaskAgentReviews1790300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('task_agent_reviews'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'task_agent_reviews',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'taskId', type: 'uuid' },
                        { name: 'reviewerAgentId', type: 'uuid' },
                        { name: 'approverId', type: 'uuid' },
                        { name: 'claimKey', type: 'varchar', length: '200' },
                        { name: 'headSha', type: 'varchar', length: '64' },
                        // The lifetime budget slot, in [0, maxRuns). NOT
                        // NULL: a review that holds no slot would be a run
                        // the budget cannot see. See the class doc.
                        { name: 'slot', type: 'int' },
                        { name: 'prNumber', type: 'int', isNullable: true },
                        { name: 'ciState', type: 'varchar', length: '16', isNullable: true },
                        { name: 'runId', type: 'uuid', isNullable: true },
                        {
                            name: 'state',
                            type: 'varchar',
                            length: '24',
                            default: "'dispatched'",
                        },
                        { name: 'refusalCode', type: 'varchar', length: '64', isNullable: true },
                        { name: 'summary', type: 'text', isNullable: true },
                        { name: 'decidedAt', type: 'timestamp', isNullable: true },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        // Converge a ledger that exists WITHOUT `slot` — created by this
        // migration's earlier revision on this unmerged branch, or by
        // `synchronize` from the earlier entity — before anything below
        // indexes the column. `createTable` above only runs for a missing
        // table, so without this the `(taskId, slot)` index would be created
        // on a column that is not there and `up()` would throw instead of
        // converging.
        //
        // Added nullable, backfilled, THEN made NOT NULL: a NOT NULL column
        // cannot be added to a populated table without a default, and a
        // default would leave this path with a different schema from the
        // `createTable` one. The backfill numbers each Task's existing rows
        // 0, 1, 2… in claim order (`createdAt`, then `id`), so they are
        // distinct per Task — which the unique index below requires — and
        // form the same dense prefix the claim path produces. One correlated
        // UPDATE, the same SQL on both engines.
        const beforeSlot = await queryRunner.getTable('task_agent_reviews');
        if (beforeSlot && !beforeSlot.findColumnByName('slot')) {
            await queryRunner.addColumn(
                'task_agent_reviews',
                new TableColumn({ name: 'slot', type: 'int', isNullable: true }),
            );
            await queryRunner.query(
                `UPDATE "task_agent_reviews" SET "slot" = (` +
                    `SELECT COUNT(*) FROM "task_agent_reviews" "prior" ` +
                    `WHERE "prior"."taskId" = "task_agent_reviews"."taskId" ` +
                    `AND ("prior"."createdAt" < "task_agent_reviews"."createdAt" ` +
                    `OR ("prior"."createdAt" = "task_agent_reviews"."createdAt" ` +
                    `AND "prior"."id" < "task_agent_reviews"."id")))`,
            );
            // Re-read: on sqlite `addColumn` rebuilt the table.
            const withSlot = await queryRunner.getTable('task_agent_reviews');
            const nullableSlot = withSlot?.findColumnByName('slot');
            if (nullableSlot) {
                const requiredSlot = nullableSlot.clone();
                requiredSlot.isNullable = false;
                await queryRunner.changeColumn('task_agent_reviews', nullableSlot, requiredSlot);
            }
        }

        const reviews = await queryRunner.getTable('task_agent_reviews');
        if (
            reviews &&
            !reviews.indices.some((index) => index.name === 'idx_task_agent_review_task')
        ) {
            await queryRunner.createIndex(
                'task_agent_reviews',
                new TableIndex({ name: 'idx_task_agent_review_task', columnNames: ['taskId'] }),
            );
        }
        if (
            reviews &&
            !reviews.indices.some((index) => index.name === 'idx_task_agent_review_reviewer')
        ) {
            // The authorization lookup: which review, if any, did the
            // platform dispatch to this agent for this Task?
            await queryRunner.createIndex(
                'task_agent_reviews',
                new TableIndex({
                    name: 'idx_task_agent_review_reviewer',
                    columnNames: ['taskId', 'reviewerAgentId'],
                }),
            );
        }
        if (
            reviews &&
            !reviews.indices.some((index) => index.name === 'idx_task_agent_review_run')
        ) {
            // THE authorization lookup: which open review, if any, is bound
            // to the run that is submitting a verdict? Non-unique — a run id
            // is bound once, but NULL is shared by every unbound claim.
            await queryRunner.createIndex(
                'task_agent_reviews',
                new TableIndex({ name: 'idx_task_agent_review_run', columnNames: ['runId'] }),
            );
        }
        if (
            reviews &&
            !reviews.indices.some((index) => index.name === 'uq_task_agent_review_claim')
        ) {
            // THE guard against a review storm. See the class doc.
            await queryRunner.createIndex(
                'task_agent_reviews',
                new TableIndex({
                    name: 'uq_task_agent_review_claim',
                    columnNames: ['taskId', 'claimKey'],
                    isUnique: true,
                }),
            );
        }
        if (
            reviews &&
            !reviews.indices.some((index) => index.name === 'uq_task_agent_review_slot')
        ) {
            // THE budget. See the class doc.
            await queryRunner.createIndex(
                'task_agent_reviews',
                new TableIndex({
                    name: 'uq_task_agent_review_slot',
                    columnNames: ['taskId', 'slot'],
                    isUnique: true,
                }),
            );
        }

        const approvers = await queryRunner.getTable('task_approvers');
        if (!approvers) return;
        if (!approvers.findColumnByName('decidedVia')) {
            await queryRunner.addColumn(
                'task_approvers',
                new TableColumn({
                    name: 'decidedVia',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }
        // Re-read between adds: on sqlite an addColumn rebuilds the table,
        // so metadata captured before it is stale for the next check.
        const afterVia = await queryRunner.getTable('task_approvers');
        if (afterVia && !afterVia.findColumnByName('decidedByRunId')) {
            await queryRunner.addColumn(
                'task_approvers',
                new TableColumn({ name: 'decidedByRunId', type: 'uuid', isNullable: true }),
            );
        }
        const afterRun = await queryRunner.getTable('task_approvers');
        if (afterRun && !afterRun.findColumnByName('decidedHeadSha')) {
            await queryRunner.addColumn(
                'task_approvers',
                new TableColumn({
                    name: 'decidedHeadSha',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Columns first, newest-added first, re-reading between drops for
        // the same sqlite table-rebuild reason as `up()`.
        for (const column of ['decidedHeadSha', 'decidedByRunId', 'decidedVia']) {
            const approvers = await queryRunner.getTable('task_approvers');
            if (approvers?.findColumnByName(column)) {
                await queryRunner.dropColumn('task_approvers', column);
            }
        }
        if (await queryRunner.hasTable('task_agent_reviews')) {
            await queryRunner.dropTable('task_agent_reviews', true);
        }
    }
}
