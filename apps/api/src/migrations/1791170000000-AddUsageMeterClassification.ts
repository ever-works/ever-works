import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/** Same columns in the same key order. */
function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
    return (
        actual.length === expected.length &&
        actual.every((column, position) => column === expected[position])
    );
}

/**
 * AW-17 P1 — every usage row learns which meter it belongs to.
 *
 * Entity: `packages/agent/src/entities/plugin-usage-event.entity.ts`.
 *
 * Seven additive columns on the EXISTING `plugin_usage_events` table — there
 * is no second usage ledger:
 *
 *  - `meter`          `model` | `credits` | `addon`; NULL = recorded before
 *                     meters were separated.
 *  - `payer`          `workspace` | `platform` | `unconfirmed`.
 *  - `outcome`        `ok` | `cached` | `failed`.
 *  - `creditsCharged` int, default 0.
 *  - `priceKey`       `capability.operation`, never a Plugin id.
 *  - `priceVersion`   the price-list version of a fixed price; NULL otherwise.
 *  - `missionId`      the Mission of the row's Task (`tasks.missionId`).
 *
 * ## `meter` is deliberately NOT backfilled
 *
 * Every existing row keeps `meter IS NULL` and is reported under its own
 * "recorded before meters were separated" label. Inferring a meter from
 * `capability` would be exactly the guess the metering rule forbids: the
 * paying credential of a historical call is not recorded anywhere, so
 * `credits` vs `model` cannot be known after the fact.
 *
 * ## `missionId` IS backfilled — from the Task, never from the Agent
 *
 * A historical row with a `taskId` can be attributed exactly: the Mission is
 * the one its Task names. Rows with no Task stay NULL ("Not in a Mission").
 * `agents.missionId` is never read — an Agent scoped to one Mission can work
 * a Task filed against another.
 *
 * The backfill is one statement with a correlated subquery rather than
 * batched `UPDATE … FROM … LIMIT` chunks: `UPDATE … FROM` and `LIMIT` are not
 * portable (production runs Postgres, CI runs better-sqlite3), and
 * `migrationsTransactionMode: 'all'` runs every pending migration in one
 * transaction, so chunking could not release locks anyway. The
 * `"missionId" IS NULL` predicate makes it re-runnable: a second run updates
 * nothing. Very large deployments can finish it out of band; the predicate
 * keeps that safe too.
 *
 * No FK on `missionId` — audit rows outlive a deleted Mission, matching the
 * `agentId` / `taskId` / `runId` columns.
 *
 * Indexes lead with the grouping column so the planner satisfies the
 * `GROUP BY` of the meter cards and the by-tool / by-Mission breakdowns from
 * the index instead of sorting the window (same reasoning as
 * `AddCostsDashboardIndexes1786910000000`).
 *
 * Forward-only + idempotent (column and index guards), house pattern of the
 * table's own earlier migrations (`AddRunIdToPluginUsageEvents1783600000000`).
 * The index guard checks the indexed columns and their order, not just the
 * name, so an index an earlier partial attempt left over the wrong columns is
 * rebuilt rather than kept.
 */
export class AddUsageMeterClassification1791170000000 implements MigrationInterface {
    name = 'AddUsageMeterClassification1791170000000';

