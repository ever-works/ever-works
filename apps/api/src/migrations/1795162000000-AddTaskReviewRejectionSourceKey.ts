import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const INDEX_NAME = 'uq_task_review_rejection_task_source';

/**
 * 10-09 fleet handover, item 11 — one rejection / finding row per SOURCE.
 *
 * `task_review_rejections` had no column naming the GitHub object a row came
 * from, so a `created` webhook redelivered by hand (or by GitHub's own retry)
 * wrote the same reviewer finding twice — and each pending row is something
 * the fix loop resumes the agent with, on the owner's PC.
 *
 *  - `sourceKey` (varchar 120, nullable) — `review:<id>`,
 *    `pull_request_review_comment:<id>`, `issue_comment:<id>`. Prefixed because
 *    GitHub's review and comment ids are separate id spaces.
 *  - `uq_task_review_rejection_task_source` — UNIQUE (taskId, sourceKey)
 *    WHERE sourceKey IS NOT NULL. Partial, so the rows that have no provider
 *    source (a Task-review reject, the gate) never collide, and every row
 *    written before this migration (all NULL) is untouched. No backfill.
 *
 * Forward-only with per-step guards so a partially applied database
 * converges; portable `TableColumn` / `TableIndex` DDL (Postgres in prod,
 * better-sqlite3 in CI / e2e — both support partial indexes).
 */
export class AddTaskReviewRejectionSourceKey1795162000000 implements MigrationInterface {
    name = 'AddTaskReviewRejectionSourceKey1795162000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const rejections = await queryRunner.getTable('task_review_rejections');
        if (!rejections) return;
        if (!rejections.findColumnByName('sourceKey')) {
            await queryRunner.addColumn(
                'task_review_rejections',
                new TableColumn({ name: 'sourceKey', type: 'varchar', length: '120', isNullable: true }),
            );
        }
        // Re-read: the sqlite driver rebuilds the table on addColumn.
        const refreshed = await queryRunner.getTable('task_review_rejections');
        if (refreshed && !refreshed.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.createIndex(
                'task_review_rejections',
                new TableIndex({
                    name: INDEX_NAME,
                    columnNames: ['taskId', 'sourceKey'],
                    isUnique: true,
                    where: '"sourceKey" IS NOT NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rejections = await queryRunner.getTable('task_review_rejections');
        if (!rejections) return;
        if (rejections.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.dropIndex('task_review_rejections', INDEX_NAME);
        }
        const refreshed = await queryRunner.getTable('task_review_rejections');
        if (refreshed?.findColumnByName('sourceKey')) {
            await queryRunner.dropColumn('task_review_rejections', 'sourceKey');
        }
    }
}
