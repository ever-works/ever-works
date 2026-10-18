import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Computer health (FL-03) — the latest health snapshot and the wake fields
 * on `fleet_nodes` (CONTRACTS §4.1, §13 slot 01).
 *
 *  - `health` (text) — the entity's `simple-json` latest snapshot, stamped
 *    with the platform's receipt time, so every list of computers reads one
 *    row per computer and never joins the history table. NULL = the node
 *    never reported one (a daemon older than the field); no backfill.
 *  - `macAddress` (text, CONTRACTS §4.1) — the node's primary hardware address,
 *    reported only with `--manage`, returned masked and to the owner only.
 *  - `lanId` (text) — an opaque identity of the node's network, so a
 *    sibling on the same network can be matched without storing an address.
 *  - `lastWakeAttemptAt` (timestamp) — the last wake attempt on this node.
 *
 * All four nullable with no default, so existing rows are untouched. The
 * snapshot is written from FL-03's first phase; the three wake columns are
 * read and written from its wake phase and ship here because CONTRACTS puts
 * them in this one slot.
 *
 * Portable `TableColumn` DDL (CI and e2e run better-sqlite3, production
 * Postgres); every column guarded by `findColumnByName` so a partially
 * applied database converges. Forward-only: `down` keeps the columns and
 * their data.
 */
export class AddFleetNodeWakeFields1796030100000 implements MigrationInterface {
    name = 'AddFleetNodeWakeFields1796030100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({ name: 'health', type: 'text', isNullable: true }),
            new TableColumn({ name: 'macAddress', type: 'text', isNullable: true }),
            new TableColumn({ name: 'lanId', type: 'text', isNullable: true }),
            new TableColumn({ name: 'lastWakeAttemptAt', type: 'timestamp', isNullable: true }),
        ];
        for (const column of columns) {
            // Re-read per step: a column added by an earlier step (or an earlier,
            // interrupted run) must be seen before the next guard is judged.
            const nodes = await queryRunner.getTable('fleet_nodes');
            if (nodes && !nodes.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_nodes', column);
            }
        }
    }

    /**
     * Intentionally forward-only. Rolling the application back leaves the
     * nullable columns and the last snapshot in place for a later
     * roll-forward.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
