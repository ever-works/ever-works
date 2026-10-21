import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableCheck,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Sessions on computers (FL-04, CONTRACTS §4.2, R-9, §13 slot `1796040000000`).
 *
 * Entities:
 *   `packages/agent/src/entities/fleet-session.entity.ts` (new)
 *   `packages/agent/src/entities/terminal-transcript-chunk.entity.ts` (session key)
 *   `packages/agent/src/entities/fleet-node.entity.ts` (`sessionDaemon`)
 *
 * ## `fleet_sessions`
 *
 * One row per persistent interactive process on a Node — an agent CLI or a
 * shell its session daemon owns. The process outlives the node process, the
 * link and every browser tab; this row is how the platform lists, attaches
 * to, renames, ends and restarts it from anywhere. Terminal bytes never land
 * here except `lastScreen` (the last 2 000 lines the daemon kept when the
 * session ended, plain text, bounded). `(nodeId, daemonSessionId)` is unique:
 * it is how every fact the node reports finds its row.
 *
 * FKs: `nodeId` → `fleet_nodes` and `userId` → `users` CASCADE (a session
 * means nothing without its machine and its person); `agentId` → `agents`,
 * `agentRunId` → `agent_runs` and `restartOfSessionId` → `fleet_sessions`
 * SET NULL, so removing an Agent, a Run or an older session never erases the
 * record that a process ran on a machine. `checkoutId` has no FK yet:
 * `fleet_checkouts` arrives with FL-14.
 *
 * ## `terminal_transcript_chunks` — the session key (CONTRACTS R-9)
 *
 * A terminal recording of a session lives beside Run transcripts: a nullable
 * `fleetSessionId` (FK CASCADE), `runId` relaxed to nullable, a check that one
 * of the two is set, and `(fleetSessionId, seq)` unique where set. No row is
 * rewritten: every existing chunk has a `runId`, so it satisfies the check as
 * it stands. Relaxing `runId` clones the live column and flips only
 * `isNullable`, so the driver issues `DROP NOT NULL` (Postgres) or rebuilds
 * the table with its data (SQLite) — never a drop-and-re-add of the column.
 *
 * ## `fleet_nodes.sessionDaemon`
 *
 * The daemon block of the heartbeat (CONTRACTS §1.1) — `{ state, reason?,
 * sessions, storage?, hooks? }` as `simple-json` text — so the Sessions tab
 * can say "the session daemon is not running on build-01 — <the node's own
 * reason>" while the node is offline too. NULL = never reported.
 *
 * Forward-only with per-step guards (`hasTable` / `findColumnByName` /
 * index, check and FK names), so a partially applied database converges;
 * portable `Table`/`TableColumn` DDL because production runs Postgres while
 * CI and the e2e stack run better-sqlite3. `down()` removes what `up()`
 * added, in reverse.
 */
export class CreateFleetSessions1796040000000 implements MigrationInterface {
    name = 'CreateFleetSessions1796040000000';

    private static readonly SESSION_INDEXES = [
        new TableIndex({ name: 'idx_fleet_sessions_node_state', columnNames: ['nodeId', 'state'] }),
        new TableIndex({
            name: 'idx_fleet_sessions_user_state_activity',
            columnNames: ['userId', 'state', 'lastActivityAt'],
        }),
        new TableIndex({
            name: 'idx_fleet_sessions_org_state',
            columnNames: ['organizationId', 'state'],
        }),
        new TableIndex({
            name: 'uq_fleet_sessions_agent_run',
            columnNames: ['agentRunId'],
            isUnique: true,
            where: '"agentRunId" IS NOT NULL',
        }),
        new TableIndex({
            name: 'uq_fleet_sessions_node_daemon',
            columnNames: ['nodeId', 'daemonSessionId'],
            isUnique: true,
        }),
    ];

