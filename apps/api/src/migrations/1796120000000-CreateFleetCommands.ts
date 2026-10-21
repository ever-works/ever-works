import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Commands on computers (FL-12, CONTRACTS §4.4, R-2, R-11, §13 slot `1796120000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-command.entity.ts` (new).
 *
 * ## `fleet_commands`
 *
 * One row per command line sent to one or more computers. A one-off Command
 * (`cadence` NULL) is immediate — delivered over the node link and never
 * queued; each computer's execution is a row of `fleet_command_runs`
 * (`1796120100000`). The Schedule columns (`cadence`, `name`, `enabled`,
 * `lastRunAt`, `nextRunAt`) are created here, as CONTRACTS §4.4 says, so FL-13
 * adds Schedules without a second table; FL-13's slot `1796130000000` adds the
 * rest (`pausedAt`, `pausedReason`, `syncGeneration`, `syncedGeneration`,
 * `deletedAt`).
 *
 * `nodeIds` and `cadence` are `simple-json` text (CONTRACTS §4 storage types),
 * enums are `varchar` validated in code. FK `userId` → `users` CASCADE: a
 * Command means nothing without its person. No FK into `fleet_nodes`: the
 * node ids are a JSON list, and the history outlives a removed computer.
 *
 * Forward-only with per-step guards (`hasTable` / index and FK names), so a
 * partially applied database converges; portable `Table` DDL because
 * production runs Postgres while CI and the e2e stack run better-sqlite3.
 * `down()` removes exactly what `up()` added.
 */
export class CreateFleetCommands1796120000000 implements MigrationInterface {
    name = 'CreateFleetCommands1796120000000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'idx_fleet_commands_user_created',
            columnNames: ['userId', 'createdAt'],
        }),
        new TableIndex({ name: 'idx_fleet_commands_user_state', columnNames: ['userId', 'state'] }),
    ];

    private static readonly USER_FK = new TableForeignKey({
        name: 'fk_fleet_commands_user',
        columnNames: ['userId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('fleet_commands'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_commands',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'nodeIds', type: 'text' },
                        { name: 'command', type: 'text' },
                        { name: 'commandRedacted', type: 'boolean', default: false },
                        { name: 'cwd', type: 'text', isNullable: true },
                        { name: 'timeoutSec', type: 'int', default: 600 },
                        { name: 'cadence', type: 'text', isNullable: true },
                        { name: 'name', type: 'text', isNullable: true },
                        { name: 'enabled', type: 'boolean', default: true },
                        { name: 'requestedBy', type: 'varchar', length: '8', default: "'user'" },
                        { name: 'state', type: 'varchar', length: '16', default: "'queued'" },
                        { name: 'lastRunAt', type: 'timestamp', isNullable: true },
                        { name: 'nextRunAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        // Key before indexes: SQLite adds a key by rebuilding the table, and the
        // indexes are created last so a rebuild never re-creates them.
        const table = await queryRunner.getTable('fleet_commands');
        if (
            table &&
            !table.foreignKeys.some(
                (existing) => existing.name === CreateFleetCommands1796120000000.USER_FK.name,
            )
        ) {
            await queryRunner.createForeignKey(
                'fleet_commands',
                CreateFleetCommands1796120000000.USER_FK,
            );
        }
        for (const index of CreateFleetCommands1796120000000.INDEXES) {
            const current = await queryRunner.getTable('fleet_commands');
            if (current && !current.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('fleet_commands', index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_commands')) {
            await queryRunner.dropTable('fleet_commands', true, true, true);
        }
    }
}
