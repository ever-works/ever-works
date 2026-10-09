import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const INDEX_NAME = 'idx_fleet_jobs_bodies_purge';

/**
 * Self-build slice AP — `fleet_jobs.bodiesPurgedAt`, the retention marker.
 *
 * `fleet_jobs` kept every job's full `payload` (the entire assembled prompt,
 * up to 256 KB) and its `result` (up to 256 KB, now including the run's
 * redacted transcript) forever: nothing purged, pruned or partitioned it.
 * `FleetJobRetentionService` now NULLs both bodies on TERMINAL jobs older
 * than the retention window (`FLEET_JOB_RETENTION_DAYS`, default 30) and
 * keeps the row's metadata — status, node, timings, cost, error.
 *
 * The column is what makes that pass idempotent and cheap. Without it the
 * only way to tell a purged row from one whose node simply reported no
 * result is to inspect the JSON bodies, which is neither portable across
 * Postgres and better-sqlite3 nor indexable. NULL = never purged.
 *
 * Index on (`bodiesPurgedAt`, `completedAt`): the pass is
 * `bodiesPurgedAt IS NULL AND completedAt < cutoff`, so already-purged rows
 * (the vast majority, over time) sit in a different key range and are never
 * scanned again.
 *
 * No backfill: every existing row starts unpurged, and the first nightly
 * pass works through the backlog in bounded batches.
 *
 * Forward-only with per-step guards so a partially applied database
 * converges; portable `TableColumn` / `TableIndex` DDL because the e2e stack
 * and CI run better-sqlite3 while production runs Postgres.
 */
export class AddFleetJobBodiesPurgedAt1795040000000 implements MigrationInterface {
    name = 'AddFleetJobBodiesPurgedAt1795040000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (!jobs) return;

        if (!jobs.findColumnByName('bodiesPurgedAt')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({ name: 'bodiesPurgedAt', type: 'timestamp', isNullable: true }),
            );
        }

        // Re-read: the sqlite driver rebuilds the table on addColumn, so
        // the metadata captured above is stale for the index check.
        const refreshed = await queryRunner.getTable('fleet_jobs');
        if (refreshed && !refreshed.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.createIndex(
                'fleet_jobs',
                new TableIndex({
                    name: INDEX_NAME,
                    columnNames: ['bodiesPurgedAt', 'completedAt'],
                }),
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
        if (refreshed?.findColumnByName('bodiesPurgedAt')) {
            await queryRunner.dropColumn('fleet_jobs', 'bodiesPurgedAt');
        }
    }
}
