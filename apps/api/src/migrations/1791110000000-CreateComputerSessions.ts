import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Agent computers, phase 1 (watch) — the `computer_sessions` and
 * `node_agent_profiles` tables, plus seven columns on `fleet_nodes`.
 *
 * Entities:
 *   `packages/agent/src/entities/computer-session.entity.ts`
 *   `packages/agent/src/entities/node-agent-profile.entity.ts`
 *   `packages/agent/src/entities/fleet-node.entity.ts` (control policy + lock)
 *
 * ## `computer_sessions`
 *
 * One row per live view an owner opened. The pictures never touch it —
 * they ride the in-memory relay — so the row holds only what must survive a
 * replica restart: who opened which Node for which Agent, the Run it was
 * bound to, the counters behind the bandwidth readout, and why it ended.
 *
 * ## `node_agent_profiles`
 *
 * One row per (Node, Agent), UNIQUE: the isolation guarantee is that two
 * Agents on one machine never share a profile. `profileKey` is an opaque
 * id the Node maps to a directory; no filesystem path is ever stored.
 *
 * ## `fleet_nodes` — policy, recording opt-in, and the control lock
 *
 * `controlPolicy` defaults to `'owner'`, `recordWatchSessions` to false and
 * `recordingRetentionDays` to 14, so every existing machine backfills to the
 * most private setting. The four `controlHolder*` columns are the
 * compare-and-set lock one controller per machine is built on; they land
 * NULL, which is "nobody holds control" — the only honest value for a
 * machine nobody could take control of before this migration.
 *
 * FKs: `userId` → `users`, `nodeId` → `fleet_nodes` and `agentId` →
 * `agents` CASCADE (a session or a profile means nothing without all
 * three). `runId` → `agent_runs` SET NULL: deleting a Run must not erase the
 * record that someone watched the machine it ran on.
 *
 * Forward-only + idempotent (`hasTable` / `findColumnByName` / index-name
 * guards), portable `Table`/`TableColumn` DDL because production runs
 * Postgres while CI runs better-sqlite3. `down()` drops exactly what `up()`
 * added, in reverse.
 */
export class CreateComputerSessions1791110000000 implements MigrationInterface {
    name = 'CreateComputerSessions1791110000000';

    private static readonly NODE_COLUMNS = [
        new TableColumn({
            name: 'controlPolicy',
            type: 'varchar',
            length: '24',
            default: "'owner'",
        }),
        new TableColumn({ name: 'recordWatchSessions', type: 'boolean', default: false }),
        new TableColumn({ name: 'recordingRetentionDays', type: 'int', default: 14 }),
        new TableColumn({ name: 'controlHolderUserId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'controlHolderSessionId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'controlHeldSince', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'controlExpiresAt', type: 'timestamp', isNullable: true }),
    ];

    private static readonly SESSION_INDEXES = [
        new TableIndex({
            name: 'idx_computer_sessions_user_status',
            columnNames: ['userId', 'status'],
        }),
        new TableIndex({
            name: 'idx_computer_sessions_node_status',
            columnNames: ['nodeId', 'status'],
        }),
        new TableIndex({
            name: 'idx_computer_sessions_agent',
            columnNames: ['agentId', 'createdAt'],
        }),
        new TableIndex({ name: 'idx_computer_sessions_run', columnNames: ['runId'] }),
    ];

