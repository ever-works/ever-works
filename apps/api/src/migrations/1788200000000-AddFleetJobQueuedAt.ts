import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const INDEX_NAME = 'idx_fleet_jobs_queued_at';

/**
 * Self-build slice S (EW-775) — `fleet_jobs.queuedAt`, the queue SLA clock.
 *
 * Nothing used to bound how long a `queued` job could wait: the reclaim
 * sweep only scans ACTIVE statuses, so a job pinned to a node that never
 * came back (or requiring a tag no node advertises) sat `queued` forever
 * with its AgentRun waiting on a verdict that was never coming.
 * `queuedAt` records when the row last ENTERED `queued` (enqueue,
 * reclaim, drain release) and `FleetJobService.expireQueued` fails rows
 * older than their kind's max age.
 *
 * Backfill: rows that are `queued` at upgrade time get `createdAt` — a
 * row that has already waited past the bound is exactly the stuck row
 * the SLA exists to settle. Terminal and active rows keep NULL; they
 * never re-enter the scan unless reclaim re-stamps them. NULLABLE on
 * purpose: a row written by an older replica during a mixed rollout has
 * an UNKNOWN age, and the sweep never destructively fails an unknown age.
 *
 * Index on (`status`, `queuedAt`) mirrors `idx_fleet_jobs_lease_expiry`:
 * the sweep is `status = 'queued' AND queuedAt < cutoff`, per kind.
 *
 * Forward-only with per-step guards so a partially applied database
 * converges; portable `TableColumn` / `TableIndex` DDL because the e2e
 * stack and CI run better-sqlite3 while production runs Postgres.
 */
export class AddFleetJobQueuedAt1788200000000 implements MigrationInterface {
    name = 'AddFleetJobQueuedAt1788200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (!jobs) return;

        if (!jobs.findColumnByName('queuedAt')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({ name: 'queuedAt', type: 'timestamp', isNullable: true }),
            );
        }

        // Idempotent by its own WHERE clause: a re-run finds nothing NULL.
        await queryRunner.query(
            `UPDATE "fleet_jobs" SET "queuedAt" = "createdAt" WHERE "queuedAt" IS NULL AND "status" = 'queued'`,
        );

        // Re-read: the sqlite driver rebuilds the table on addColumn, so
        // the metadata captured above is stale for the index check.
        const refreshed = await queryRunner.getTable('fleet_jobs');
        if (refreshed && !refreshed.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.createIndex(
                'fleet_jobs',
                new TableIndex({ name: INDEX_NAME, columnNames: ['status', 'queuedAt'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (!jobs) return;
        if (jobs.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.dropIndex('fleet_jobs', INDEX_NAME);
        }
        const refreshed = await queryRunner.getTable('fleet_jobs');
        if (refreshed?.findColumnByName('queuedAt')) {
            await queryRunner.dropColumn('fleet_jobs', 'queuedAt');
        }
    }
}
