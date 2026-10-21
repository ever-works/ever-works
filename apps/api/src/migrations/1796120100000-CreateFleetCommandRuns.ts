import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Commands on computers (FL-12, CONTRACTS §4.4, §13 slot `1796120100000`).
 *
 * Entity: `packages/agent/src/entities/fleet-command-run.entity.ts` (new).
 *
 * ## `fleet_command_runs`
 *
 * One row per computer a Command ran on (or was refused on): when it started
 * and ended, the exit code, the status (`running · done · failed · timeout`;
 * `skipped-*` belong to FL-13's Schedules), how a run that ran failed
 * (`failedReason`), and the first and last 64 KiB of what it printed —
 * redacted before they are written. The machine keeps the full output of its
 * last 30 runs (`outputRef`).
 *
 * FL-12's own columns beside CONTRACTS §4.4's (lane-log decision 3, CONTRACTS
 * revision 11): `errorCode` / `errorHint` — the CONTRACTS §8 refusal of a
 * computer that would not run it (offline, no `--manage`, outside the
 * audience, an older node); `outputBytes` and `capped` — how much it printed,
 * and whether the machine stopped keeping output at 10 MiB. FL-13's slot
 * `1796130000000` adds `scheduledFor`.
 *
 * FK `commandId` → `fleet_commands` CASCADE. **No FK on `nodeId`**: the
 * history outlives the computer, as `fleet_audit.nodeId` does. Unique
 * `(commandId, nodeId, startedAt)`; `(nodeId, startedAt)` for a computer's
 * "Last command"; `status` for the link-lost sweep.
 *
 * Forward-only with per-step guards; portable `Table` DDL (Postgres in
 * production, better-sqlite3 in CI and e2e). `down()` removes exactly what
 * `up()` added.
 */
export class CreateFleetCommandRuns1796120100000 implements MigrationInterface {
    name = 'CreateFleetCommandRuns1796120100000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'uq_fleet_command_runs_command_node_started',
            columnNames: ['commandId', 'nodeId', 'startedAt'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_fleet_command_runs_node_started',
            columnNames: ['nodeId', 'startedAt'],
        }),
        new TableIndex({ name: 'idx_fleet_command_runs_status', columnNames: ['status'] }),
    ];

    private static readonly COMMAND_FK = new TableForeignKey({
        name: 'fk_fleet_command_runs_command',
        columnNames: ['commandId'],
        referencedTableName: 'fleet_commands',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('fleet_command_runs'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_command_runs',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'commandId', type: 'uuid' },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'startedAt', type: 'timestamp' },
                        { name: 'endedAt', type: 'timestamp', isNullable: true },
                        { name: 'exitCode', type: 'int', isNullable: true },
                        { name: 'status', type: 'varchar', length: '16', default: "'running'" },
                        { name: 'failedReason', type: 'varchar', length: '24', isNullable: true },
                        { name: 'errorCode', type: 'varchar', length: '32', isNullable: true },
                        { name: 'errorHint', type: 'text', isNullable: true },
                        { name: 'outputHead', type: 'text', isNullable: true },
                        { name: 'outputTail', type: 'text', isNullable: true },
                        { name: 'truncated', type: 'boolean', default: false },
                        { name: 'capped', type: 'boolean', default: false },
                        { name: 'outputBytes', type: 'int', default: 0 },
                        { name: 'outputRef', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        // Key before indexes (SQLite rebuilds the table to add a key).
        const table = await queryRunner.getTable('fleet_command_runs');
        if (
            table &&
            (await queryRunner.hasTable('fleet_commands')) &&
            !table.foreignKeys.some(
                (existing) =>
                    existing.name === CreateFleetCommandRuns1796120100000.COMMAND_FK.name,
            )
        ) {
            await queryRunner.createForeignKey(
                'fleet_command_runs',
                CreateFleetCommandRuns1796120100000.COMMAND_FK,
            );
        }
        for (const index of CreateFleetCommandRuns1796120100000.INDEXES) {
            const current = await queryRunner.getTable('fleet_command_runs');
            if (current && !current.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('fleet_command_runs', index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_command_runs')) {
            await queryRunner.dropTable('fleet_command_runs', true, true, true);
        }
    }
}
