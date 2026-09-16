import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agent computers, take-over — the rest of the control lock on `fleet_nodes`.
 *
 * Entity: `packages/agent/src/entities/fleet-node.entity.ts`
 *
 * Phase 1 shipped the four `controlHolder*` columns: who holds a machine,
 * from which live view, since when and until when. Taking control for real
 * needs four more facts, and each is a column on the SAME row so every
 * control act stays one conditional UPDATE on one row — the compare-and-set
 * that keeps two people (or a hand-over and an automatic release) from ever
 * both holding a machine:
 *
 *  - `controlIdleAt` — when control is given back if no input arrives first;
 *  - `controlAckAt` — when the controlling browser last acknowledged, the
 *    floor under the gateway's disconnect release;
 *  - `controlExtendedAt` — a stretch of control may be extended once;
 *  - `controlRequestUserId` / `controlRequestSessionId` /
 *    `controlRequestedAt` — the ONE pending request for control, which the
 *    holder hands over to (moving the lock in the same UPDATE) or declines,
 *    and which declines on its own after a minute.
 *
 * No new table: a request is a transient fact about the lock, not a record
 * of its own (the audit ledger keeps the history). Every column lands
 * NULLABLE and NULL — "nobody holds control, nobody is asking" — which is the
 * only true value for a machine before this migration.
 *
 * Forward-only + idempotent (`findColumnByName` guards), portable
 * `TableColumn` DDL because production runs Postgres while CI runs
 * better-sqlite3. `down()` drops exactly what `up()` added, in reverse.
 */
export class AddComputerControlHandover1791141100000 implements MigrationInterface {
    name = 'AddComputerControlHandover1791141100000';

    private static readonly COLUMNS = [
        new TableColumn({ name: 'controlIdleAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'controlAckAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'controlExtendedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'controlRequestUserId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'controlRequestSessionId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'controlRequestedAt', type: 'timestamp', isNullable: true }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const column of AddComputerControlHandover1791141100000.COLUMNS) {
            // A fresh `getTable` per add: drivers that cannot add a column in
            // place rebuild the table, and each rebuild replaces the object.
            const table = await queryRunner.getTable('fleet_nodes');
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_nodes', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of [...AddComputerControlHandover1791141100000.COLUMNS].reverse()) {
            const table = await queryRunner.getTable('fleet_nodes');
            const existing = table?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn('fleet_nodes', existing);
            }
        }
    }
}
