import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Remote node limits (self-build slice AS).
 *
 * The defect this closes: `maxConcurrentJobs` / `maxCpuPercent` /
 * `maxMemoryMb` were node-local start flags the platform could neither
 * read, set nor display. The scheduler had no idea whether a node runs one
 * job or sixteen, and retuning six PCs meant six physical visits plus six
 * service reinstalls — and a reinstall re-applies whatever flags the
 * installer was given, silently reverting a partial edit.
 *
 * Six nullable `int` columns on `fleet_nodes`:
 *
 *  1. `effectiveMaxConcurrentJobs` / `effectiveMaxCpuPercent` /
 *     `effectiveMaxMemoryMb` — what the node last REPORTED enforcing
 *     (`min(its own flags, the ceiling below)`), written as a set by the
 *     heartbeat. Visibility only; nothing routes on them.
 *  2. `ceilingMaxConcurrentJobs` / `ceilingMaxCpuPercent` /
 *     `ceilingMaxMemoryMb` — the OWNER's platform-side ceiling, written
 *     only by `PUT /api/fleet/nodes/:id/limits` (audited as `node.limits`).
 *     Living here, on the platform, is what makes it survive a reinstall on
 *     the machine: the next heartbeat hands it straight back.
 *
 * NO DEFAULTS and NULL backfill on all six: NULL is "never reported" for
 * the first three and "no ceiling" for the last three — both are the truth
 * for every row that exists today, and both mean every node keeps running
 * exactly as it does now.
 *
 * Plain `int`: the largest legitimate value is a memory ceiling of
 * 1,048,576 MB, far inside a 32-bit column; the service drops anything
 * that would not fit rather than clamping it.
 *
 * Portable DDL (`TableColumn`) because CI and the e2e stack run
 * better-sqlite3 while production runs Postgres. Guarded per column, so a
 * partially-applied database converges; `down()` goes through `dropColumn`
 * (never a raw `ALTER TABLE ... DROP COLUMN`).
 */
export class AddFleetNodeLimits1795030000000 implements MigrationInterface {
    name = 'AddFleetNodeLimits1795030000000';

    /** Order is the order they are added; `down()` removes them in reverse. */
    private static readonly COLUMNS: readonly string[] = [
        'effectiveMaxConcurrentJobs',
        'effectiveMaxCpuPercent',
        'effectiveMaxMemoryMb',
        'ceilingMaxConcurrentJobs',
        'ceilingMaxCpuPercent',
        'ceilingMaxMemoryMb',
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        for (const name of AddFleetNodeLimits1795030000000.COLUMNS) {
            if (!nodes.findColumnByName(name)) {
                await queryRunner.addColumn(
                    'fleet_nodes',
                    new TableColumn({ name, type: 'int', isNullable: true }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (!nodes) return;

        for (const name of [...AddFleetNodeLimits1795030000000.COLUMNS].reverse()) {
            if (nodes.findColumnByName(name)) {
                await queryRunner.dropColumn('fleet_nodes', name);
            }
        }
    }
}
