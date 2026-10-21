import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet node link (FL-02 T-25) — the node's opt-in self-update report.
 *
 * A node started with `ever-works-node start --auto-update` upgrades itself
 * when the platform raises its version floor or names a recommended version;
 * a failed attempt leaves the old version running and must be shown in the
 * hub ("Self-update failed on build-02 at 09:12 — run the command yourself",
 * spec U16). Every heartbeat now carries the report; this column stores the
 * last one:
 *
 *  - `selfUpdate` (text) — the entity's `simple-json` `{ enabled, failedAt,
 *    error, targetVersion, updatedAt, fromVersion }`. NULL = never reported
 *    (a daemon older than the field). No backfill.
 *
 * Slot `1796020100000`: the second of FL-02's `179602…` block (CONTRACTS §13
 * gives FL-02 `1796020000000`; the sub-slot follows FL-01's `1796010100000`).
 * Forward-only with a per-step guard so a partially applied database
 * converges; portable `TableColumn` DDL (better-sqlite3 in e2e/CI, Postgres
 * in production).
 */
export class AddFleetNodeSelfUpdate1796020100000 implements MigrationInterface {
    name = 'AddFleetNodeSelfUpdate1796020100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('selfUpdate')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'selfUpdate', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('selfUpdate')) {
            await queryRunner.dropColumn('fleet_nodes', 'selfUpdate');
        }
    }
}
