import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-08 T34 (FR-51…FR-55) — a Mission's output mode and the bounds of its Task output.
 *
 * ## The stamp
 *
 * App Works block `1792xx`; the newest is `1792350000000-AddGoalWorkScope` (T31), so this takes
 * the next free slot (the plan's `1792080200000` predates the block's later stamps).
 *
 * ## What it does — three columns on `missions`, nothing else
 *
 * | column               | type                         | holds                                         |
 * |----------------------|------------------------------|-----------------------------------------------|
 * | `outputMode`         | varchar(8) NOT NULL `'ideas'`| `ideas` / `tasks` / `both`                    |
 * | `taskOutput`         | text (simple-json) NULL      | `{ tasksPerTick, openTasksCap, agentId? }`    |
 * | `taskOutputNoticeAt` | timestamp NULL               | the once-per-day "nothing to file" notice     |
 *
 * Every existing Mission reads `outputMode = 'ideas'` (the column default): it files Ideas
 * exactly as before. No backfill.
 *
 * ## Portable, forward-only, idempotent
 *
 * Each column is added only when absent (the table is re-read per step: SQLite recreates the
 * table on an added column). `down()` drops only what `up()` added.
 */
export class AddMissionTaskOutput1792360000000 implements MigrationInterface {
    name = 'AddMissionTaskOutput1792360000000';

    static readonly TABLE = 'missions';

    static dateType(driver: string): string {
        return driver === 'postgres' || driver === 'cockroachdb' ? 'timestamp' : 'datetime';
    }

    static columns(driver: string): TableColumn[] {
        return [
            new TableColumn({
                name: 'outputMode',
                type: 'varchar',
                length: '8',
                isNullable: false,
                default: "'ideas'",
            }),
            new TableColumn({ name: 'taskOutput', type: 'text', isNullable: true }),
            new TableColumn({
                name: 'taskOutputNoticeAt',
                type: AddMissionTaskOutput1792360000000.dateType(driver),
                isNullable: true,
            }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const C = AddMissionTaskOutput1792360000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;
        for (const column of C.columns(queryRunner.connection.options.type)) {
            const table = await queryRunner.getTable(C.TABLE);
            if (table?.findColumnByName(column.name)) continue;
            await queryRunner.addColumn(C.TABLE, column);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const C = AddMissionTaskOutput1792360000000;
        for (const column of [...C.columns(queryRunner.connection.options.type)].reverse()) {
            const table = await queryRunner.getTable(C.TABLE);
            if (!table?.findColumnByName(column.name)) continue;
            await queryRunner.dropColumn(C.TABLE, column.name);
        }
    }
}
