import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Checkouts on computers (FL-14, CONTRACTS §4.3, R-16, §13 slot `1796140000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-checkout.entity.ts` (new).
 *
 * ## `fleet_checkouts`
 *
 * One row per git clone or worktree on a Node: the platform's registry over
 * what the node reports, plus the bin (`state = 'archived'`, `archivedAt`)
 * and the link to a repository Work. `(nodeId, path)` is unique — the node
 * keys a checkout by its absolute path. `remoteUrl` is token-free by
 * construction (stripped on the node and again before insert); `gitLine` and
 * `lastCommand` are `simple-json` text (CONTRACTS §4 storage types).
 *
 * FKs (plan §4.2): `nodeId` → `fleet_nodes` CASCADE (a checkout row means
 * nothing without its machine — so the existing `DELETE /api/fleet/nodes/:id`
 * keeps working exactly as today; a user's nodes already go with the user);
 * `parentCheckoutId` → `fleet_checkouts` and `workId` → `works` SET NULL, so
 * deleting a parent row or a Work never erases the record of a folder on a
 * machine. `fleet_sessions.checkoutId` (FL-04) gets no FK here: a session
 * row outlives the checkout it started in, and that column predates this
 * table on every database.
 *
 * Forward-only with per-step guards (`hasTable` / index and FK names), so a
 * partially applied database converges; portable `Table` DDL because
 * production runs Postgres while CI and the e2e stack run better-sqlite3.
 * `down()` drops exactly what `up()` added.
 */
export class CreateFleetCheckouts1796140000000 implements MigrationInterface {
    name = 'CreateFleetCheckouts1796140000000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'idx_fleet_checkouts_node_state',
            columnNames: ['nodeId', 'state'],
        }),
        new TableIndex({
            name: 'idx_fleet_checkouts_user_state',
            columnNames: ['userId', 'state'],
        }),
        new TableIndex({ name: 'idx_fleet_checkouts_work', columnNames: ['workId'] }),
        new TableIndex({
            name: 'uq_fleet_checkouts_node_path',
            columnNames: ['nodeId', 'path'],
            isUnique: true,
        }),
    ];

    private static readonly FKS = [
        new TableForeignKey({
            name: 'fk_fleet_checkouts_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_fleet_checkouts_parent',
            columnNames: ['parentCheckoutId'],
            referencedTableName: 'fleet_checkouts',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
        new TableForeignKey({
            name: 'fk_fleet_checkouts_work',
            columnNames: ['workId'],
            referencedTableName: 'works',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('fleet_checkouts'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_checkouts',
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
                        { name: 'path', type: 'text' },
                        { name: 'kind', type: 'varchar', length: '16' },
                        { name: 'parentCheckoutId', type: 'uuid', isNullable: true },
                        { name: 'remoteUrl', type: 'text', isNullable: true },
                        { name: 'remoteHadCredential', type: 'boolean', default: false },
                        { name: 'workId', type: 'uuid', isNullable: true },
                        { name: 'branch', type: 'varchar', length: '255', isNullable: true },
                        { name: 'baseRef', type: 'varchar', length: '255', isNullable: true },
                        { name: 'isolation', type: 'varchar', length: '12', default: "'host'" },
                        { name: 'state', type: 'varchar', length: '12', default: "'ready'" },
                        { name: 'createdBy', type: 'varchar', length: '12' },
                        { name: 'gitLine', type: 'text', isNullable: true },
                        { name: 'lastCommand', type: 'text', isNullable: true },
                        { name: 'sizeBytes', type: 'bigint', isNullable: true },
                        { name: 'lastSeenAt', type: 'timestamp', isNullable: true },
                        { name: 'archivedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        // Keys before indexes: SQLite adds a key by rebuilding the table, and
        // the indexes are created last so a rebuild never re-creates them.
        for (const foreignKey of CreateFleetCheckouts1796140000000.FKS) {
            await this.ensureForeignKey(queryRunner, foreignKey);
        }
        for (const index of CreateFleetCheckouts1796140000000.INDEXES) {
            await this.ensureIndex(queryRunner, index);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_checkouts')) {
            await queryRunner.dropTable('fleet_checkouts', true, true, true);
        }
    }

    private async ensureIndex(queryRunner: QueryRunner, index: TableIndex): Promise<void> {
        const table = await queryRunner.getTable('fleet_checkouts');
        if (table && !table.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex('fleet_checkouts', index);
        }
    }

    private async ensureForeignKey(
        queryRunner: QueryRunner,
        foreignKey: TableForeignKey,
    ): Promise<void> {
        const table = await queryRunner.getTable('fleet_checkouts');
        if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
            await queryRunner.createForeignKey('fleet_checkouts', foreignKey);
        }
    }
}
