import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Schedules on computers (FL-13, CONTRACTS §4.4, R-2, §13 slot `1796130000000`).
 *
 * Entities: `packages/agent/src/entities/fleet-command.entity.ts` and
 * `fleet-command-run.entity.ts` (FL-12's tables).
 *
 * A Command schedule is a `fleet_commands` row with a `cadence` — FL-12's
 * `CreateFleetCommands` already created `cadence`, `name`, `enabled`,
 * `lastRunAt` and `nextRunAt`, so this slot adds only the schedule state
 * CONTRACTS §4.4 assigns it:
 *
 *  - `fleet_commands.pausedAt` (timestamp) / `pausedReason` (varchar 24,
 *    `user · failures · breaker`, validated in code) — a pause that keeps the
 *    cadence;
 *  - `fleet_commands.syncGeneration` / `syncedGeneration` (int, default 0) —
 *    what the platform last sent the machine and what the machine applied;
 *  - `fleet_commands.deletedAt` (timestamp) — the soft delete that keeps a
 *    schedule's history readable for 30 days (spec U13);
 *  - `fleet_command_runs.scheduledFor` (timestamp) — the fire a run belongs
 *    to (null for Run now and one-off Commands);
 *
 * and two indexes: `idx_fleet_commands_schedule (userId, enabled)` and
 * `idx_fleet_command_runs_scheduled (commandId, scheduledFor)`. Plain
 * (not partial) indexes so the DDL is the same on Postgres and on the
 * better-sqlite3 CI / e2e stack.
 *
 * Every column is nullable or has a default, so existing rows are untouched.
 * Portable `TableColumn` DDL with a per-step guard (the table re-read before
 * every step), so a partially applied database converges. Forward-only:
 * `down` keeps the columns and their data.
 */
export class AddFleetCommandCadence1796130000000 implements MigrationInterface {
    name = 'AddFleetCommandCadence1796130000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const commandColumns: TableColumn[] = [
            new TableColumn({ name: 'pausedAt', type: 'timestamp', isNullable: true }),
            new TableColumn({ name: 'pausedReason', type: 'varchar', length: '24', isNullable: true }),
            new TableColumn({ name: 'syncGeneration', type: 'int', default: 0 }),
            new TableColumn({ name: 'syncedGeneration', type: 'int', default: 0 }),
            new TableColumn({ name: 'deletedAt', type: 'timestamp', isNullable: true }),
        ];
        for (const column of commandColumns) {
            const table = await queryRunner.getTable('fleet_commands');
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_commands', column);
            }
        }

        const runs = await queryRunner.getTable('fleet_command_runs');
        if (runs && !runs.findColumnByName('scheduledFor')) {
            await queryRunner.addColumn(
                'fleet_command_runs',
                new TableColumn({ name: 'scheduledFor', type: 'timestamp', isNullable: true }),
            );
        }

        // Indexes last: SQLite adds a column by rebuilding the table, and an
        // index created before a rebuild would be re-created by it.
        const indexes: Array<{ table: string; index: TableIndex }> = [
            {
                table: 'fleet_commands',
                index: new TableIndex({
                    name: 'idx_fleet_commands_schedule',
                    columnNames: ['userId', 'enabled'],
                }),
            },
            {
                table: 'fleet_command_runs',
                index: new TableIndex({
                    name: 'idx_fleet_command_runs_scheduled',
                    columnNames: ['commandId', 'scheduledFor'],
                }),
            },
        ];
        for (const { table: name, index } of indexes) {
            const table = await queryRunner.getTable(name);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(name, index);
            }
        }
    }

    /**
     * Intentionally forward-only. Rolling the application back leaves the
     * columns (all nullable or defaulted) and the two indexes in place for a
     * later roll-forward; FL-12's code never reads them.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
