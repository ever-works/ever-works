import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * EW-P2-2 — external Goal metrics: `goal_metric_samples.criterionId`.
 *
 * A Goal whose metric source is `pluginId: 'external'` gets its values pushed
 * through `POST /api/integrations/v1/goals/:id/samples {criterionId?, value,
 * sampledAt}` instead of a provider read. A sample with a `criterionId` measures
 * that weighted criterion; NULL is the Goal's own metric, which is every
 * existing (provider-read) row. The index serves "the latest sample of one
 * criterion" when the score is recomputed.
 *
 * Additive and idempotent (the column and the index are each guarded); `down`
 * drops them.
 */
export class AddGoalMetricSampleCriterionId1795140000000 implements MigrationInterface {
    name = 'AddGoalMetricSampleCriterionId1795140000000';

    static readonly TABLE = 'goal_metric_samples';
    static readonly INDEX = 'idx_goal_metric_samples_goal_criterion_sampled';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, INDEX } = AddGoalMetricSampleCriterionId1795140000000;
        let table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (!table.findColumnByName('criterionId')) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({
                    name: 'criterionId',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
            table = await queryRunner.getTable(TABLE);
        }
        if (table && !table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.createIndex(
                TABLE,
                new TableIndex({
                    name: INDEX,
                    columnNames: ['goalId', 'criterionId', 'sampledAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, INDEX } = AddGoalMetricSampleCriterionId1795140000000;
        let table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
            table = await queryRunner.getTable(TABLE);
        }
        if (table?.findColumnByName('criterionId')) {
            await queryRunner.dropColumn(TABLE, 'criterionId');
        }
    }
}
