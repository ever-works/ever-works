import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Suspend-safe leases (self-build program note §6, finding R7) —
 * `fleet_jobs.leaseGeneration`.
 *
 * Desk PCs sleep. A suspended node stops heart-beating, its 300 s lease
 * lapses, the job is reclaimed and leased again — possibly to the SAME
 * machine once it wakes and polls — while the first model run is still
 * going and only learns it lost the claim minutes later. `nodeId` alone
 * cannot tell the two claims apart. This column can: every successful
 * claim writes `previous + 1`, the node echoes the value on heartbeat
 * and complete, and `FleetJobRepository.extendLease` / `complete` pin it
 * in their WHERE clause so a stale holder matches zero rows.
 *
 * Additive, `NOT NULL DEFAULT 0`, no index: it is only ever read on the
 * primary-key path. Every existing row backfills to 0, which is "no
 * claim minted under the new protocol" — a row that was leased at
 * deploy time is deliberately refused on its next heartbeat (0 is never
 * a valid generation) so its in-flight run aborts and the job is
 * re-offered under generation 1. Forward-only with a guard so a
 * partially applied database converges; portable `TableColumn` DDL
 * because the e2e stack and CI run better-sqlite3 while production runs
 * Postgres.
 */
export class AddFleetJobLeaseGeneration1788400000000 implements MigrationInterface {
    name = 'AddFleetJobLeaseGeneration1788400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs && !jobs.findColumnByName('leaseGeneration')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({
                    name: 'leaseGeneration',
                    type: 'int',
                    default: 0,
                    isNullable: false,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs?.findColumnByName('leaseGeneration')) {
            await queryRunner.dropColumn('fleet_jobs', 'leaseGeneration');
        }
    }
}