    private static readonly PROFILE_INDEXES = [
        new TableIndex({
            name: 'uq_node_agent_profiles_node_agent',
            columnNames: ['nodeId', 'agentId'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_node_agent_profiles_user_agent',
            columnNames: ['userId', 'agentId'],
        }),
    ];

    private static readonly SESSION_FKS = [
        new TableForeignKey({
            name: 'fk_computer_sessions_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_computer_sessions_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_computer_sessions_agent',
            columnNames: ['agentId'],
            referencedTableName: 'agents',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_computer_sessions_run',
            columnNames: ['runId'],
            referencedTableName: 'agent_runs',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
    ];

    private static readonly PROFILE_FKS = [
        new TableForeignKey({
            name: 'fk_node_agent_profiles_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_node_agent_profiles_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_node_agent_profiles_agent',
            columnNames: ['agentId'],
            referencedTableName: 'agents',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes) {
            for (const column of CreateComputerSessions1791110000000.NODE_COLUMNS) {
                if (!nodes.findColumnByName(column.name)) {
                    await queryRunner.addColumn('fleet_nodes', column);
                }
            }
        }

        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('computer_sessions'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'computer_sessions',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'agentId', type: 'uuid' },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'openedByUserId', type: 'uuid' },
                        { name: 'runId', type: 'uuid', isNullable: true },
                        { name: 'fleetJobId', type: 'uuid', isNullable: true },
                        { name: 'channels', type: 'text' },
                        {
                            name: 'activeChannel',
                            type: 'varchar',
                            length: '16',
                            default: "'screen'",
                        },
                        { name: 'quality', type: 'varchar', length: '8', default: "'sharp'" },
                        { name: 'status', type: 'varchar', length: '16', default: "'requested'" },
                        { name: 'closeReason', type: 'varchar', length: '24', isNullable: true },
                        { name: 'controlSpans', type: 'text', isNullable: true },
                        { name: 'recorded', type: 'boolean', default: false },
                        {
                            name: 'recordingSkippedReason',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        { name: 'frameCount', type: 'int', default: 0 },
                        { name: 'bytesOut', type: 'bigint', default: 0 },
                        { name: 'lastFrameAt', type: 'timestamp', isNullable: true },
                        { name: 'lastInputAt', type: 'timestamp', isNullable: true },
                        { name: 'startedAt', type: 'timestamp', isNullable: true },
                        { name: 'endedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        if (!(await queryRunner.hasTable('node_agent_profiles'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'node_agent_profiles',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'agentId', type: 'uuid' },
                        { name: 'profileKey', type: 'varchar', length: '64' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'lastUsedAt', type: 'timestamp', isNullable: true },
                        { name: 'signedInSiteCount', type: 'int', default: 0 },
                        { name: 'diskBytes', type: 'bigint', default: 0 },
                        { name: 'lastResetAt', type: 'timestamp', isNullable: true },
                        { name: 'lastResetByUserId', type: 'uuid', isNullable: true },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndexes(
            queryRunner,
            'computer_sessions',
            CreateComputerSessions1791110000000.SESSION_INDEXES,
        );
        await this.ensureIndexes(
            queryRunner,
            'node_agent_profiles',
            CreateComputerSessions1791110000000.PROFILE_INDEXES,
        );
        await this.ensureForeignKeys(
            queryRunner,
            'computer_sessions',
            CreateComputerSessions1791110000000.SESSION_FKS,
        );
        await this.ensureForeignKeys(
            queryRunner,
            'node_agent_profiles',
            CreateComputerSessions1791110000000.PROFILE_FKS,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('node_agent_profiles')) {
            await queryRunner.dropTable('node_agent_profiles', true, true, true);
        }
        if (await queryRunner.hasTable('computer_sessions')) {
            await queryRunner.dropTable('computer_sessions', true, true, true);
        }
        // `dropColumn` (not raw SQL) and a fresh `getTable` per drop: the
        // query runner rebuilds the table on drivers that cannot drop a
        // column in place, and each rebuild replaces the Table object.
        for (const column of [...CreateComputerSessions1791110000000.NODE_COLUMNS].reverse()) {
            const table = await queryRunner.getTable('fleet_nodes');
            const existing = table?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn('fleet_nodes', existing);
            }
        }
    }

    private async ensureIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of indexes) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(tableName, index);
            }
        }
    }

    private async ensureForeignKeys(
        queryRunner: QueryRunner,
        tableName: string,
        foreignKeys: readonly TableForeignKey[],
    ): Promise<void> {
        for (const foreignKey of foreignKeys) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey(tableName, foreignKey);
            }
        }
    }
}
