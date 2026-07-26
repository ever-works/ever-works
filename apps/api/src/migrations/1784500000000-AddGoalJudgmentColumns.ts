import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Judgment layer G1 — weighted criteria + hard constraints on `goals`.
 *
 *  - `criteria`      — `GoalCriterion[]`: (name, metric ref, weight,
 *                      target, direction). NULL/empty = the single-metric
 *                      Goal this table has always held, evaluated by
 *                      `metricSource` + `comparator` + `targetValue`
 *                      exactly as before.
 *  - `constraints`   — `GoalConstraint[]`: rules that must hold. A
 *                      violated HARD constraint vetoes ACHIEVED and
 *                      raises an escalation (G3).
 *  - `resolvedScore` — the last weighted score + per-criterion
 *                      breakdown, written only on the weighted path.
 *
 * All three are `simple-json` on the entity, which is plain `text` at the
 * DB level on every supported driver (Postgres in prod, sqlite in e2e) —
 * the same storage `goals.metricSource` already uses.
 *
 * **Nothing is backfilled.** Every existing Goal keeps NULL in all three
 * columns, which the evaluation service reads as "single-metric Goal" and
 * routes down the untouched original path. That is the whole additivity
 * guarantee for this feature, and it is enforced by one predicate
 * (`hasWeightedCriteria`) rather than by carefully-mirrored branches.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784100000000-AddRunSteeringColumns). No index: these columns are only
 * ever read on a row already selected by (status, nextCheckAt) or by PK.
 */
export class AddGoalJudgmentColumns1784500000000 implements MigrationInterface {
    name = 'AddGoalJudgmentColumns1784500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "goals" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('criteria', `"criteria" text`);
        await addColumn('constraints', `"constraints" text`);
        await addColumn('resolvedScore', `"resolvedScore" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('goals');
        if (!table) return;
        for (const col of ['resolvedScore', 'constraints', 'criteria']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "goals" DROP COLUMN "${col}"`);
            }
        }
    }
}
