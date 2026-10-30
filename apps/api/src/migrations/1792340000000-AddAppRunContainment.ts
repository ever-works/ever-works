import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 T48 / T12 (FR-12, FR-70, ACC-08-34) — the Fleet containment record and the owner's
 * per-node allowance store.
 *
 * ## The stamp
 *
 * App Works block `1792xx`; the newest on `develop` is `1792330000000-AddTaskChatMessageKey`, so
 * this takes the next free slot after it and runs last. It depends on nothing stamped in between.
 *
 * ## What it does — two nullable `simple-json` (`text`) columns, nothing else
 *
 * | table        | column                        | holds                                                  |
 * |--------------|-------------------------------|--------------------------------------------------------|
 * | `agent_runs` | `containment`                 | what a Fleet run of an App Work Task got: execution     |
 * |              |                               | path, whether the isolated home applied, every          |
 * |              |                               | downgrade, the node and when (written by the fleet      |
 * |              |                               | reconciler beside the run's receipt)                    |
 * | `works`      | `appRunContainmentAllowances` | the owner's per-node allowances of a containment        |
 * |              |                               | downgrade (EW-807 allow-list shape: one entry per node, |
 * |              |                               | additive, withdrawable, never implied)                  |
 *
 * Why columns and not the fleet job row: `fleet_jobs.result` already carries the node's raw
 * report, but the nightly retention pass purges job bodies (`FLEET_JOB_RETENTION_DAYS`, default
 * 30), and FR-70 says the platform STORES what the run got. The allowance is an owner decision,
 * which has no other home.
 *
 * NULL on every existing row means "no record" / "nothing allowed" — the behaviour of every run
 * and every Work before T48. No backfill: a run that predates the column simply has no record.
 *
 * ## Portable, forward-only, idempotent
 *
 * Each column is added only when absent (the table is re-read per step: SQLite recreates the
 * table on an added column). `down()` drops only what `up()` added.
 */
export class AddAppRunContainment1792340000000 implements MigrationInterface {
    name = 'AddAppRunContainment1792340000000';

    static readonly COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
        { table: 'agent_runs', column: 'containment' },
        { table: 'works', column: 'appRunContainmentAllowances' },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const { table, column } of AddAppRunContainment1792340000000.COLUMNS) {
            const current = await queryRunner.getTable(table);
            if (!current || current.findColumnByName(column)) continue;
            // `simple-json` is a `text` column holding JSON on every driver.
            await queryRunner.addColumn(
                table,
                new TableColumn({ name: column, type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const { table, column } of [...AddAppRunContainment1792340000000.COLUMNS].reverse()) {
            const current = await queryRunner.getTable(table);
            if (!current || !current.findColumnByName(column)) continue;
            await queryRunner.dropColumn(table, column);
        }
    }
}
