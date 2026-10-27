import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Virtual computers (FL-16) — what a Node created ON another Node carries
 * (CONTRACTS §4.1, R-35, §13 slot 00):
 *
 *  - `origin` (varchar 16, NOT NULL, default `enrolled`) — `enrolled` ·
 *    `virtual` · `cloud`. Every existing row is a machine a person enrolled,
 *    which is exactly what the default says, so nothing is backfilled.
 *    FL-17's slot (`1796170000000-AddFleetNodeProviderFields`) adds the same
 *    column when it lands first; both guard it (R-35), so either order works.
 *  - `hostNodeId` (uuid, nullable) — the host a virtual computer runs on.
 *    Not a foreign key: a child's job history survives its host's deletion
 *    (the same rule as `fleet_jobs.nodeId`); the delete guards keep a host
 *    with children from being removed (spec FR-29). Indexed
 *    (`idx_fleet_nodes_host`) for the hub's nesting and the per-host limit.
 *  - `virtualKind` (varchar 16, nullable) — `vm` · `container`.
 *  - `virtualMeta` (text, nullable) — the entity's `simple-json` system,
 *    size, image and last known create phase / machine state (CONTRACTS §4.1
 *    `virtualMeta`), so the row survives the job-body purge.
 *
 * Portable `TableColumn` DDL (CI and e2e run better-sqlite3, production
 * Postgres); every step guarded by `findColumnByName` / an index lookup and
 * re-read per step, so a partially applied database converges.
 */
export class AddFleetNodeVirtualFields1796160000000 implements MigrationInterface {
    name = 'AddFleetNodeVirtualFields1796160000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({
                name: 'origin',
                type: 'varchar',
                length: '16',
                isNullable: false,
                default: "'enrolled'",
            }),
            new TableColumn({ name: 'hostNodeId', type: 'uuid', isNullable: true }),
            new TableColumn({
                name: 'virtualKind',
                type: 'varchar',
                length: '16',
                isNullable: true,
            }),
            new TableColumn({ name: 'virtualMeta', type: 'text', isNullable: true }),
        ];
        for (const column of columns) {
            // Re-read per step: a column added by an earlier step (or an earlier,
            // interrupted run, or FL-17's slot for `origin`) must be seen first.
            const nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes && !nodes.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_nodes', column);
            }
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.indices.some((index) => index.name === 'idx_fleet_nodes_host')) {
            await queryRunner.createIndex(
                'fleet_nodes',
                new TableIndex({ name: 'idx_fleet_nodes_host', columnNames: ['hostNodeId'] }),
            );
        }
    }

    /**
     * Drops the index and the FL-16-only columns. `origin` is shared with
     * FL-17 (R-35): it is dropped only while FL-17's provider columns are
     * absent, so rolling FL-16 back never takes a cloud computer's origin
     * away.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        let nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;
        if (nodes.indices.some((index) => index.name === 'idx_fleet_nodes_host')) {
            await queryRunner.dropIndex('fleet_nodes', 'idx_fleet_nodes_host');
        }
        for (const name of ['virtualMeta', 'virtualKind', 'hostNodeId']) {
            nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes?.findColumnByName(name)) await queryRunner.dropColumn('fleet_nodes', name);
        }
        nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('origin') && !nodes.findColumnByName('providerPluginId')) {
            await queryRunner.dropColumn('fleet_nodes', 'origin');
        }
    }
}
