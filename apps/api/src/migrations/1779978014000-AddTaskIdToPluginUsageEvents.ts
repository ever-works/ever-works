import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Tasks feature — Phase 11.4 (`features/task-tracking/plan.md §3.2`).
 *
 * Additive change to `plugin_usage_events`:
 *   - new `taskId uuid NULL` column for per-Task spend attribution
 *   - new `(taskId, occurredAt)` index for the spend-rollup endpoint
 *
 * NO FK to `tasks` — deleting a Task must NOT cascade-drop audit
 * rows. Same posture as the Phase 1 `agentId` column.
 *
 * Idempotent: gates on `hasColumn` / `hasIndex`.
 */
export class AddTaskIdToPluginUsageEvents1779978014000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('plugin_usage_events', 'taskId');
        if (!hasColumn) {
            await queryRunner.addColumn(
                'plugin_usage_events',
                new TableColumn({
                    name: 'taskId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable('plugin_usage_events');
        const indexExists = table?.indices.some(
            (idx) => idx.name === 'idx_plugin_usage_events_task_occurred',
        );
        if (!indexExists) {
            await queryRunner.createIndex(
                'plugin_usage_events',
                new TableIndex({
                    name: 'idx_plugin_usage_events_task_occurred',
                    columnNames: ['taskId', 'occurredAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('plugin_usage_events');
        const indexExists = table?.indices.some(
            (idx) => idx.name === 'idx_plugin_usage_events_task_occurred',
        );
        if (indexExists) {
            await queryRunner.dropIndex(
                'plugin_usage_events',
                'idx_plugin_usage_events_task_occurred',
            );
        }
        const hasColumn = await queryRunner.hasColumn('plugin_usage_events', 'taskId');
        if (hasColumn) {
            await queryRunner.dropColumn('plugin_usage_events', 'taskId');
        }
    }
}
