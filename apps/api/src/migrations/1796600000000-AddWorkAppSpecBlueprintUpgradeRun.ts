import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-03 P2 (T28–T31, lane aw-blueprints) — the run columns of a Blueprint apply or
 * upgrade on `work_app_spec_states`:
 *
 *  - `blueprintUpgradeStatus` (varchar(16), nullable) — `queued` · `running` ·
 *    `proposed` · `unchanged` · `failed`; NULL when no run was ever requested or the
 *    proposal landed. It is the in-flight guard of `POST …/app-spec/blueprint[/upgrade]`
 *    (`409 applyInProgress`): the request claims it with one guarded UPDATE.
 *  - `blueprintUpgradeError` (varchar(64), nullable) — the reason code of a `failed` run.
 *  - `blueprintUpgradeRequestedAt` (timestamp, nullable) — when the run was claimed, so
 *    a claim whose job never ran (no runtime, a lost dispatch) goes stale and can be
 *    claimed again instead of blocking the App Work forever.
 *
 * The pull request itself stays in the existing `blueprintUpgradePr` simple-json column
 * (`{ number, url, version, breaking, … }`, plan §3.1).
 *
 * Portable `TableColumn` DDL (CI and e2e run better-sqlite3, production Postgres),
 * `timestamp` as the table's other date columns, every step guarded and re-read so a
 * partially applied database converges. Additive only: no existing column, index or
 * row is touched.
 */
export class AddWorkAppSpecBlueprintUpgradeRun1796600000000 implements MigrationInterface {
    name = 'AddWorkAppSpecBlueprintUpgradeRun1796600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({
                name: 'blueprintUpgradeStatus',
                type: 'varchar',
                length: '16',
                isNullable: true,
            }),
            new TableColumn({
                name: 'blueprintUpgradeError',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
            new TableColumn({
                name: 'blueprintUpgradeRequestedAt',
                type: 'timestamp',
                isNullable: true,
            }),
        ];
        for (const column of columns) {
            const table = await queryRunner.getTable('work_app_spec_states');
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn('work_app_spec_states', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const name of [
            'blueprintUpgradeRequestedAt',
            'blueprintUpgradeError',
            'blueprintUpgradeStatus',
        ]) {
            const table = await queryRunner.getTable('work_app_spec_states');
            if (table?.findColumnByName(name)) {
                await queryRunner.dropColumn('work_app_spec_states', name);
            }
        }
    }
}
