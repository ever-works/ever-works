import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Merge approval in the Inbox (self-build slice AE, EW-805) — the two
 * columns that make an approval un-replayable, plus the provider-review
 * context shown to the person giving it.
 *
 * `agent_action_proposals.subjectKey`
 *   WHAT a decision is about, in a form a consumer can look up by
 *   equality: `merge:<taskId>:<prNumber>:<headSha>` for a
 *   `merge_pull_request` proposal, NULL for every other action type (the
 *   rest of the queue is a record nothing reads back). It is the whole
 *   safety property of the slice — the merge path re-derives the key from
 *   LIVE provider state, so an approval cannot be replayed onto a
 *   different pull request, or onto the same one after a force-push.
 *   Indexed UNIQUELY on `(actionType, subjectKey)`: the merge gate probes
 *   it on every merge attempt, and the uniqueness is what stops the cron
 *   worker and an API refresh both filing an approval for the same commit.
 *   NULL subject keys (every other action type) stay unconstrained,
 *   because NULLs are distinct in a unique index on Postgres and SQLite
 *   alike.
 *
 * `tasks.mergeRefusedSha` / `…Code`
 *   The last merge refusal reported for the Task, so a refusal that is a
 *   property of the repository (a protected base branch, a required
 *   review) is told to the human ONCE instead of once per two-minute
 *   PR-status sweep.
 *
 * `tasks.prHeadSha`
 *   The head commit the PROVIDER last reported for the Task's pull
 *   request. `TaskPrStatusService` already fetched it and threw it away.
 *   Note this does NOT contradict `recordRemotePush`, which deliberately
 *   refuses to persist the head a run pushed ("the remote owns the branch
 *   head") — that is the same rule from the other side.
 *
 * `tasks.prReviewApprovedSha` / `…At` / `…By`
 *   A HUMAN provider-side review approval, stamped with the commit it was
 *   given for. Never written for a bot of any kind. It is CONTEXT for the
 *   platform-side approver, not an authorization: a provider login is not
 *   a platform identity.
 *
 * Every column is nullable and additive. Existing rows read NULL, which
 * is the correct history: no proposal before this migration was about a
 * merge, no Task had a recorded head, and nobody had approved anything on
 * a provider in a way the platform kept. Forward-only with per-step
 * guards so a partially applied database converges; portable
 * `TableColumn` DDL because CI and the e2e stack run better-sqlite3 while
 * production runs Postgres.
 */
export class AddMergeApprovalBinding1789700000000 implements MigrationInterface {
    name = 'AddMergeApprovalBinding1789700000000';

    private static readonly TASK_COLUMNS: TableColumn[] = [
        new TableColumn({ name: 'prHeadSha', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({
            name: 'prReviewApprovedSha',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
        new TableColumn({ name: 'prReviewApprovedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({
            name: 'prReviewApprovedBy',
            type: 'varchar',
            length: '128',
            isNullable: true,
        }),
        new TableColumn({
            name: 'mergeRefusedSha',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
        new TableColumn({
            name: 'mergeRefusedCode',
            type: 'varchar',
            length: '64',
            isNullable: true,
        }),
    ];

    /**
     * UNIQUE on purpose: `MergeApprovalService.requestMergeApproval` is a
     * check-then-create whose callers sit in two processes (the
     * `task-pr-status-sync` cron worker and an API `?refresh=true`), so
     * only the database can stop both of them filing an approval for the
     * same (Task, pull request, head). `subjectKey` is NULL for every
     * other action type and NULLs are DISTINCT in a unique index on both
     * Postgres and SQLite, so nothing else in the queue is constrained.
     */
    private static readonly SUBJECT_INDEX = new TableIndex({
        name: 'idx_agent_action_proposals_subject',
        columnNames: ['actionType', 'subjectKey'],
        isUnique: true,
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const proposals = await queryRunner.getTable('agent_action_proposals');
        if (proposals) {
            if (!proposals.findColumnByName('subjectKey')) {
                await queryRunner.addColumn(
                    'agent_action_proposals',
                    new TableColumn({
                        name: 'subjectKey',
                        type: 'varchar',
                        length: '200',
                        isNullable: true,
                    }),
                );
            }
            const fresh = await queryRunner.getTable('agent_action_proposals');
            const hasIndex = fresh?.indices.some(
                (index) => index.name === AddMergeApprovalBinding1789700000000.SUBJECT_INDEX.name,
            );
            if (fresh?.findColumnByName('subjectKey') && !hasIndex) {
                await queryRunner.createIndex(
                    'agent_action_proposals',
                    AddMergeApprovalBinding1789700000000.SUBJECT_INDEX,
                );
            }
        }

        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            for (const column of AddMergeApprovalBinding1789700000000.TASK_COLUMNS) {
                if (!tasks.findColumnByName(column.name)) {
                    await queryRunner.addColumn('tasks', column);
                }
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            // Reverse order of `up`, and `dropColumn` rather than a raw
            // `ALTER TABLE … DROP COLUMN`: the query runner rebuilds the
            // table on drivers that cannot drop a column in place, which
            // is exactly the driver CI uses.
            for (const column of [...AddMergeApprovalBinding1789700000000.TASK_COLUMNS].reverse()) {
                const found = tasks.findColumnByName(column.name);
                if (found) {
                    await queryRunner.dropColumn('tasks', found);
                }
            }
        }

        const proposals = await queryRunner.getTable('agent_action_proposals');
        if (proposals) {
            const index = proposals.indices.find(
                (candidate) =>
                    candidate.name === AddMergeApprovalBinding1789700000000.SUBJECT_INDEX.name,
            );
            if (index) {
                await queryRunner.dropIndex('agent_action_proposals', index);
            }
            const column = proposals.findColumnByName('subjectKey');
            if (column) {
                await queryRunner.dropColumn('agent_action_proposals', column);
            }
        }
    }
}
