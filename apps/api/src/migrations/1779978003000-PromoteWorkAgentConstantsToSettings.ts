import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.4.
 *
 * Promotes four previously-hardcoded loop constants on the work
 * agent into user-customizable settings (spec §6.2, §6.3). The
 * matching read-side wiring lands in Phase 1 PR D — until that
 * lands, the columns are present-but-unread (NULL on every row),
 * and the existing hardcoded defaults continue to apply.
 *
 * Columns added on `work_agent_preferences`:
 *
 *   - `autoGenerateCadence` (varchar 64, NULL)
 *       Cron expression for the Auto-generate Ideas background
 *       loop. NULL = inherit platform default. Surfaced in the
 *       settings page under the new `#auto-generate-ideas` anchor.
 *
 *   - `autoGenerateBatchSize` (int, NULL)
 *       Ideas per tick. NULL = inherit platform default. Same
 *       settings sub-section as above.
 *
 *   - `autoBuildThrottlePerDay` (int, NULL)
 *       Max Ideas auto-built into Works per 24h. NULL = unlimited.
 *       Surfaced under the `#auto-build-works` anchor.
 *
 *   - `missionDefaultOutstandingCap` (int, NULL)
 *       Default per-Mission outstanding-Ideas cap when a Mission
 *       has `outstandingIdeasCap = NULL`. NULL on this column =
 *       inherit platform default (20). Negative sentinel (-1) =
 *       the user explicitly set "unlimited" as their account
 *       default. Surfaced under `#auto-build-works`.
 *
 * All four columns are NULLABLE because each represents an
 * optional user override of a platform default. The hardcoded
 * platform defaults stay in code; if the column is NULL the
 * existing read path returns the same value it returned before
 * this migration. This keeps the migration safe to deploy ahead
 * of PR D — no behavior change until the read path is wired.
 *
 * Idempotent and reversible. `down()` drops the columns in
 * reverse order of `up()`.
 */
export class PromoteWorkAgentConstantsToSettings1779978003000 implements MigrationInterface {
    private static readonly COLUMNS = [
        { name: 'autoGenerateCadence', type: 'varchar', length: '64' as const },
        { name: 'autoGenerateBatchSize', type: 'int' },
        { name: 'autoBuildThrottlePerDay', type: 'int' },
        { name: 'missionDefaultOutstandingCap', type: 'int' },
    ] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const col of PromoteWorkAgentConstantsToSettings1779978003000.COLUMNS) {
            if (!(await queryRunner.hasColumn('work_agent_preferences', col.name))) {
                await queryRunner.addColumn(
                    'work_agent_preferences',
                    new TableColumn({
                        name: col.name,
                        type: col.type,
                        length: 'length' in col ? col.length : undefined,
                        isNullable: true,
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const col of [...PromoteWorkAgentConstantsToSettings1779978003000.COLUMNS].reverse()) {
            if (await queryRunner.hasColumn('work_agent_preferences', col.name)) {
                await queryRunner.dropColumn('work_agent_preferences', col.name);
            }
        }
    }
}
