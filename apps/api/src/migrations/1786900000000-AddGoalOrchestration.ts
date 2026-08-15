import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Autonomy layer — the `goals` columns behind Definition of Done,
 * per-Goal budgets/limits, and the iteration loop.
 *
 * Every column is ADDITIVE and nullable (or `DEFAULT 0`), so every
 * existing row reads as "no DoD, no limits, loop never started" — which
 * is precisely the metric-only Goal the table already held. Nothing is
 * backfilled and no existing behaviour changes: the metric-evaluation
 * dispatcher still scans `status = 'active' AND nextCheckAt <= now` and
 * never looks at any of this.
 *
 * ## Why `loopStatus` is a new column and not new `status` members
 *
 * `goals.status` drives the evaluation dispatcher's claim predicate, the
 * activate/pause state machine, and the `?status=` list filter — all of
 * which are pinned by e2e specs. A Goal can legitimately be
 * metric-ACTIVE while its iteration loop is paused (or vice versa), so
 * these are two independent axes; folding `cancelled`/`stuck` into
 * `status` would both widen those pinned contracts and make the two
 * meanings inseparable.
 *
 * ## Why spend is stored in CENTS
 *
 * The only thing that ever adds to `spentCents` is
 * `agent_runs.costCents`. Storing dollars would require a lossy
 * conversion on every rollup, which is how a spend ceiling ends up off
 * by a penny per run and then off by a dollar per day.
 *
 * Portable per-column guards (house pattern, mirrors
 * 1784800000000-AddTaskDelegationDepth): `ALTER TABLE ... ADD COLUMN`
 * with a `findColumnByName` check works identically on Postgres and
 * better-sqlite3, and re-running the migration is a no-op.
 */
export class AddGoalOrchestration1786900000000 implements MigrationInterface {
    name = 'AddGoalOrchestration1786900000000';

    /**
     * `simple-json` maps to `text` on every driver this repo supports, so
     * the DoD column is declared `text` rather than `jsonb` — the same
     * choice `goals.criteria` / `goals.constraints` already made.
     */
    private static readonly COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
        { name: 'dodCriteria', ddl: 'text' },
        { name: 'spendCapCents', ddl: 'integer' },
        { name: 'spentCents', ddl: 'integer NOT NULL DEFAULT 0' },
        { name: 'wallClockLimitHours', ddl: 'integer' },
        { name: 'stuckThresholdIterations', ddl: 'integer' },
        { name: 'sessionBudgetMinutes', ddl: 'integer' },
        { name: 'gracePeriodMinutes', ddl: 'integer' },
        { name: 'executionTarget', ddl: 'varchar(16)' },
        { name: 'plannerModelHint', ddl: 'varchar(120)' },
        { name: 'workerModelHint', ddl: 'varchar(120)' },
        { name: 'iteration', ddl: 'integer NOT NULL DEFAULT 0' },
        { name: 'lastProgressIteration', ddl: 'integer NOT NULL DEFAULT 0' },
        { name: 'activeAgentId', ddl: 'uuid' },
        { name: 'assignedAgentId', ddl: 'uuid' },
        { name: 'loopStatus', ddl: 'varchar(16)' },
        { name: 'loopStartedAt', ddl: 'timestamp' },
        { name: 'archivedAt', ddl: 'timestamp' },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;

        for (const column of AddGoalOrchestration1786900000000.COLUMNS) {
            if (!table.findColumnByName(column.name)) {
                await queryRunner.query(
                    `ALTER TABLE "goals" ADD COLUMN "${column.name}" ${column.ddl}`,
                );
            }
        }

        // The orchestrator's due-scan predicate. NULL loopStatus (every
        // Goal that never started a loop) is excluded by the equality, so
        // the per-minute cron's cheap case is one indexed lookup.
        const refreshed = await queryRunner.getTable('goals');
        if (refreshed && !refreshed.indices.some((i) => i.name === 'idx_goals_loop_status')) {
            await queryRunner.createIndex(
                'goals',
                new TableIndex({ name: 'idx_goals_loop_status', columnNames: ['loopStatus'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;

        if (table.indices.some((i) => i.name === 'idx_goals_loop_status')) {
            await queryRunner.dropIndex('goals', 'idx_goals_loop_status');
        }

        // Reverting DISCARDS operator-authored Definition-of-Done text and
        // the configured spend ceilings. That is a real data loss, but it
        // is confined to a feature this migration introduced wholesale —
        // no column here is read by anything that predates it — so an
        // operator running the revert is choosing to remove the feature,
        // not corrupting rows something else still depends on.
        for (const column of AddGoalOrchestration1786900000000.COLUMNS) {
            if (table.findColumnByName(column.name)) {
                await queryRunner.query(`ALTER TABLE "goals" DROP COLUMN "${column.name}"`);
            }
        }
    }
}
