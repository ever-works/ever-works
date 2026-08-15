import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Costs dashboard (Settings → Usage & Credits → Costs) — the covering
 * indexes its five aggregations need.
 *
 * No columns, no tables: every number the Costs view shows is derived
 * from rows that already exist (`plugin_usage_events.costCents` /
 * `modelId` / `agentId`, `agent_runs.costCents`). What was missing was
 * an access path:
 *
 *  - `plugin_usage_events` had `(userId, occurredAt)`, which narrows the
 *    window but leaves the per-agent / per-model GROUP BY as a sort over
 *    the whole window. Leading with the grouping column after `userId`
 *    lets the planner walk the index in group order.
 *  - `agent_runs` had NO user-keyed index at all — every one of
 *    `listSessionsForUser`, the per-agent run counts and the top-runs
 *    table was a full scan filtered on `userId`.
 *
 * Portable DDL via TypeORM's `TableIndex` API rather than raw
 * `CREATE INDEX IF NOT EXISTS`, because production is Postgres while CI
 * and the e2e stack run better-sqlite3 (mirrors 1784830000000).
 *
 * Idempotent in both directions: each index is created only when the
 * table exists and the index does not, and dropped only when present, so
 * a re-run on a partially-migrated database is a no-op rather than an
 * abort.
 */
export class AddCostsDashboardIndexes1785010000000 implements MigrationInterface {
    name = 'AddCostsDashboardIndexes1785010000000';

    private static readonly INDEXES: ReadonlyArray<{
        table: string;
        name: string;
        columnNames: string[];
    }> = [
        {
            table: 'plugin_usage_events',
            name: 'idx_plugin_usage_events_user_agent_occurred',
            columnNames: ['userId', 'agentId', 'occurredAt'],
        },
        {
            table: 'plugin_usage_events',
            name: 'idx_plugin_usage_events_user_model_occurred',
            columnNames: ['userId', 'modelId', 'occurredAt'],
        },
        {
            table: 'agent_runs',
            name: 'idx_agent_runs_user_created',
            columnNames: ['userId', 'createdAt'],
        },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const index of AddCostsDashboardIndexes1785010000000.INDEXES) {
            if (!(await queryRunner.hasTable(index.table))) {
                continue;
            }
            const table = await queryRunner.getTable(index.table);
            if (table?.indices.some((existing) => existing.name === index.name)) {
                continue;
            }
            await queryRunner.createIndex(
                index.table,
                new TableIndex({ name: index.name, columnNames: index.columnNames }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const index of AddCostsDashboardIndexes1785010000000.INDEXES) {
            if (!(await queryRunner.hasTable(index.table))) {
                continue;
            }
            const table = await queryRunner.getTable(index.table);
            if (!table?.indices.some((existing) => existing.name === index.name)) {
                continue;
            }
            await queryRunner.dropIndex(index.table, index.name);
        }
    }
}
