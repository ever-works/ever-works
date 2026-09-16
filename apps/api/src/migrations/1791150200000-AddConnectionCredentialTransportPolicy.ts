import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Connection credential transport (AW-15, slot 02).
 *
 * Entities: `packages/agent/src/entities/organization.entity.ts`,
 * `packages/agent/src/entities/mcp-server-connection.entity.ts`.
 *
 * ## 1. `organizations.connection_policy`
 *
 * Nullable TEXT (`simple-json`) holding `{ requireHttpsForCredentials? }` —
 * the organization setting "Require https for connection credentials". Same
 * shape and storage as `digest_settings` / `memory_consolidation` beside it.
 * NULL for every existing row means the setting is OFF, so an MCP connection
 * whose auth headers hold literal values keeps working over plain http
 * exactly as it did before (it is flagged `insecure_transport`). Nothing is
 * backfilled.
 *
 * ## 2. `mcp_server_connections.health` widened 16 → 32
 *
 * `1791150000000-AddMcpConnectionHealth` sized the column for the five
 * failure/success states. The `insecure_transport` warning is 18 characters,
 * which Postgres would reject in a varchar(16). Widening keeps every stored
 * value. better-sqlite3 does not enforce varchar length, so there is nothing
 * to change there; the column is only altered on Postgres, in place (a plain
 * `ALTER COLUMN ... TYPE`, never a drop-and-add that would lose data).
 *
 * Forward-only and idempotent. `down()` drops the setting column and, on
 * Postgres, narrows `health` back to 16 after turning any
 * `insecure_transport` value into `healthy` (both mean "the last attempt
 * worked"), so the narrowing cannot fail on existing rows.
 */
export class AddConnectionCredentialTransportPolicy1791150200000 implements MigrationInterface {
    name = 'AddConnectionCredentialTransportPolicy1791150200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (
            (await queryRunner.hasTable('organizations')) &&
            !(await queryRunner.hasColumn('organizations', 'connection_policy'))
        ) {
            await queryRunner.addColumn(
                'organizations',
                new TableColumn({ name: 'connection_policy', type: 'text', isNullable: true }),
            );
        }

        if (!this.isPostgres(queryRunner)) return;
        const table = await queryRunner.getTable('mcp_server_connections');
        const health = table?.findColumnByName('health');
        if (health && Number(health.length || 0) > 0 && Number(health.length) < 32) {
            await queryRunner.query(
                `ALTER TABLE "mcp_server_connections" ALTER COLUMN "health" TYPE varchar(32)`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (
            (await queryRunner.hasTable('organizations')) &&
            (await queryRunner.hasColumn('organizations', 'connection_policy'))
        ) {
            await queryRunner.dropColumn('organizations', 'connection_policy');
        }

        if (!this.isPostgres(queryRunner)) return;
        const table = await queryRunner.getTable('mcp_server_connections');
        const health = table?.findColumnByName('health');
        if (health && Number(health.length) > 16) {
            await queryRunner.query(
                `UPDATE "mcp_server_connections" SET "health" = 'healthy' WHERE "health" = 'insecure_transport'`,
            );
            await queryRunner.query(
                `ALTER TABLE "mcp_server_connections" ALTER COLUMN "health" TYPE varchar(16)`,
            );
        }
    }

    private isPostgres(queryRunner: QueryRunner): boolean {
        return queryRunner.connection.options.type === 'postgres';
    }
}
