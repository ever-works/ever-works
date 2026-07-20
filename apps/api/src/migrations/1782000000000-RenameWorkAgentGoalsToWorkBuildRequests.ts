import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Frees the name "Goal" (review §23.3, operator ruling 2026-07-19).
 *
 * The `work_agent_goals` table never stored goals in the product sense —
 * each row is a queued BUILD REQUEST for the autonomous Work agent. The
 * name "Goal" is reserved for the upcoming measurable-outcome entity, so
 * this migration renames the queue at the storage layer:
 *
 *   - table  `work_agent_goals`        → `work_build_requests`
 *   - column `work_agent_runs.goalId`  → `work_agent_runs.buildRequestId`
 *
 * and keeps the explicitly-named indexes/constraints from the original
 * create migrations (`1779700000000-AddWorkAgentControlPlane`,
 * `1779978006000-AddIdeaIdToWorkAgentGoal`) in step with the new name:
 *
 *   - idx_work_agent_goals_user_status_created → idx_work_build_requests_user_status_created
 *   - idx_work_agent_goals_idea                → idx_work_build_requests_idea
 *   - fk_work_agent_goals_user                 → fk_work_build_requests_user
 *   - fk_work_agent_goals_idea                 → fk_work_build_requests_idea
 *   - fk_work_agent_runs_goal                  → fk_work_agent_runs_build_request
 *
 * Auto-generated names (e.g. the PK) are left alone — Postgres keeps them
 * working after a table rename.
 *
 * Postgres-only (dev/CI use SQLite + `synchronize`, which creates the
 * tables straight from the renamed entities). IDEMPOTENT: every step is
 * guarded on the current catalog state, and the whole up() is skipped
 * when the target table already exists.
 */
export class RenameWorkAgentGoalsToWorkBuildRequests1782000000000 implements MigrationInterface {
    name = 'RenameWorkAgentGoalsToWorkBuildRequests1782000000000';

    private async indexExists(queryRunner: QueryRunner, index: string): Promise<boolean> {
        const rows: Array<{ exists: boolean }> = await queryRunner.query(
            `SELECT EXISTS (
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'i' AND c.relname = $1 AND n.nspname = current_schema()
            ) AS "exists"`,
            [index],
        );
        return rows[0]?.exists === true;
    }

    private async constraintExists(
        queryRunner: QueryRunner,
        table: string,
        constraint: string,
    ): Promise<boolean> {
        const rows: Array<{ exists: boolean }> = await queryRunner.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.table_constraints
                WHERE constraint_name = $1
                  AND table_name = $2
                  AND table_schema = current_schema()
            ) AS "exists"`,
            [constraint, table],
        );
        return rows[0]?.exists === true;
    }

    private async renameIndex(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
        if (
            (await this.indexExists(queryRunner, from)) &&
            !(await this.indexExists(queryRunner, to))
        ) {
            await queryRunner.query(`ALTER INDEX "${from}" RENAME TO "${to}"`);
        }
    }

    private async renameConstraint(
        queryRunner: QueryRunner,
        table: string,
        from: string,
        to: string,
    ): Promise<void> {
        if (
            (await this.constraintExists(queryRunner, table, from)) &&
            !(await this.constraintExists(queryRunner, table, to))
        ) {
            await queryRunner.query(
                `ALTER TABLE "${table}" RENAME CONSTRAINT "${from}" TO "${to}"`,
            );
        }
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        // 1. Table rename (skip entirely when the target already exists —
        //    fresh DBs created after the rename land here).
        if (
            (await queryRunner.hasTable('work_agent_goals')) &&
            !(await queryRunner.hasTable('work_build_requests'))
        ) {
            await queryRunner.query(
                `ALTER TABLE "work_agent_goals" RENAME TO "work_build_requests"`,
            );
        }

        if (await queryRunner.hasTable('work_build_requests')) {
            // 2. Named indexes/constraints from the original create migrations.
            await this.renameIndex(
                queryRunner,
                'idx_work_agent_goals_user_status_created',
                'idx_work_build_requests_user_status_created',
            );
            await this.renameIndex(
                queryRunner,
                'idx_work_agent_goals_idea',
                'idx_work_build_requests_idea',
            );
            await this.renameConstraint(
                queryRunner,
                'work_build_requests',
                'fk_work_agent_goals_user',
                'fk_work_build_requests_user',
            );
            await this.renameConstraint(
                queryRunner,
                'work_build_requests',
                'fk_work_agent_goals_idea',
                'fk_work_build_requests_idea',
            );
        }

        // 3. work_agent_runs.goalId → buildRequestId (+ its named FK).
        if (await queryRunner.hasTable('work_agent_runs')) {
            if (
                (await queryRunner.hasColumn('work_agent_runs', 'goalId')) &&
                !(await queryRunner.hasColumn('work_agent_runs', 'buildRequestId'))
            ) {
                await queryRunner.query(
                    `ALTER TABLE "work_agent_runs" RENAME COLUMN "goalId" TO "buildRequestId"`,
                );
            }
            await this.renameConstraint(
                queryRunner,
                'work_agent_runs',
                'fk_work_agent_runs_goal',
                'fk_work_agent_runs_build_request',
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }

        if (await queryRunner.hasTable('work_agent_runs')) {
            await this.renameConstraint(
                queryRunner,
                'work_agent_runs',
                'fk_work_agent_runs_build_request',
                'fk_work_agent_runs_goal',
            );
            if (
                (await queryRunner.hasColumn('work_agent_runs', 'buildRequestId')) &&
                !(await queryRunner.hasColumn('work_agent_runs', 'goalId'))
            ) {
                await queryRunner.query(
                    `ALTER TABLE "work_agent_runs" RENAME COLUMN "buildRequestId" TO "goalId"`,
                );
            }
        }

        if (await queryRunner.hasTable('work_build_requests')) {
            await this.renameConstraint(
                queryRunner,
                'work_build_requests',
                'fk_work_build_requests_idea',
                'fk_work_agent_goals_idea',
            );
            await this.renameConstraint(
                queryRunner,
                'work_build_requests',
                'fk_work_build_requests_user',
                'fk_work_agent_goals_user',
            );
            await this.renameIndex(
                queryRunner,
                'idx_work_build_requests_idea',
                'idx_work_agent_goals_idea',
            );
            await this.renameIndex(
                queryRunner,
                'idx_work_build_requests_user_status_created',
                'idx_work_agent_goals_user_status_created',
            );
            if (!(await queryRunner.hasTable('work_agent_goals'))) {
                await queryRunner.query(
                    `ALTER TABLE "work_build_requests" RENAME TO "work_agent_goals"`,
                );
            }
        }
    }
}
