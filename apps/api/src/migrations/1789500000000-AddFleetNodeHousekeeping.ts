import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Node housekeeping visibility (EW-803, self-build findings OPS-12 and R8).
 *
 * The defect this closes: both halves of node housekeeping were enforced
 * on the machine and invisible from the platform.
 *
 *  - The disk FLOOR was node-local. `diskFreeBytes` had been on the wire
 *    since `1786920000000`, so Fleet could say "1.2 GB free" — but not
 *    whether 1.2 GB was comfortable or the reason that node had quietly
 *    stopped leasing.
 *  - The workspace REAPER wrote its outcome to the node's own log file
 *    and nowhere else. From Fleet there was no way to distinguish a
 *    machine whose reaper is keeping up from one where it has not run
 *    since March — which is how a founder's PC reached 38 MB free.
 *
 * Five nullable columns on `fleet_nodes`:
 *
 *  1. `minFreeDiskBytes` — the floor the node enforces on ITSELF. Stored
 *     for display only. Nothing routes on it and no path pushes a value
 *     back down: the limit stays enforced on the machine, which is the
 *     point of lending one.
 *  2. `workspaceCount` / `workspaceBytes` — what the last sweep retained.
 *  3. `lastReclaimAt` / `lastReclaimFreedBytes` — when it last ran and
 *     what it took.
 *
 * NO DEFAULTS, and NULL is the honest backfill on every one of them. A
 * `0` default on `workspaceCount` would state in the schema that every
 * already-enrolled node is holding no workspaces — reassuring, and
 * exactly backwards from the truth, which is that we have never asked.
 *
 * The byte columns are `bigint` for the same reason `diskFreeBytes` is:
 * a modern volume overflows a 32-bit int by three orders of magnitude.
 * `workspaceCount` is a plain `int` — 100,000 is the contract ceiling.
 *
 * `lastReclaimAt` is `timestamp` and, unlike every other instant on this
 * table, carries a value the NODE supplied rather than one the server
 * stamped. `FleetService` refuses anything unparseable or implausibly
 * far in the future before it reaches this column.
 *
 * Portable DDL (`TableColumn`) because CI and the e2e stack run
 * better-sqlite3 while production runs Postgres. Forward-only with a
 * guard per step, so a partially-applied database converges rather than
 * aborting; `down()` reverses all of it through `dropColumn` (never a raw
 * `ALTER TABLE ... DROP COLUMN`, which sqlite only learned in 3.35 and
 * which desynchronises the query runner's metadata).
 */
export class AddFleetNodeHousekeeping1789500000000 implements MigrationInterface {
    name = 'AddFleetNodeHousekeeping1789500000000';

    /** Column name → its portable definition. Order is the order they are added. */
    private static readonly COLUMNS: ReadonlyArray<{ name: string; column: () => TableColumn }> = [
        {
            name: 'minFreeDiskBytes',
            column: () =>
                new TableColumn({ name: 'minFreeDiskBytes', type: 'bigint', isNullable: true }),
        },
        {
            name: 'workspaceCount',
            column: () =>
                new TableColumn({ name: 'workspaceCount', type: 'int', isNullable: true }),
        },
        {
            name: 'workspaceBytes',
            column: () =>
                new TableColumn({ name: 'workspaceBytes', type: 'bigint', isNullable: true }),
        },
        {
            name: 'lastReclaimAt',
            column: () =>
                new TableColumn({ name: 'lastReclaimAt', type: 'timestamp', isNullable: true }),
        },
        {
            name: 'lastReclaimFreedBytes',
            column: () =>
                new TableColumn({
                    name: 'lastReclaimFreedBytes',
                    type: 'bigint',
                    isNullable: true,
                }),
        },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        for (const { name, column } of AddFleetNodeHousekeeping1789500000000.COLUMNS) {
            if (!nodes.findColumnByName(name)) {
                await queryRunner.addColumn('fleet_nodes', column());
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        for (const { name } of [...AddFleetNodeHousekeeping1789500000000.COLUMNS].reverse()) {
            if (nodes.findColumnByName(name)) {
                await queryRunner.dropColumn('fleet_nodes', name);
            }
        }
    }
}
