import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Schedules on computers (FL-13, CONTRACTS §4.1, §1.1, §13 slot `1796130100000`).
 *
 * Entity: `packages/agent/src/entities/fleet-node.entity.ts`.
 *
 *  - `fleet_nodes.timeZone` (varchar 64, nullable) — the IANA time zone the
 *    machine reports on every heartbeat (`Europe/Paris`). Command schedules
 *    fire on the machine's own wall clock, so the platform computes their
 *    next fire in this zone and shows it beside the viewer's. NULL = never
 *    reported (a daemon older than the field); schedules then read UTC. No
 *    backfill: the next beat fills it.
 *
 * Portable `TableColumn` DDL guarded by `findColumnByName`, so a partially
 * applied database converges. Forward-only: `down` keeps the column.
 */
export class AddFleetNodeTimeZone1796130100000 implements MigrationInterface {
    name = 'AddFleetNodeTimeZone1796130100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('timeZone')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({
                    name: 'timeZone',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
        }
    }

    /** Intentionally forward-only: the nullable column stays for a later roll-forward. */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