    private static readonly COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
        { name: 'meter', ddl: 'varchar(16)' },
        { name: 'payer', ddl: 'varchar(16)' },
        { name: 'outcome', ddl: 'varchar(12)' },
        { name: 'creditsCharged', ddl: 'integer NOT NULL DEFAULT 0' },
        { name: 'priceKey', ddl: 'varchar(64)' },
        { name: 'priceVersion', ddl: 'integer' },
        { name: 'missionId', ddl: 'uuid' },
    ];

    private static readonly INDEXES: ReadonlyArray<{ name: string; columns: string[] }> = [
        {
            name: 'idx_plugin_usage_meter_user_occurred',
            columns: ['userId', 'meter', 'occurredAt'],
        },
        {
            name: 'idx_plugin_usage_pricekey_user_occurred',
            columns: ['userId', 'priceKey', 'occurredAt'],
        },
        { name: 'idx_plugin_usage_mission_occurred', columns: ['missionId', 'occurredAt'] },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('plugin_usage_events');
        if (!table) {
            // `AddPluginUsageEvents1778845109690` has not run — cannot happen
            // in a normal boot (timestamp order); returning beats throwing on
            // a hand-rolled database missing the table entirely.
            return;
        }

        for (const column of AddUsageMeterClassification1791170000000.COLUMNS) {
            if (!table.findColumnByName(column.name)) {
                await queryRunner.query(
                    `ALTER TABLE "plugin_usage_events" ADD COLUMN "${column.name}" ${column.ddl}`,
                );
            }
        }

        for (const index of AddUsageMeterClassification1791170000000.INDEXES) {
            const columns = index.columns.map((column) => `"${column}"`).join(', ');
            // The name alone is not proof the index is right: an earlier,
            // partial attempt can have left an index of this name over other
            // columns (or the same columns in another order), and
            // `IF NOT EXISTS` would keep it — leaving the grouped reads this
            // index exists for without it. A mismatch is dropped and rebuilt.
            const existing = await this.indexedColumns(queryRunner, table, index.name);
            if (existing && !sameColumns(existing, index.columns)) {
                await queryRunner.query(`DROP INDEX IF EXISTS "${index.name}"`);
            }
            await queryRunner.query(
                `CREATE INDEX IF NOT EXISTS "${index.name}" ON "plugin_usage_events" (${columns})`,
            );
        }

        if (await queryRunner.hasTable('tasks')) {
            await queryRunner.query(`
                UPDATE "plugin_usage_events"
                   SET "missionId" = (
                       SELECT t."missionId" FROM "tasks" t
                        WHERE t."id" = "plugin_usage_events"."taskId"
                   )
                 WHERE "missionId" IS NULL
                   AND "taskId" IS NOT NULL
                   AND EXISTS (
                       SELECT 1 FROM "tasks" t
                        WHERE t."id" = "plugin_usage_events"."taskId"
                          AND t."missionId" IS NOT NULL
                   )`);
        }
    }

    /**
     * The columns of the index `name` on `plugin_usage_events`, IN KEY ORDER,
     * or `null` when no such index exists on the table. An expression key has
     * no column and reads as `''`, so it never matches a column list.
     *
     * Read from the catalog directly because the order is the point: the
     * index `(missionId, occurredAt)` serves a `missionId`-leading read and
     * `(occurredAt, missionId)` does not.
     */
    private async indexedColumns(
        queryRunner: QueryRunner,
        table: Table,
        name: string,
    ): Promise<string[] | null> {
        const driver = queryRunner.connection.options.type;

        if (driver === 'postgres') {
            // `to_regclass` resolves the unqualified name through the
            // search_path exactly as the unqualified CREATE / DROP INDEX
            // statements here do, so this inspects the same table.
            const rows: Array<{ column: string | null }> = await queryRunner.query(
                `SELECT a."attname" AS "column"
                   FROM "pg_index" ix
                   JOIN "pg_class" i ON i."oid" = ix."indexrelid"
                  CROSS JOIN LATERAL unnest(ix."indkey") WITH ORDINALITY AS k("attnum", "ord")
                   LEFT JOIN "pg_attribute" a
                          ON a."attrelid" = ix."indrelid" AND a."attnum" = k."attnum"
                  WHERE ix."indrelid" = to_regclass('"plugin_usage_events"')
                    AND i."relname" = $1
                  ORDER BY k."ord"`,
                [name],
            );
            return rows.length > 0 ? rows.map((row) => row.column ?? '') : null;
        }

        if (driver === 'sqlite' || driver === 'better-sqlite3') {
            const owner: Array<{ tbl_name: string }> = await queryRunner.query(
                `SELECT "tbl_name" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = ?`,
                [name],
            );
            if (owner.length === 0 || owner[0].tbl_name !== 'plugin_usage_events') {
                return null;
            }
            const rows: Array<{ seqno: number; name: string | null }> = await queryRunner.query(
                `PRAGMA index_info("${name}")`,
            );
            return [...rows]
                .sort((left, right) => Number(left.seqno) - Number(right.seqno))
                .map((row) => row.name ?? '');
        }

        // Any other driver: the ORM's own reading of the table.
        const found = table.indices.find((candidate) => candidate.name === name);
        return found ? [...found.columnNames] : null;
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const index of AddUsageMeterClassification1791170000000.INDEXES) {
            await queryRunner.query(`DROP INDEX IF EXISTS "${index.name}"`);
        }
        for (const column of AddUsageMeterClassification1791170000000.COLUMNS) {
            // Re-read between drops: a driver that rebuilds the table to drop
            // a column hands back a new Table whose columns the stale one no
            // longer describes.
            const table = await queryRunner.getTable('plugin_usage_events');
            if (table?.findColumnByName(column.name)) {
                await queryRunner.query(
                    `ALTER TABLE "plugin_usage_events" DROP COLUMN "${column.name}"`,
                );
            }
        }
    }
}
