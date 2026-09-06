import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * CI feedback and the autonomous fix loop (self-build slice AC, EW-806,
 * closes finding R17).
 *
 * ## One table — the attempt ledger, which IS the retry budget
 *
 * `task_ci_auto_resume_attempts` holds one row per auto-resume ATTEMPT.
 * The `(taskId, claimKey)` index is **UNIQUE and load-bearing**: it is
 * the only thing standing between one red pull request and a resume
 * storm. A twelve-job matrix goes red twelve times for one push, GitHub
 * redelivers anything it did not get a 2xx for, and two API replicas can
 * handle one delivery concurrently — all of which resolve to the SAME
 * `ci:<headSha>` claim key, and therefore to exactly one row and exactly
 * one model run. Counting rows for a Task is counting attempts, never
 * events, and it survives a crash, a redeploy and a replica swap.
 *
 * No foreign key to `tasks`: the ledger is the spend record and must
 * outlive a deleted Task the same way `fleet_audit` outlives a deleted
 * node. `idx_task_ci_auto_resume_task` serves both the budget count and
 * the `failureKey` no-progress lookup inside one Task.
 *
 * ## Three additive, nullable columns on `tasks`
 *
 *  1. `ciHeadSha` — the head commit the provider last reported checks
 *     against. The platform had NO such column (`baseSha` is where the
 *     branch was cut from; the `headSha` inside `linkedPullRequests`
 *     covers non-primary repositories only), which is precisely why
 *     "is this check result for the head we still care about?" could not
 *     be answered before this slice.
 *  2. `ciHeadSeenAt` — written as a pair with it; the only thing that
 *     orders two different head commits, so a delivery for a superseded
 *     revision can be refused instead of resuming work on dead code.
 *  3. `ciAutoResumeNoticedAt` — one-shot CAS marker so the "automatic
 *     retries stopped" Inbox notice is filed once per Task rather than
 *     once per check delivery (`InboxService.notice` has no dedup of its
 *     own).
 *
 * Forward-only with existence guards so a partially applied database
 * converges; portable `Table` / `TableColumn` DDL because CI and the e2e
 * stack run better-sqlite3 while production runs Postgres. `down()` uses
 * the query-runner primitives rather than raw `ALTER TABLE … DROP
 * COLUMN`, which sqlite cannot execute for every column shape.
 */
export class AddCiAutoResume1789800000000 implements MigrationInterface {
    name = 'AddCiAutoResume1789800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('task_ci_auto_resume_attempts'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'task_ci_auto_resume_attempts',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'taskId', type: 'uuid' },
                        { name: 'trigger', type: 'varchar', length: '16' },
                        { name: 'claimKey', type: 'varchar', length: '200' },
                        { name: 'headSha', type: 'varchar', length: '64', isNullable: true },
                        { name: 'failureKey', type: 'varchar', length: '64', isNullable: true },
                        { name: 'sourceRunId', type: 'uuid', isNullable: true },
                        { name: 'resumedRunId', type: 'uuid', isNullable: true },
                        { name: 'detail', type: 'varchar', length: '200', isNullable: true },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'CURRENT_TIMESTAMP',
                        },
                    ],
                }),
                true,
            );
        }

        const attempts = await queryRunner.getTable('task_ci_auto_resume_attempts');
        if (
            attempts &&
            !attempts.indices.some((index) => index.name === 'idx_task_ci_auto_resume_task')
        ) {
            await queryRunner.createIndex(
                'task_ci_auto_resume_attempts',
                new TableIndex({
                    name: 'idx_task_ci_auto_resume_task',
                    columnNames: ['taskId'],
                }),
            );
        }
        if (
            attempts &&
            !attempts.indices.some((index) => index.name === 'uq_task_ci_auto_resume_claim')
        ) {
            // THE guard against a resume storm. See the class doc.
            await queryRunner.createIndex(
                'task_ci_auto_resume_attempts',
                new TableIndex({
                    name: 'uq_task_ci_auto_resume_claim',
                    columnNames: ['taskId', 'claimKey'],
                    isUnique: true,
                }),
            );
        }

        const tasks = await queryRunner.getTable('tasks');
        if (!tasks) return;
        if (!tasks.findColumnByName('ciHeadSha')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({
                    name: 'ciHeadSha',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
        }
        // Re-read between adds: on sqlite an addColumn rebuilds the table,
        // so metadata captured before it is stale for the next check.
        const afterHead = await queryRunner.getTable('tasks');
        if (afterHead && !afterHead.findColumnByName('ciHeadSeenAt')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({ name: 'ciHeadSeenAt', type: 'timestamp', isNullable: true }),
            );
        }
        const afterSeen = await queryRunner.getTable('tasks');
        if (afterSeen && !afterSeen.findColumnByName('ciAutoResumeNoticedAt')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({
                    name: 'ciAutoResumeNoticedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Columns first, newest-added first, re-reading between drops for
        // the same sqlite table-rebuild reason as `up()`.
        for (const column of ['ciAutoResumeNoticedAt', 'ciHeadSeenAt', 'ciHeadSha']) {
            const tasks = await queryRunner.getTable('tasks');
            if (tasks?.findColumnByName(column)) {
                await queryRunner.dropColumn('tasks', column);
            }
        }
        if (await queryRunner.hasTable('task_ci_auto_resume_attempts')) {
            await queryRunner.dropTable('task_ci_auto_resume_attempts', true);
        }
    }
}