    private static readonly SESSION_FKS = [
        new TableForeignKey({
            name: 'fk_fleet_sessions_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_fleet_sessions_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_fleet_sessions_agent',
            columnNames: ['agentId'],
            referencedTableName: 'agents',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
        new TableForeignKey({
            name: 'fk_fleet_sessions_run',
            columnNames: ['agentRunId'],
            referencedTableName: 'agent_runs',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
        new TableForeignKey({
            name: 'fk_fleet_sessions_restart_of',
            columnNames: ['restartOfSessionId'],
            referencedTableName: 'fleet_sessions',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
    ];

    private static readonly CHUNK_SESSION_INDEX = new TableIndex({
        name: 'uq_terminal_transcript_chunks_session_seq',
        columnNames: ['fleetSessionId', 'seq'],
        isUnique: true,
        where: '"fleetSessionId" IS NOT NULL',
    });

    private static readonly CHUNK_KEY_CHECK = new TableCheck({
        name: 'chk_terminal_transcript_chunks_key',
        expression: '"runId" IS NOT NULL OR "fleetSessionId" IS NOT NULL',
    });

    private static readonly CHUNK_SESSION_FK = new TableForeignKey({
        name: 'fk_terminal_transcript_chunks_session',
        columnNames: ['fleetSessionId'],
        referencedTableName: 'fleet_sessions',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
    });

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        // 1. fleet_nodes.sessionDaemon
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('sessionDaemon')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'sessionDaemon', type: 'text', isNullable: true }),
            );
        }

        // 2. fleet_sessions
        if (!(await queryRunner.hasTable('fleet_sessions'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_sessions',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'kind', type: 'varchar', length: '8' },
                        { name: 'provider', type: 'varchar', length: '64' },
                        { name: 'agentId', type: 'uuid', isNullable: true },
                        { name: 'agentRunId', type: 'uuid', isNullable: true },
                        { name: 'checkoutId', type: 'uuid', isNullable: true },
                        { name: 'cwd', type: 'text' },
                        { name: 'title', type: 'varchar', length: '200' },
                        { name: 'state', type: 'varchar', length: '16', default: "'starting'" },
                        { name: 'outcome', type: 'varchar', length: '16', isNullable: true },
                        { name: 'daemonSessionId', type: 'varchar', length: '64' },
                        {
                            name: 'providerSessionId',
                            type: 'varchar',
                            length: '128',
                            isNullable: true,
                        },
                        { name: 'firstMessage', type: 'text', isNullable: true },
                        { name: 'lastScreen', type: 'text', isNullable: true },
                        { name: 'restartOfSessionId', type: 'uuid', isNullable: true },
                        { name: 'startedBy', type: 'varchar', length: '80' },
                        { name: 'lastActivityAt', type: 'timestamp', isNullable: true },
                        { name: 'startedAt', type: 'timestamp', isNullable: true },
                        { name: 'endedAt', type: 'timestamp', isNullable: true },
                        { name: 'endedReason', type: 'varchar', length: '16', isNullable: true },
                        { name: 'exitCode', type: 'int', isNullable: true },
                        {
                            name: 'recordingState',
                            type: 'varchar',
                            length: '12',
                            default: "'off'",
                        },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        // Keys before indexes: SQLite adds a key by rebuilding the table, and
        // the indexes are created last so a rebuild never re-creates them.
        for (const foreignKey of CreateFleetSessions1796040000000.SESSION_FKS) {
            await this.ensureForeignKey(queryRunner, 'fleet_sessions', foreignKey);
        }
        for (const index of CreateFleetSessions1796040000000.SESSION_INDEXES) {
            await this.ensureIndex(queryRunner, 'fleet_sessions', index);
        }

        // 3. terminal_transcript_chunks — the session key (R-9).
        if (await queryRunner.hasTable('terminal_transcript_chunks')) {
            let chunks = await queryRunner.getTable('terminal_transcript_chunks');
            if (chunks && !chunks.findColumnByName('fleetSessionId')) {
                await queryRunner.addColumn(
                    'terminal_transcript_chunks',
                    new TableColumn({ name: 'fleetSessionId', type: 'uuid', isNullable: true }),
                );
            }
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            const runId = chunks?.findColumnByName('runId');
            if (chunks && runId && !runId.isNullable) {
                const relaxed = runId.clone();
                relaxed.isNullable = true;
                await queryRunner.changeColumn(chunks, runId, relaxed);
            }
            await this.ensureForeignKey(
                queryRunner,
                'terminal_transcript_chunks',
                CreateFleetSessions1796040000000.CHUNK_SESSION_FK,
            );
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            if (
                chunks &&
                !chunks.checks.some(
                    (check) => check.name === CreateFleetSessions1796040000000.CHUNK_KEY_CHECK.name,
                )
            ) {
                await queryRunner.createCheckConstraint(
                    'terminal_transcript_chunks',
                    CreateFleetSessions1796040000000.CHUNK_KEY_CHECK,
                );
            }
            await this.ensureIndex(
                queryRunner,
                'terminal_transcript_chunks',
                CreateFleetSessions1796040000000.CHUNK_SESSION_INDEX,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('terminal_transcript_chunks')) {
            let chunks = await queryRunner.getTable('terminal_transcript_chunks');
            const foreignKey = chunks?.foreignKeys.find(
                (existing) =>
                    existing.name === CreateFleetSessions1796040000000.CHUNK_SESSION_FK.name,
            );
            if (foreignKey)
                await queryRunner.dropForeignKey('terminal_transcript_chunks', foreignKey);
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            if (
                chunks?.indices.some(
                    (index) =>
                        index.name === CreateFleetSessions1796040000000.CHUNK_SESSION_INDEX.name,
                )
            ) {
                await queryRunner.dropIndex(
                    'terminal_transcript_chunks',
                    CreateFleetSessions1796040000000.CHUNK_SESSION_INDEX.name!,
                );
            }
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            const check = chunks?.checks.find(
                (existing) =>
                    existing.name === CreateFleetSessions1796040000000.CHUNK_KEY_CHECK.name,
            );
            if (check) await queryRunner.dropCheckConstraint('terminal_transcript_chunks', check);
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            const sessionColumn = chunks?.findColumnByName('fleetSessionId');
            if (sessionColumn) {
                await queryRunner.dropColumn('terminal_transcript_chunks', sessionColumn);
            }
            // `runId` returns to NOT NULL only when no row would break it: a
            // rollback never deletes a recording to make a constraint fit.
            const [{ count }] = (await queryRunner.query(
                `SELECT COUNT(*) AS "count" FROM "terminal_transcript_chunks" WHERE "runId" IS NULL`,
            )) as Array<{ count: number | string }>;
            chunks = await queryRunner.getTable('terminal_transcript_chunks');
            const runId = chunks?.findColumnByName('runId');
            if (chunks && runId && runId.isNullable && Number(count) === 0) {
                const strict = runId.clone();
                strict.isNullable = false;
                await queryRunner.changeColumn(chunks, runId, strict);
            }
        }
        if (await queryRunner.hasTable('fleet_sessions')) {
            await queryRunner.dropTable('fleet_sessions', true, true, true);
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        const daemon = nodes?.findColumnByName('sessionDaemon');
        if (daemon) await queryRunner.dropColumn('fleet_nodes', daemon);
    }

    private async ensureIndex(
        queryRunner: QueryRunner,
        tableName: string,
        index: TableIndex,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (table && !table.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex(tableName, index);
        }
    }

    private async ensureForeignKey(
        queryRunner: QueryRunner,
        tableName: string,
        foreignKey: TableForeignKey,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
            await queryRunner.createForeignKey(tableName, foreignKey);
        }
    }
}
