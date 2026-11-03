import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 T35 (review of #3061) — the Mission tick's Task-output lease.
 *
 * ## The stamp
 *
 * App Works block `1792xx`; the newest is `1792370000000-AddAgentRunBudgetCap` (T35), so this
 * takes the next free slot.
 *
 * ## What it does — one nullable `bigint` column on `missions`, nothing else
 *
 * `taskOutputLeaseUntil` is the instant (epoch milliseconds, the portable `TimestampColumn`
 * shape) until which one tick holds the Mission's Task branch. A tick claims it with a
 * compare-and-set before it counts the open Tasks and asks the planner, and clears it when done,
 * so a scheduled tick and a Run now (or two API pods) never both file up to the open-Tasks cap.
 * NULL on every existing row is "free". No backfill.
 *
 * ## Portable, forward-only, idempotent
 *
 * Added only when absent; `down()` drops only what `up()` added.
 */
export class AddMissionTaskOutputLease1792380000000 implements MigrationInterface {
    name = 'AddMissionTaskOutputLease1792380000000';

    static readonly TABLE = 'missions';
    static readonly COLUMN = 'taskOutputLeaseUntil';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddMissionTaskOutputLease1792380000000;
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'bigint', isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddMissionTaskOutputLease1792380000000;
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(COLUMN)) return;
        await queryRunner.dropColumn(TABLE, COLUMN);
    }
}
