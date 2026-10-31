import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * APW-08 T31 (FR-45, FR-46) — a Goal may name the one Work it works on.
 *
 * ## The stamp
 *
 * App Works block `1792xx`; the newest on `develop` is `1792340000000-AddAppRunContainment`, so
 * this takes the next free slot after it (the plan's `1792080100000` predates the block's later
 * stamps). It depends on nothing stamped in between.
 *
 * ## What it does — one nullable `uuid` column and its index, nothing else
 *
 * `goals.workId` holds the Work whose Tasks the Goal's loop files (`idx_goals_work` serves "the
 * Goals of this Work"). No foreign key, on purpose: a deleted Work must PAUSE the loop with a
 * message (FR-48), never cascade into the Goal or block the Work's deletion.
 *
 * NULL on every existing row is exactly the Goal before P2 (no Work). No backfill.
 *
 * ## Portable, forward-only, idempotent
 *
 * The column and the index are each added only when absent (the table is re-read: SQLite
 * recreates the table on an added column). `down()` drops only what `up()` added.
 */
export class AddGoalWorkScope1792350000000 implements MigrationInterface {
    name = 'AddGoalWorkScope1792350000000';

    static readonly TABLE = 'goals';
    static readonly COLUMN = 'workId';
    static readonly INDEX = 'idx_goals_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN, INDEX } = AddGoalWorkScope1792350000000;
        let table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (!table.findColumnByName(COLUMN)) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({ name: COLUMN, type: 'uuid', isNullable: true }),
            );
            table = await queryRunner.getTable(TABLE);
        }
        if (table && !table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.createIndex(
                TABLE,
                new TableIndex({ name: INDEX, columnNames: [COLUMN] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN, INDEX } = AddGoalWorkScope1792350000000;
        let table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
            table = await queryRunner.getTable(TABLE);
        }
        if (table?.findColumnByName(COLUMN)) {
            await queryRunner.dropColumn(TABLE, COLUMN);
        }
    }
}
