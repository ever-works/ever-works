import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-build slice AG (EW-795) — the `goals.goalKind` discriminator and
 * the four metric columns going nullable.
 *
 * ## Why
 *
 * "Ship feature X across three repos" could not be represented: the only
 * multi-iteration autonomous driver on the platform demanded a metrics
 * plugin and a numeric target because `metricSource`, `comparator`,
 * `targetValue` and `unit` were all NOT NULL. A **delivery** Goal has none
 * of those — it completes on its approved Definition of Done alone — so
 * the four columns become nullable and `goalKind` says which rule applies.
 *
 * ## What existing rows read as
 *
 * `goalKind` is added as `varchar(16) NOT NULL DEFAULT 'metric'`, so the
 * DEFAULT backfills every existing row to `'metric'` inside the same
 * `ALTER TABLE` on Postgres and better-sqlite3 alike (the same mechanism
 * the `integer NOT NULL DEFAULT 0` counters in 1786900000000 rely on) —
 * no UPDATE pass, and every pre-existing Goal keeps behaving exactly as
 * the metric Goal it always was. Their four metric columns are still
 * populated; only the CONSTRAINT relaxes.
 *
 * ## Portability
 *
 * The DROP NOT NULL uses TypeORM's `changeColumn` on a cloned column
 * descriptor (precedent: 1781200000000-RelaxTenantJobRuntimeAuditTenantNullable):
 * `ALTER COLUMN ... DROP NOT NULL` on Postgres, a table recreate on the
 * sqlite test driver — with indexes and the other columns carried across.
 * Every step is guarded by `findColumnByName` / `isNullable`, so re-running
 * the migration is a no-op.
 */
export class AddGoalKind1788700000000 implements MigrationInterface {
    name = 'AddGoalKind1788700000000';

    /** The four columns a delivery Goal leaves NULL. */
    private static readonly METRIC_COLUMNS = ['metricSource', 'comparator', 'targetValue', 'unit'];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;

        if (!table.findColumnByName('goalKind')) {
            await queryRunner.query(
                `ALTER TABLE "goals" ADD COLUMN "goalKind" varchar(16) NOT NULL DEFAULT 'metric'`,
            );
        }

        for (const name of AddGoalKind1788700000000.METRIC_COLUMNS) {
            // Re-read on every step: on sqlite `changeColumn` recreates the
            // table, so a descriptor captured before it is stale.
            const refreshed = await queryRunner.getTable('goals');
            const column = refreshed?.findColumnByName(name);
            if (!column || column.isNullable) continue;
            const updated = column.clone();
            updated.isNullable = true;
            await queryRunner.changeColumn('goals', column, updated);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;

        // Reverting REMOVES delivery Goals: they have no metric fields, so
        // re-tightening NOT NULL below could not succeed while they exist.
        // That is a real data loss, but it is confined to the feature this
        // migration introduced — no delivery row can predate it — so an
        // operator running the revert is choosing to remove the feature,
        // the same posture 1786900000000's down() takes with the DoD text.
        if (table.findColumnByName('goalKind')) {
            await queryRunner.query(`DELETE FROM "goals" WHERE "goalKind" = 'delivery'`);
        }

        for (const name of AddGoalKind1788700000000.METRIC_COLUMNS) {
            const refreshed = await queryRunner.getTable('goals');
            const column = refreshed?.findColumnByName(name);
            if (!column || !column.isNullable) continue;
            const updated = column.clone();
            updated.isNullable = false;
            await queryRunner.changeColumn('goals', column, updated);
        }

        // TypeORM's own primitive rather than a raw `ALTER TABLE ... DROP
        // COLUMN`: sqlite only learned that statement in 3.35, and on sqlite
        // TypeORM drops a column by recreating the table — which also keeps
        // the query runner's table metadata in step with the physical schema
        // for anything that runs after this migration in the same runner.
        const refreshed = await queryRunner.getTable('goals');
        const goalKind = refreshed?.findColumnByName('goalKind');
        if (goalKind) {
            await queryRunner.dropColumn('goals', goalKind);
        }
    }
}
