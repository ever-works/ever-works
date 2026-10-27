import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS §4.9, R-17, §13 slot
 * `1796100000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-port-tunnel.entity.ts` (new).
 *
 * ## `fleet_port_tunnels`
 *
 * One row per preview tunnel: a time-boxed grant for one person to reach one
 * port on one Node through their own browser. Columns are CONTRACTS §4.9
 * (revision 4): `ownerUserId`, `nodeId`, `port`, `previewHost`, `state`
 * (`open · closed`), `openedAt`, `lastRequestAt`, `closedAt`, `closedReason`
 * (`idle · hard · user · node-offline · kill-switch · drain · link-closed`,
 * validated in code), `requestCount`, `bytesIn`, `bytesOut`, `auditOpenId`,
 * `auditCloseId`.
 *
 * FKs (plan §4.1): `nodeId` → `fleet_nodes` CASCADE (a tunnel is a grant, not
 * history — the audit rows keep the history); `ownerUserId` → `users` CASCADE
 * (a grant for nobody means nothing).
 *
 * Forward-only with per-step guards (`hasTable` / index and FK names), so a
 * partially applied database converges; portable `Table` DDL because
 * production runs Postgres while CI and the e2e stack run better-sqlite3.
 * `down()` drops exactly what `up()` added.
 */
export class CreateFleetPortTunnels1796100000000 implements MigrationInterface {
    name = 'CreateFleetPortTunnels1796100000000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'idx_fleet_port_tunnels_owner_state',
            columnNames: ['ownerUserId', 'state'],
        }),
        new TableIndex({
            name: 'idx_fleet_port_tunnels_node_state',
            columnNames: ['nodeId', 'state'],
        }),
        new TableIndex({ name: 'idx_fleet_port_tunnels_opened', columnNames: ['openedAt'] }),
    ];

    private static readonly FKS = [
        new TableForeignKey({
            name: 'fk_fleet_port_tunnels_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_fleet_port_tunnels_owner',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('fleet_port_tunnels'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_port_tunnels',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'ownerUserId', type: 'uuid' },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'port', type: 'int' },
                        { name: 'previewHost', type: 'varchar', length: '255' },
                        { name: 'state', type: 'varchar', length: '8', default: "'open'" },
                        { name: 'openedAt', type: 'timestamp' },
                        { name: 'lastRequestAt', type: 'timestamp', isNullable: true },
                        { name: 'closedAt', type: 'timestamp', isNullable: true },
                        { name: 'closedReason', type: 'varchar', length: '16', isNullable: true },
                        { name: 'requestCount', type: 'int', default: 0 },
                        { name: 'bytesIn', type: 'bigint', default: 0 },
                        { name: 'bytesOut', type: 'bigint', default: 0 },
                        { name: 'auditOpenId', type: 'uuid', isNullable: true },
                        { name: 'auditCloseId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        // Keys before indexes: SQLite adds a key by rebuilding the table, and
        // the indexes are created last so a rebuild never re-creates them.
        for (const foreignKey of CreateFleetPortTunnels1796100000000.FKS) {
            await this.ensureForeignKey(queryRunner, foreignKey);
        }
        for (const index of CreateFleetPortTunnels1796100000000.INDEXES) {
            await this.ensureIndex(queryRunner, index);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_port_tunnels')) {
            await queryRunner.dropTable('fleet_port_tunnels', true, true, true);
        }
    }

    private async ensureIndex(queryRunner: QueryRunner, index: TableIndex): Promise<void> {
        const table = await queryRunner.getTable('fleet_port_tunnels');
        if (table && !table.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex('fleet_port_tunnels', index);
        }
    }

    private async ensureForeignKey(
        queryRunner: QueryRunner,
        foreignKey: TableForeignKey,
    ): Promise<void> {
        const table = await queryRunner.getTable('fleet_port_tunnels');
        if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
            await queryRunner.createForeignKey('fleet_port_tunnels', foreignKey);
        }
    }
}
