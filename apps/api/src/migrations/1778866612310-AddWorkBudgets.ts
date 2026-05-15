import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Creates `work_budgets` and `work_budget_alert_states` tables for
 * EW-602 (Budgets and Credits Tracking).
 *
 * - `work_budgets`: per-Work monthly cap, scope=global or scope=plugin
 *   (with pluginId). `allowOverage` toggles whether 100% blocks the call
 *   or merely warns. Unique on (workId, scope, pluginId).
 * - `work_budget_alert_states`: idempotency record for 75/90/100/overage
 *   alerts within a billing period. Prevents repeat in-app + email pings
 *   when the same threshold is crossed multiple times in a single period.
 */
export class AddWorkBudgets1778866612310 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'work_budgets',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    { name: 'scope', type: 'varchar', length: '16' },
                    { name: 'pluginId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'monthlyCapCents', type: 'int' },
                    { name: 'currency', type: 'varchar', length: '8', default: "'usd'" },
                    { name: 'allowOverage', type: 'boolean', default: false },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'work_budgets',
            new TableForeignKey({
                name: 'fk_work_budgets_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createIndex(
            'work_budgets',
            new TableIndex({
                name: 'uq_work_budgets_work_scope_plugin',
                columnNames: ['workId', 'scope', 'pluginId'],
                isUnique: true,
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'work_budget_alert_states',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workId', type: 'uuid' },
                    { name: 'budgetId', type: 'uuid' },
                    { name: 'threshold', type: 'varchar', length: '16' },
                    { name: 'periodStart', type: 'timestamp' },
                    { name: 'sentAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'work_budget_alert_states',
            new TableForeignKey({
                name: 'fk_work_budget_alert_states_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
        await queryRunner.createForeignKey(
            'work_budget_alert_states',
            new TableForeignKey({
                name: 'fk_work_budget_alert_states_budget',
                columnNames: ['budgetId'],
                referencedTableName: 'work_budgets',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createIndex(
            'work_budget_alert_states',
            new TableIndex({
                name: 'uq_work_budget_alert_states_budget_threshold_period',
                columnNames: ['budgetId', 'threshold', 'periodStart'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'work_budget_alert_states',
            new TableIndex({
                name: 'idx_work_budget_alert_states_work_period',
                columnNames: ['workId', 'periodStart'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('work_budget_alert_states', true);
        await queryRunner.dropTable('work_budgets', true);
    }
}
