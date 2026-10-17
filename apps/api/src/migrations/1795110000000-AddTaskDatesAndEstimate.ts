import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * EW-P2-3 — planning dates and an estimate on Tasks.
 *
 * | column              | type        | what                                          |
 * |---------------------|-------------|-----------------------------------------------|
 * | `dueAt`             | timestamp   | when the Task is due (planning only)          |
 * | `startAt`           | timestamp   | when work is planned to start                 |
 * | `estimateMinutes`   | int         | estimated effort, whole minutes               |
 * | `dueSoonNotifiedAt` | timestamp   | the `task_due_soon` notice went out for `dueAt` |
 *
 * All nullable, all NULL on existing rows, so nothing changes for a Task
 * until someone sets a date. Index `idx_tasks_due_soon (dueAt,
 * dueSoonNotifiedAt)` backs the per-minute due-soon scan.
 *
 * The timestamp spelling follows what TypeORM maps the entity's `Date`
 * columns to per driver: `timestamp` on Postgres, `datetime` on MySQL and
 * SQLite. Every step is guarded by a re-read of the table, so re-running is a
 * no-op, and down() drops exactly what up() added.
 */
export class AddTaskDatesAndEstimate1795110000000 implements MigrationInterface {
    name = 'AddTaskDatesAndEstimate1795110000000';

    static readonly TABLE = 'tasks';
    static readonly INDEX = 'idx_tasks_due_soon';

    static dateType(driver: string): string {
        return driver === 'postgres' || driver === 'cockroachdb' ? 'timestamp' : 'datetime';
    }

    static columns(driver: string): TableColumn[] {
        const date = AddTaskDatesAndEstimate1795110000000.dateType(driver);
        return [
            new TableColumn({ name: 'dueAt', type: date, isNullable: true }),
            new TableColumn({ name: 'startAt', type: date, isNullable: true }),
            new TableColumn({ name: 'estimateMinutes', type: 'int', isNullable: true }),
            new TableColumn({ name: 'dueSoonNotifiedAt', type: date, isNullable: true }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskDatesAndEstimate1795110000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;

        for (const column of C.columns(queryRunner.connection.options.type)) {
            // Re-read each step: sqlite recreates the table on an added column.
            const table = await queryRunner.getTable(C.TABLE);
            if (table?.findColumnByName(column.name)) continue;
            await queryRunner.addColumn(C.TABLE, column);
        }

        const table = await queryRunner.getTable(C.TABLE);
        if (table && !table.indices.some((index) => index.name === C.INDEX)) {
            await queryRunner.createIndex(
                C.TABLE,
                new TableIndex({ name: C.INDEX, columnNames: ['dueAt', 'dueSoonNotifiedAt'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskDatesAndEstimate1795110000000;
        const table = await queryRunner.getTable(C.TABLE);
        if (!table) return;
        const index = table.indices.find((entry) => entry.name === C.INDEX);
        if (index) await queryRunner.dropIndex(C.TABLE, index);
        for (const column of [...C.columns(queryRunner.connection.options.type)].reverse()) {
            const refreshed = await queryRunner.getTable(C.TABLE);
            const existing = refreshed?.findColumnByName(column.name);
            if (existing) await queryRunner.dropColumn(C.TABLE, existing);
        }
    }
}
