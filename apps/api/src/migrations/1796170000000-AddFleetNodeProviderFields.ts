import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Cloud computers (FL-17) — what a Node created at a cloud provider carries
 * (CONTRACTS §4.1, R-35, §13 slot 00):
 *
 *  - `origin` (varchar 16, NOT NULL, default `enrolled`) — owned by FL-16's
 *    slot (`1796160000000-AddFleetNodeVirtualFields`); added here too, guarded,
 *    so either migration may land first (R-35). Nothing is backfilled.
 *  - `providerPluginId` (varchar 64, nullable) — the `machine-provider` plugin
 *    that created the Node.
 *  - `providerMachineRef` (varchar 128, nullable) — the provider's own id for
 *    the machine. Unique with `providerPluginId` (`idx_fleet_nodes_provider_machine`;
 *    NULLs never collide on Postgres or SQLite, so every other Node is untouched).
 *  - `providerMeta` (text, nullable) — the entity's `simple-json`
 *    `FleetCloudMeta`: region, size, hourly rate, created at, power timeline,
 *    idle policy, cost snapshot. Never a token, a password or a key.
 *
 * Portable `TableColumn` DDL (CI and e2e run better-sqlite3, production
 * Postgres); every step guarded by `findColumnByName` / an index lookup and
 * re-read per step, so a partially applied database converges.
 */
export class AddFleetNodeProviderFields1796170000000 implements MigrationInterface {
    name = 'AddFleetNodeProviderFields1796170000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({
                name: 'origin',
                type: 'varchar',
                length: '16',
                isNullable: false,
                default: "'enrolled'",
            }),
            new TableColumn({ name: 'providerPluginId', type: 'varchar', length: '64', isNullable: true }),
            new TableColumn({ name: 'providerMachineRef', type: 'varchar', length: '128', isNullable: true }),
            new TableColumn({ name: 'providerMeta', type: 'text', isNullable: true }),
        ];
        for (const column of columns) {
            // Re-read per step: a column added by an earlier step (or an earlier,
            // interrupted run, or FL-16's slot for `origin`) must be seen first.
            const nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes && !nodes.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_nodes', column);
            }
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.indices.some((index) => index.name === 'idx_fleet_nodes_provider_machine')) {
            await queryRunner.createIndex(
                'fleet_nodes',
                new TableIndex({
                    name: 'idx_fleet_nodes_provider_machine',
                    columnNames: ['providerPluginId', 'providerMachineRef'],
                    isUnique: true,
                }),
            );
        }
    }

    /**
     * Drops the index and the three FL-17 columns. `origin` is shared with FL-16
     * (R-35): it is dropped only while FL-16's columns are absent (no
     * `hostNodeId`), so rolling FL-17 back never takes a virtual computer's
     * origin away.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        let nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;
        if (nodes.indices.some((index) => index.name === 'idx_fleet_nodes_provider_machine')) {
            await queryRunner.dropIndex('fleet_nodes', 'idx_fleet_nodes_provider_machine');
        }
        for (const name of ['providerMeta', 'providerMachineRef', 'providerPluginId']) {
            nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes?.findColumnByName(name)) await queryRunner.dropColumn('fleet_nodes', name);
        }
        nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('origin') && !nodes.findColumnByName('hostNodeId')) {
            await queryRunner.dropColumn('fleet_nodes', 'origin');
        }
    }
}
