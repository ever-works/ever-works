import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet node link (FL-02) — the consents a node reports, and the preview-profile switch.
 *
 * A node now reports, on every heartbeat, which of its four consents its
 * owner switched on when starting it — `--work`, `--attend`, the new
 * `--manage`, and `usageScan` (CONTRACTS §1.1). The platform needs them
 * stored to say, per computer tab, which consent is missing, and to refuse a
 * link channel whose family the node did not consent to. Two columns on
 * `fleet_nodes`, both slotted here by CONTRACTS §13:
 *
 *  - `consents` (text) — the entity's `simple-json` `{ work, attend, manage,
 *    usageScan }`. NULL = never reported: a daemon older than the field. No
 *    backfill — `effectiveConsents` infers what it can for such a node and
 *    never infers `manage`.
 *  - `previewProfileEnabled` (boolean, default false) — whether "Open" on a
 *    listening port may use the node's owner-level preview browser profile
 *    (CONTRACTS R-3). The column only; FL-10 owns its behaviour. Existing
 *    rows read false.
 *
 * Forward-only with per-step guards so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddFleetNodeConsents1796020000000 implements MigrationInterface {
    name = 'AddFleetNodeConsents1796020000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        let nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('consents')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'consents', type: 'text', isNullable: true }),
            );
            nodes = await queryRunner.getTable('fleet_nodes');
        }
        if (nodes && !nodes.findColumnByName('previewProfileEnabled')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'previewProfileEnabled',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        let nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('previewProfileEnabled')) {
            await queryRunner.dropColumn('fleet_nodes', 'previewProfileEnabled');
            nodes = await queryRunner.getTable('fleet_nodes');
        }
        if (nodes?.findColumnByName('consents')) {
            await queryRunner.dropColumn('fleet_nodes', 'consents');
        }
    }
}
