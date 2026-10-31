import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 T35 (FR-53, APW08-G15) — a run's own spend cap.
 *
 * ## The stamp
 *
 * App Works block `1792xx`; the newest is `1792360000000-AddMissionTaskOutput` (T34), so this
 * takes the next free slot.
 *
 * ## What it does — one nullable `int` column on `agent_runs`, nothing else
 *
 * `budgetCapCents` holds the cap a run was dispatched with (a Mission-filed Task's run carries
 * the Mission's per-run budget). NULL on every existing row is "no cap beyond the Agent's own
 * settings" — every run before APW-08 P2. No backfill.
 *
 * ## Portable, forward-only, idempotent
 *
 * Added only when absent; `down()` drops only what `up()` added.
 */
export class AddAgentRunBudgetCap1792370000000 implements MigrationInterface {
    name = 'AddAgentRunBudgetCap1792370000000';

    static readonly TABLE = 'agent_runs';
    static readonly COLUMN = 'budgetCapCents';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddAgentRunBudgetCap1792370000000;
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'int', isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddAgentRunBudgetCap1792370000000;
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(COLUMN)) return;
        await queryRunner.dropColumn(TABLE, COLUMN);
    }
}
