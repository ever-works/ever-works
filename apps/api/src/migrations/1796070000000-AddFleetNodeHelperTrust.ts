import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Desktop view & control (FL-07, CONTRACTS §4.1, §1.1, R-8, §13 slot `1796070000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-node.entity.ts`.
 *
 *  - `fleet_nodes.helperTrust` (varchar 16, NOT NULL, default `none`) — how
 *    far the machine's native screen helper may be trusted, as its last
 *    heartbeat reported it: `none` · `hash-pinned` (shown as "Reduced
 *    trust") · `signed`. Every existing row has no helper, which is exactly
 *    what the default says, so nothing is backfilled. Indexed
 *    (`idx_fleet_nodes_helper_trust`) for the Computers list's trust filter.
 *  - `fleet_nodes.desktopFacts` (text, nullable) — the entity's `simple-json`
 *    of what the last heartbeat said about the desktop: the helper's state
 *    (never a hash — an 8-digit fingerprint prefix), the displays, the
 *    desktop reasons, and the admission event ids already audited (so a
 *    re-sent event writes no second `node.helper.*` row). NULL = never
 *    reported. An additive FL-07 column beside CONTRACTS §4.1's `helperTrust`
 *    (lane log, owner question 1).
 *
 * Portable `TableColumn` DDL (CI and e2e run better-sqlite3, production
 * Postgres); every step guarded and re-read, so a partially applied database
 * converges.
 */
export class AddFleetNodeHelperTrust1796070000000 implements MigrationInterface {
    name = 'AddFleetNodeHelperTrust1796070000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({
                name: 'helperTrust',
                type: 'varchar',
                length: '16',
                isNullable: false,
                default: "'none'",
            }),
            new TableColumn({ name: 'desktopFacts', type: 'text', isNullable: true }),
        ];
        for (const column of columns) {
            const nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes && !nodes.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_nodes', column);
            }
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (
            nodes &&
            !nodes.indices.some((index) => index.name === 'idx_fleet_nodes_helper_trust')
        ) {
            await queryRunner.createIndex(
                'fleet_nodes',
                new TableIndex({
                    name: 'idx_fleet_nodes_helper_trust',
                    columnNames: ['helperTrust'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        let nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;
        if (nodes.indices.some((index) => index.name === 'idx_fleet_nodes_helper_trust')) {
            await queryRunner.dropIndex('fleet_nodes', 'idx_fleet_nodes_helper_trust');
        }
        for (const name of ['desktopFacts', 'helperTrust']) {
            nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes?.findColumnByName(name)) await queryRunner.dropColumn('fleet_nodes', name);
        }
    }
}
