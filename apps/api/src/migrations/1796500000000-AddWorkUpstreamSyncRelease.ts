import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * APW-02 T46 + T47 (FR-60, FR-61, FR-62) — three nullable, default-free columns on
 * `work_upstream_states`:
 *
 * | column                     | type     | written by |
 * |----------------------------|----------|------------|
 * | `syncPullRequestCheckedAt` | `bigint` | the dispatcher's sync-PR check (T47) — epoch ms, like every timestamp of this table |
 * | `workflowHold`             | `text`   | the sync run when it holds a range for workflow review (T46, `simple-json`) |
 * | `workflowRelease`          | `text`   | `AppUpstreamStateService.requestSync` after the owner-and-session gate (T46, `simple-json`) |
 *
 * Entity: `packages/agent/src/entities/work-upstream-state.entity.ts`.
 * Slot: lane aw-loops' block `17965…` (overnight build 2026-10-27).
 *
 * Nothing is renamed, dropped or narrowed; no index, no FK, no backfill. NULL is the
 * true value of every existing row: no range was held with paths recorded, nobody has
 * released one, and no sync pull request has been checked yet. Every step is guarded
 * (`hasTable` / `hasColumn`), so a re-run is a no-op and `down()` is safe where `up()`
 * never ran. Types are portable (Postgres in production, better-sqlite3 in CI).
 */
export class AddWorkUpstreamSyncRelease1796500000000 implements MigrationInterface {
    name = 'AddWorkUpstreamSyncRelease1796500000000';

    private static readonly TABLE = 'work_upstream_states';

    private static readonly COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
        { name: 'syncPullRequestCheckedAt', type: 'bigint' },
        { name: 'workflowHold', type: 'text' },
        { name: 'workflowRelease', type: 'text' },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = AddWorkUpstreamSyncRelease1796500000000.TABLE;
        if (!(await queryRunner.hasTable(table))) {
            // The create migration has not run: the columns arrive with the table,
            // because the entity carries them.
            return;
        }
        for (const column of AddWorkUpstreamSyncRelease1796500000000.COLUMNS) {
            if (await queryRunner.hasColumn(table, column.name)) continue;
            await queryRunner.addColumn(
                table,
                new TableColumn({ name: column.name, type: column.type, isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = AddWorkUpstreamSyncRelease1796500000000.TABLE;
        if (!(await queryRunner.hasTable(table))) return;
        for (const column of [...AddWorkUpstreamSyncRelease1796500000000.COLUMNS].reverse()) {
            if (!(await queryRunner.hasColumn(table, column.name))) continue;
            await queryRunner.dropColumn(table, column.name);
        }
    }
}
