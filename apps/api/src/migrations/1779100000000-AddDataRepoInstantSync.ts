import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Adds the data-repo instant-sync surface to the `works` table (EW-628).
 *
 * Two transports converge on a single render-only sync path:
 *
 * - **Webhook path** (GitHub App installed): the App's `push` handler sets
 *   `pendingSyncRequestedAt = now()`. The dispatcher flushes when the row
 *   is ≥ 30 s old, which acts as a quiet-period debounce — multiple
 *   commits within the window collapse to one column update + one sync run.
 * - **Poller path** (App not installed): the dispatcher runs `ls-remote
 *   HEAD` per Work every `syncIntervalMinutes` (default 5, range 1–60).
 *
 * Columns:
 *
 * - `lastSyncedDataRepoSha` — most recent data-repo SHA the main repo has
 *   been rendered against. Updated on successful sync.
 * - `pendingSyncRequestedAt` — webhook flag. Cleared by successful sync.
 *   Stored as bigint ms (Date) per the project's SQLite/Postgres
 *   portability pattern; the entity decorates with @TimestampColumn.
 * - `syncIntervalMinutes` — poller cadence. Ignored when the App is
 *   installed.
 * - `githubAppInstalled` — denormalised selector between webhook / poller
 *   paths. Backfilled lazily by the App's installation webhook handler.
 * - `lastPolledAt` — last time the poller probed `ls-remote`. Updated
 *   regardless of SHA delta.
 *
 * Forward-only, additive. All columns are nullable or have safe defaults.
 * No data backfill — the `githubAppInstalled` flag flips to true the next
 * time the App's `installation_repositories` webhook fires for an
 * existing installation (or via a separate ops one-off if needed).
 *
 * Index `idx_work_sync_poller` accelerates the dispatcher's poller-path
 * eligibility query. It's a plain composite index (not partial) so the
 * migration is portable across SQLite and Postgres; Postgres can still
 * use it for the equality + range pattern the dispatcher emits.
 *
 * See `docs/specs/features/data-repo-instant-sync/{spec,plan}.md` for the
 * full design.
 */
export class AddDataRepoInstantSync1779100000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('works', [
            new TableColumn({
                name: 'lastSyncedDataRepoSha',
                type: 'varchar',
                length: '40',
                isNullable: true,
            }),
            new TableColumn({
                name: 'pendingSyncRequestedAt',
                type: 'bigint',
                isNullable: true,
            }),
            new TableColumn({
                name: 'syncIntervalMinutes',
                type: 'int',
                isNullable: false,
                default: 5,
            }),
            new TableColumn({
                name: 'githubAppInstalled',
                type: 'boolean',
                isNullable: false,
                default: false,
            }),
            new TableColumn({
                name: 'lastPolledAt',
                type: 'bigint',
                isNullable: true,
            }),
        ]);

        await queryRunner.createIndex(
            'works',
            new TableIndex({
                name: 'idx_work_sync_poller',
                columnNames: ['githubAppInstalled', 'syncIntervalMinutes', 'lastPolledAt'],
            }),
        );

        await queryRunner.createIndex(
            'works',
            new TableIndex({
                name: 'idx_work_sync_webhook',
                columnNames: ['pendingSyncRequestedAt'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropIndex('works', 'idx_work_sync_webhook');
        await queryRunner.dropIndex('works', 'idx_work_sync_poller');
        await queryRunner.dropColumns('works', [
            'lastPolledAt',
            'githubAppInstalled',
            'syncIntervalMinutes',
            'pendingSyncRequestedAt',
            'lastSyncedDataRepoSha',
        ]);
    }
}
