import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.3.
 *
 * Generalizes the EW-602 budget + usage infrastructure to support
 * the new polymorphic owner model (Missions/Ideas/Works spec §8.2).
 *
 * Today every `work_budgets` / `usage_ledger_entries` /
 * `plugin_usage_events` / `work_budget_alert_states` row pins to a
 * single `workId`. The new model needs to attribute spend to Ideas
 * and Missions too. Rather than duplicating the table per owner
 * type, we add a `(ownerType, ownerId)` pair on each affected table
 * and let Phase 7 (PR T) extend `BudgetGuardService` to query by it.
 *
 * Strict back-compat: existing `workId` columns + indexes + FKs
 * stay untouched. Every pre-existing row is backfilled
 * `ownerType = 'work', ownerId = workId` so:
 *   - the legacy `workId`-based read paths keep working unchanged,
 *   - the new `(ownerType, ownerId)`-based read paths can immediately
 *     count the same spend without a separate backfill job.
 *
 * Per-Mission and per-Idea budgets only land when the corresponding
 * UI / API surfaces ship in Phase 7. Until then the columns are
 * present but every row's `ownerType` is `'work'`.
 *
 * Nullability: `ownerType` is NOT NULL with default `'work'` (safe
 * because the same migration adds the column and the default catches
 * any concurrent insert during the API rolling restart window).
 * `ownerId` stays NULLABLE for portability — SQLite (test driver)
 * doesn't reliably support ALTER COLUMN ... SET NOT NULL after
 * backfill; a follow-up migration can tighten once we're confident
 * no read path leaves it NULL.
 *
 * Composite index `(ownerType, ownerId)` per table supports the
 * Phase 7 query "sum spend for this owner this period." Existing
 * single-column `workId` indexes are preserved.
 *
 * Idempotent (hasColumn / index-name checks). Reversible.
 */
export class ExtendBudgetsToPolymorphicOwner1779978002000 implements MigrationInterface {
    private static readonly TABLES = [
        { name: 'work_budgets', indexName: 'idx_work_budgets_owner' },
        { name: 'usage_ledger_entries', indexName: 'idx_usage_ledger_entries_owner' },
        { name: 'plugin_usage_events', indexName: 'idx_plugin_usage_events_owner' },
        { name: 'work_budget_alert_states', indexName: 'idx_work_budget_alert_states_owner' },
    ] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const {
            name: tableName,
            indexName,
        } of ExtendBudgetsToPolymorphicOwner1779978002000.TABLES) {
            if (!(await queryRunner.hasColumn(tableName, 'ownerType'))) {
                await queryRunner.addColumn(
                    tableName,
                    new TableColumn({
                        name: 'ownerType',
                        type: 'varchar',
                        length: '16',
                        isNullable: false,
                        default: "'work'",
                    }),
                );
            }

            if (!(await queryRunner.hasColumn(tableName, 'ownerId'))) {
                await queryRunner.addColumn(
                    tableName,
                    new TableColumn({
                        name: 'ownerId',
                        type: 'uuid',
                        isNullable: true,
                    }),
                );
            }

            // Backfill ownerId for any rows that still have it NULL.
            // Quoted identifiers so both Postgres and SQLite handle the
            // camelCase column names correctly. Empty-table guard not
            // needed — UPDATE on zero rows is a cheap no-op.
            await queryRunner.query(
                `UPDATE "${tableName}" SET "ownerId" = "workId" WHERE "ownerId" IS NULL AND "workId" IS NOT NULL`,
            );

            const table = await queryRunner.getTable(tableName);
            const hasIndex = table?.indices.some((idx) => idx.name === indexName);
            if (!hasIndex) {
                await queryRunner.createIndex(
                    tableName,
                    new TableIndex({
                        name: indexName,
                        columnNames: ['ownerType', 'ownerId'],
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse order — drop index first, then columns.
        for (const { name: tableName, indexName } of [
            ...ExtendBudgetsToPolymorphicOwner1779978002000.TABLES,
        ].reverse()) {
            const table = await queryRunner.getTable(tableName);
            const hasIndex = table?.indices.some((idx) => idx.name === indexName);
            if (hasIndex) {
                await queryRunner.dropIndex(tableName, indexName);
            }

            if (await queryRunner.hasColumn(tableName, 'ownerId')) {
                await queryRunner.dropColumn(tableName, 'ownerId');
            }
            if (await queryRunner.hasColumn(tableName, 'ownerType')) {
                await queryRunner.dropColumn(tableName, 'ownerType');
            }
        }
    }
}
