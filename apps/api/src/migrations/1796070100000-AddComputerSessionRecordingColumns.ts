import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Desktop view & control (FL-07 P2, CONTRACTS R-9, §13 slot `1796070100000`).
 *
 * Entity: `packages/agent/src/entities/computer-session.entity.ts`. A Desktop
 * view becomes a `computer_sessions` row like an Agent's browser view, so the
 * caps count both on every API replica (FR-33), the control arbiter's one lock
 * per machine covers both (FR-36), and a recording has a row to hang on.
 *
 *  - `source` (varchar 8, NOT NULL, default `browser`) — `browser` · `desktop`;
 *    every existing row is a browser view, which is what the default says.
 *  - `displayId` (varchar 64, nullable) — the helper's display id.
 *  - `fleetSessionId` (uuid, nullable) — the FL-04 session the view sits beside
 *    (the split). Not a foreign key: a view's row outlives the session it sat
 *    beside (the `hostNodeId` rule of FL-16).
 *  - `recordingRef` (varchar 512, nullable) — the storage key prefix; never bytes.
 *  - `recordingBytes` (bigint, default 0), `recordingDurationMs` (int, default 0).
 *  - `recordingExpiresAt` (timestamp, nullable) — when the GC sweep deletes it.
 *  - `recordingStoppedReason` (varchar 24, nullable) — `size-cap` · `time-cap` ·
 *    `storage-failed` · `view-ended` · `deleted`.
 *  - `agentId` relaxed to nullable: a Desktop view opened from the computer page
 *    has no Agent. (TypeORM rebuilds the table on SQLite; Postgres drops NOT NULL.)
 *
 * Indexes `idx_computer_sessions_recording_expires` (the sweep) and
 * `idx_computer_sessions_fleet_session`. Portable `TableColumn` DDL, every step
 * guarded and re-read so a partially applied database converges. `down` drops
 * the indexes and the columns; `agentId` stays nullable (a desktop row would
 * otherwise make the rollback fail — forward-only for that one column).
 */
export class AddComputerSessionRecordingColumns1796070100000 implements MigrationInterface {
    name = 'AddComputerSessionRecordingColumns1796070100000';

    private static readonly COLUMNS: TableColumn[] = [
        new TableColumn({ name: 'source', type: 'varchar', length: '8', isNullable: false, default: "'browser'" }),
        new TableColumn({ name: 'displayId', type: 'varchar', length: '64', isNullable: true }),
        new TableColumn({ name: 'fleetSessionId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'recordingRef', type: 'varchar', length: '512', isNullable: true }),
        new TableColumn({ name: 'recordingBytes', type: 'bigint', isNullable: false, default: 0 }),
        new TableColumn({ name: 'recordingDurationMs', type: 'int', isNullable: false, default: 0 }),
        new TableColumn({ name: 'recordingExpiresAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'recordingStoppedReason', type: 'varchar', length: '24', isNullable: true }),
    ];

    private static readonly INDEXES: TableIndex[] = [
        new TableIndex({ name: 'idx_computer_sessions_recording_expires', columnNames: ['recordingExpiresAt'] }),
        new TableIndex({ name: 'idx_computer_sessions_fleet_session', columnNames: ['fleetSessionId'] }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const column of AddComputerSessionRecordingColumns1796070100000.COLUMNS) {
            const sessions = await queryRunner.getTable('computer_sessions');
            if (sessions && !sessions.findColumnByName(column.name)) {
                await queryRunner.addColumn('computer_sessions', column);
            }
        }
        const sessions = await queryRunner.getTable('computer_sessions');
        const agent = sessions?.findColumnByName('agentId');
        if (sessions && agent && !agent.isNullable) {
            const relaxed = agent.clone();
            relaxed.isNullable = true;
            await queryRunner.changeColumn('computer_sessions', agent, relaxed);
        }
        for (const index of AddComputerSessionRecordingColumns1796070100000.INDEXES) {
            const table = await queryRunner.getTable('computer_sessions');
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('computer_sessions', index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const index of AddComputerSessionRecordingColumns1796070100000.INDEXES) {
            const table = await queryRunner.getTable('computer_sessions');
            if (table?.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.dropIndex('computer_sessions', index.name!);
            }
        }
        for (const column of [...AddComputerSessionRecordingColumns1796070100000.COLUMNS].reverse()) {
            const table = await queryRunner.getTable('computer_sessions');
            if (table?.findColumnByName(column.name)) await queryRunner.dropColumn('computer_sessions', column.name);
        }
    }
}
