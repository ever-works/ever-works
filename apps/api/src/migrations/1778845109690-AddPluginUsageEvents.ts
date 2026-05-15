import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Creates the `plugin_usage_events` table for EW-602 (Budgets and Credits Tracking).
 *
 * One row per AI / search / screenshot / content-extractor plugin call,
 * scoped to a Work (directory). Drives the per-plugin breakdown, per-Work
 * spend dashboards, and the BudgetGuardService cap enforcement.
 *
 * Sits alongside `usage_ledger_entries` — the ledger remains the
 * billable rollup per generation, while this is the per-call audit log.
 */
export class AddPluginUsageEvents1778845109690 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'plugin_usage_events',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    { name: 'userId', type: 'uuid' },
                    { name: 'pluginId', type: 'varchar', length: '128' },
                    { name: 'capability', type: 'varchar', length: '32' },
                    { name: 'units', type: 'int', default: 1 },
                    { name: 'costCents', type: 'int', default: 0 },
                    { name: 'currency', type: 'varchar', length: '8', default: "'usd'" },
                    { name: 'modelId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'requestId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'metadata', type: 'json', isNullable: true },
                    {
                        name: 'occurredAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'plugin_usage_events',
            new TableForeignKey({
                name: 'fk_plugin_usage_events_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
        await queryRunner.createForeignKey(
            'plugin_usage_events',
            new TableForeignKey({
                name: 'fk_plugin_usage_events_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createIndex(
            'plugin_usage_events',
            new TableIndex({
                name: 'idx_plugin_usage_events_work_occurred',
                columnNames: ['workId', 'occurredAt'],
            }),
        );
        await queryRunner.createIndex(
            'plugin_usage_events',
            new TableIndex({
                name: 'idx_plugin_usage_events_work_cap_plugin_occurred',
                columnNames: ['workId', 'capability', 'pluginId', 'occurredAt'],
            }),
        );
        await queryRunner.createIndex(
            'plugin_usage_events',
            new TableIndex({
                name: 'idx_plugin_usage_events_user_occurred',
                columnNames: ['userId', 'occurredAt'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('plugin_usage_events', true);
    }
}
