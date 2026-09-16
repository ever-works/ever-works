import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Connection health on the MCP server registry (AW-15, slot 00).
 *
 * Entity: `packages/agent/src/entities/mcp-server-connection.entity.ts`.
 *
 * ## Why these columns live on `mcp_server_connections`
 *
 * `mcp_server_connections` already IS the workspace registry of external MCP
 * servers, and every connection attempt already stamps `lastConnectedAt` /
 * `lastError` on it. Health is a property of that same row, so it is stored
 * beside those two columns rather than in a second table that would have to
 * be kept in step with the first.
 *
 * ## The four columns
 *
 *  1. `health` — `unknown` | `healthy` | `degraded` | `expired` |
 *     `unreachable`. NOT NULL DEFAULT `'unknown'`, so every existing row
 *     backfills to "not checked yet". Nothing is asserted that has not been
 *     observed: the first real attempt after deploy writes the true state.
 *  2. `healthCheckedAt` — when `health` was last written. NULL = never.
 *  3. `healthFailureCount` — consecutive failed attempts, the counter that
 *     separates `degraded` (1–2) from `unreachable` (3+). NOT NULL DEFAULT 0.
 *  4. `lastErrorCode` — the classified CODE for `lastError`
 *     (`credential_missing`, `credential_rejected`, …) so the Settings screen
 *     can explain a failure in the owner's language. A code, never a
 *     credential and never a server response body.
 *
 * Forward-only + idempotent (`findColumnByName` guards) and portable
 * `TableColumn` DDL, because production runs Postgres while CI and the e2e
 * stack run better-sqlite3. `down()` drops only what `up()` added, re-reading
 * the table between drops because sqlite rebuilds it on every column drop.
 */
export class AddMcpConnectionHealth1791150000000 implements MigrationInterface {
    name = 'AddMcpConnectionHealth1791150000000';

    private static readonly COLUMNS = [
        new TableColumn({
            name: 'health',
            type: 'varchar',
            length: '16',
            isNullable: false,
            default: "'unknown'",
        }),
        new TableColumn({ name: 'healthCheckedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'healthFailureCount', type: 'int', isNullable: false, default: 0 }),
        new TableColumn({ name: 'lastErrorCode', type: 'varchar', length: '48', isNullable: true }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('mcp_server_connections');
        if (!table) {
            // `1786840000000-CreateMcpServerConnections` has not run. TypeORM
            // runs migrations in timestamp order, so this cannot happen in a
            // normal boot; returning beats throwing on a hand-rolled database.
            return;
        }

        for (const column of AddMcpConnectionHealth1791150000000.COLUMNS) {
            if (!table.findColumnByName(column.name)) {
                await queryRunner.addColumn('mcp_server_connections', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of [...AddMcpConnectionHealth1791150000000.COLUMNS].reverse()) {
            const table = await queryRunner.getTable('mcp_server_connections');
            const existing = table?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn('mcp_server_connections', existing);
            }
        }
    }
}
