import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Sessions on computers (FL-04 P2, CONTRACTS §4.2, R-1, §13 slot `1796040100000`).
 *
 * Entity: `packages/agent/src/entities/agent-run.entity.ts` (`fleetSessionId`,
 * trigger kind `session`).
 *
 * An Agent session owns exactly one Run (trigger `session`); the Run carries
 * the session's cost, receipts and lifecycle, and ending either ends both.
 * `agent_runs.fleetSessionId` is the Run's side of that link (the session's is
 * `fleet_sessions.agentRunId`, already unique where set since
 * `1796040000000-CreateFleetSessions`):
 *
 *   - one nullable `uuid` column — every existing run keeps NULL;
 *   - one index, `idx_agent_runs_fleet_session`, for "the run of this session";
 *   - a FK to `fleet_sessions.id` ON DELETE SET NULL, so removing a session row
 *     never erases the run (its cost and receipts stay).
 *
 * The trigger kind is a `varchar(16)` with no check constraint, so `session`
 * needs no DDL. Forward-only with per-step guards; portable `TableColumn` DDL
 * (Postgres in production, better-sqlite3 in CI); `down()` reverses `up()`.
 */
export class AddAgentRunFleetSessionId1796040100000 implements MigrationInterface {
    name = 'AddAgentRunFleetSessionId1796040100000';

    private static readonly INDEX = new TableIndex({
        name: 'idx_agent_runs_fleet_session',
        columnNames: ['fleetSessionId'],
    });

    private static readonly FK_NAME = 'fk_agent_runs_fleet_session';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        if (!table.findColumnByName('fleetSessionId')) {
            await queryRunner.addColumn(
                'agent_runs',
                new TableColumn({ name: 'fleetSessionId', type: 'uuid', isNullable: true }),
            );
        }
        const fresh = await queryRunner.getTable('agent_runs');
        if (
            fresh &&
            !fresh.indices.some(
                (index) => index.name === AddAgentRunFleetSessionId1796040100000.INDEX.name,
            )
        ) {
            await queryRunner.createIndex(
                'agent_runs',
                AddAgentRunFleetSessionId1796040100000.INDEX,
            );
        }
        const withIndex = await queryRunner.getTable('agent_runs');
        const sessions = await queryRunner.hasTable('fleet_sessions');
        if (
            sessions &&
            withIndex &&
            !withIndex.foreignKeys.some(
                (fk) => fk.name === AddAgentRunFleetSessionId1796040100000.FK_NAME,
            )
        ) {
            await queryRunner.createForeignKey(
                'agent_runs',
                new TableForeignKey({
                    name: AddAgentRunFleetSessionId1796040100000.FK_NAME,
                    columnNames: ['fleetSessionId'],
                    referencedTableName: 'fleet_sessions',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        const fk = table.foreignKeys.find(
            (entry) => entry.name === AddAgentRunFleetSessionId1796040100000.FK_NAME,
        );
        if (fk) await queryRunner.dropForeignKey('agent_runs', fk);
        const index = table.indices.find(
            (entry) => entry.name === AddAgentRunFleetSessionId1796040100000.INDEX.name,
        );
        if (index) await queryRunner.dropIndex('agent_runs', index);
        if (table.findColumnByName('fleetSessionId'))
            await queryRunner.dropColumn('agent_runs', 'fleetSessionId');
    }
}
