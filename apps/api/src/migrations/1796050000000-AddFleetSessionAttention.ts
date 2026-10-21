import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Session status, attention & board (FL-05, CONTRACTS §4.2, §5, §13 slot `1796050000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-session.entity.ts`.
 *
 * The five FL-05 columns of `fleet_sessions`, all nullable so every existing
 * row stays valid:
 *
 *   - `attention`      text (TypeORM `simple-json`) — the open "needs you" edge or the unread `finished` marker;
 *   - `stateChangedAt` timestamp — when `state` last changed (board ordering), back-filled from
 *                      `lastActivityAt`, else `createdAt`;
 *   - `hooks`          text (`simple-json`) — what the node injected;
 *   - `lastEvidence`   text (`simple-json`) — why the state is what it is;
 *   - `boundaryUntil`  timestamp — the session-boundary window.
 *
 * Two indexes for the board: `(userId, state, stateChangedAt)` and
 * `(organizationId, state, stateChangedAt)`.
 *
 * "jsonb" in CONTRACTS is stored as `simple-json` text, as `fleet_nodes.modelThrottles`
 * is, so one migration runs on Postgres (production) and better-sqlite3 (CI).
 * Forward-only with per-step guards (every column and index is checked first,
 * so a partial earlier run completes); portable `TableColumn` DDL; `down()`
 * reverses `up()`. No drops of anything that existed before.
 */
export class AddFleetSessionAttention1796050000000 implements MigrationInterface {
    name = 'AddFleetSessionAttention1796050000000';

    private static readonly TABLE = 'fleet_sessions';

    private static readonly COLUMNS: TableColumn[] = [
        new TableColumn({ name: 'attention', type: 'text', isNullable: true }),
        new TableColumn({ name: 'stateChangedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'hooks', type: 'text', isNullable: true }),
        new TableColumn({ name: 'lastEvidence', type: 'text', isNullable: true }),
        new TableColumn({ name: 'boundaryUntil', type: 'timestamp', isNullable: true }),
    ];

    private static readonly INDEXES: TableIndex[] = [
        new TableIndex({
            name: 'idx_fleet_sessions_user_state_changed',
            columnNames: ['userId', 'state', 'stateChangedAt'],
        }),
        new TableIndex({
            name: 'idx_fleet_sessions_org_state_changed',
            columnNames: ['organizationId', 'state', 'stateChangedAt'],
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(AddFleetSessionAttention1796050000000.TABLE);
        // FL-04's `CreateFleetSessions` makes the table; without it there is nothing to extend.
        if (!table) return;
        let addedStateChangedAt = false;
        for (const column of AddFleetSessionAttention1796050000000.COLUMNS) {
            if (!table.findColumnByName(column.name)) {
                await queryRunner.addColumn(AddFleetSessionAttention1796050000000.TABLE, column);
                if (column.name === 'stateChangedAt') addedStateChangedAt = true;
            }
        }
        if (addedStateChangedAt) {
            // Every existing row gets the best "last moved" it has (portable SQL).
            await queryRunner.query(
                `UPDATE "fleet_sessions" SET "stateChangedAt" = COALESCE("lastActivityAt", "createdAt") WHERE "stateChangedAt" IS NULL`,
            );
        }
        const fresh = await queryRunner.getTable(AddFleetSessionAttention1796050000000.TABLE);
        for (const index of AddFleetSessionAttention1796050000000.INDEXES) {
            if (fresh && !fresh.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(AddFleetSessionAttention1796050000000.TABLE, index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(AddFleetSessionAttention1796050000000.TABLE);
        if (!table) return;
        for (const index of AddFleetSessionAttention1796050000000.INDEXES) {
            const existing = table.indices.find((entry) => entry.name === index.name);
            if (existing) await queryRunner.dropIndex(AddFleetSessionAttention1796050000000.TABLE, existing);
        }
        for (const column of [...AddFleetSessionAttention1796050000000.COLUMNS].reverse()) {
            if (table.findColumnByName(column.name)) {
                await queryRunner.dropColumn(AddFleetSessionAttention1796050000000.TABLE, column.name);
            }
        }
    }
}
