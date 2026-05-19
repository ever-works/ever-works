import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * EW-617 G8 — persist the funnel correlation id on the work row so the
 * async DEPLOY_READY poller can emit the funnel event with the same id
 * the rest of the flow used (LANDING_PROMPT_SUBMIT → WORK_CREATED →
 * REPOS_PUSHED → DEPLOY_STARTED → DEPLOY_READY).
 *
 * Nullable; no backfill needed. Existing rows + non-funnel creates skip
 * the emit and that's intentional.
 */
export class AddWorkLastDeployCorrelationId1779000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'lastDeployCorrelationId'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'lastDeployCorrelationId',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'lastDeployCorrelationId')) {
            await queryRunner.dropColumn('works', 'lastDeployCorrelationId');
        }
    }
}
