import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Domain-model evolution PR-3 (review §23.2): splits the Mission's
 * workflow `status` from its conclusion verdict.
 *
 *   - `outcome` varchar(24) NULL — succeeded | partially_succeeded |
 *     failed | cancelled | superseded. NULL for every existing row
 *     (verdicts are NEVER invented in backfill — review §17 Phase 2d)
 *     and for any future completion where the human skips the picker.
 *   - `completedAt` timestamp NULL — stamped at completion, cleared on
 *     revival (resume from FAILED, or a future re-activate).
 *
 * No status enum change: the stored value stays 'completed' and the
 * product verb stays "Complete" (operator ruling).
 *
 * Idempotent: both adds are hasColumn-guarded. down() drops them.
 */
export class AddMissionOutcomeToMissions1781800000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('missions', 'outcome'))) {
            await queryRunner.addColumn(
                'missions',
                new TableColumn({
                    name: 'outcome',
                    type: 'varchar',
                    length: '24',
                    isNullable: true,
                }),
            );
        }
        if (!(await queryRunner.hasColumn('missions', 'completedAt'))) {
            await queryRunner.addColumn(
                'missions',
                new TableColumn({
                    name: 'completedAt',
                    type: 'timestamp',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('missions', 'completedAt')) {
            await queryRunner.dropColumn('missions', 'completedAt');
        }
        if (await queryRunner.hasColumn('missions', 'outcome')) {
            await queryRunner.dropColumn('missions', 'outcome');
        }
    }
}
