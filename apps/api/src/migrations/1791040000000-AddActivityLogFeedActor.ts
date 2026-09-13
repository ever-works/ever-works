import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Live Feed — who did it, and the two access paths the feed reads through.
 *
 * Entity: `packages/agent/src/entities/activity-log.entity.ts`.
 *
 * ## The three actor columns
 *
 * `activity_log` never recorded an actor. The acting agent was only ever a
 * `details.resourceId` JSON fragment for SOME action types, which cannot be
 * indexed and which vanishes from the display the moment the agent is
 * renamed. The Live Feed needs to say who did a thing and to filter by it:
 *
 *  - `actorKind`    `agent` | `user` | `external` | `system`
 *  - `actorAgentId` the acting agent. Deliberately NO foreign key, by the
 *                   same convention as the scope columns on this table:
 *                   deleting an Agent must not rewrite (or cascade-delete)
 *                   history.
 *  - `actorLabel`   the actor's name when the record was written, so a later
 *                   rename does not change what already happened.
 *
 * All three are NULL on every existing row, and that is correct history —
 * the feed resolves older rows at read time from `details` and the action
 * type. There is deliberately NO backfill: a full-table UPDATE on the
 * platform's largest audit table is exactly the lock this migration exists
 * to avoid.
 *
 * ## The two indexes
 *
 *  - `idx_activity_log_user_created_id` `(userId, createdAt, id)` — the
 *    feed pages by a `(createdAt, id)` keyset, newest first. The existing
 *    `(userId, createdAt)` index narrows the window but leaves the `id`
 *    tiebreak as a sort.
 *  - `idx_activity_log_user_actor_created` `(userId, actorAgentId, createdAt)`
 *    — the per-agent filter and the actor roster's GROUP BY.
 *
 * Portable DDL through TypeORM's `TableColumn` / `TableIndex` API rather than
 * raw SQL, because production runs Postgres while CI and the e2e stack run
 * better-sqlite3 (mirrors 1786910000000 and 1790100000000). Every column is
 * nullable with no default, so on Postgres each ADD COLUMN is a metadata-only
 * change.
 *
 * Forward-only and idempotent in both directions: a column or index is added
 * only when absent and dropped only when present, so a re-run on a partially
 * migrated database is a no-op rather than an abort.
 */
export class AddActivityLogFeedActor1791040000000 implements MigrationInterface {
    name = 'AddActivityLogFeedActor1791040000000';

    private static readonly TABLE = 'activity_log';

    private static readonly COLUMNS = [
        new TableColumn({ name: 'actorKind', type: 'varchar', length: '16', isNullable: true }),
        new TableColumn({ name: 'actorAgentId', type: 'uuid', isNullable: true }),
        new TableColumn({ name: 'actorLabel', type: 'varchar', length: '120', isNullable: true }),
    ];

    private static readonly INDEXES: ReadonlyArray<{ name: string; columnNames: string[] }> = [
        {
            name: 'idx_activity_log_user_created_id',
            columnNames: ['userId', 'createdAt', 'id'],
        },
        {
            name: 'idx_activity_log_user_actor_created',
            columnNames: ['userId', 'actorAgentId', 'createdAt'],
        },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = AddActivityLogFeedActor1791040000000.TABLE;
        if (!(await queryRunner.hasTable(table))) {
            // The table is created by an earlier migration; returning beats
            // throwing on a hand-rolled database that is missing it.
            return;
        }

        for (const column of AddActivityLogFeedActor1791040000000.COLUMNS) {
            // Re-read between additions: on better-sqlite3 each addColumn
            // rebuilds the table, and a stale Table object no longer
            // describes what exists.
            const current = await queryRunner.getTable(table);
            if (current && !current.findColumnByName(column.name)) {
                await queryRunner.addColumn(table, column);
            }
        }

        for (const index of AddActivityLogFeedActor1791040000000.INDEXES) {
            const current = await queryRunner.getTable(table);
            if (current?.indices.some((existing) => existing.name === index.name)) {
                continue;
            }
            await queryRunner.createIndex(
                table,
                new TableIndex({ name: index.name, columnNames: index.columnNames }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = AddActivityLogFeedActor1791040000000.TABLE;
        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        for (const index of AddActivityLogFeedActor1791040000000.INDEXES) {
            const current = await queryRunner.getTable(table);
            if (current?.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.dropIndex(table, index.name);
            }
        }

        for (const column of AddActivityLogFeedActor1791040000000.COLUMNS) {
            const current = await queryRunner.getTable(table);
            const existing = current?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn(table, existing);
            }
        }
    }
}
