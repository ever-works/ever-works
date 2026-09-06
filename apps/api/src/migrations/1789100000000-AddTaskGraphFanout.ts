import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Multi-repo decomposition + task-graph fan-out (self-build slice AH,
 * EW-801).
 *
 * Three additive, nullable columns; no indexes, no foreign keys:
 *
 *  1. `task_template_steps.workId` — the Work THIS step files its
 *     sub-task against, so one template can span repositories ("spec in
 *     the platform, docs in the website"). No FK, for the same reason
 *     `task_template_steps.agentId` has none: the Work may be deleted
 *     independently of the template, and reachability is re-checked
 *     against the acting user at instantiation. No index either — steps
 *     are only ever read by `templateId`
 *     (`idx_task_template_steps_template`).
 *  2. `task_template_steps.extraRepos` — the per-step half of
 *     `tasks.extraRepos`: `{ repoConnectionId, mountDir?, writable? }`
 *     entries stored as `simple-json`, byte-identical in DDL to
 *     `tasks.extraRepos` (1787900000000) and to `dependsOn` on this very
 *     table (1786860001000).
 *  3. `goals.maxConcurrentIterations` — how many iterations a Goal's
 *     loop may run at once. NULL on every existing row, which reads as
 *     ONE: the serial loop those Goals have always run. No Goal changes
 *     speed because of this migration.
 *
 * Forward-only with existence guards so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddTaskGraphFanout1789100000000 implements MigrationInterface {
    name = 'AddTaskGraphFanout1789100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const steps = await queryRunner.getTable('task_template_steps');
        if (steps && !steps.findColumnByName('workId')) {
            await queryRunner.addColumn(
                'task_template_steps',
                new TableColumn({ name: 'workId', type: 'uuid', isNullable: true }),
            );
        }
        if (steps && !steps.findColumnByName('extraRepos')) {
            await queryRunner.addColumn(
                'task_template_steps',
                new TableColumn({ name: 'extraRepos', type: 'text', isNullable: true }),
            );
        }
        const goals = await queryRunner.getTable('goals');
        if (goals && !goals.findColumnByName('maxConcurrentIterations')) {
            await queryRunner.addColumn(
                'goals',
                new TableColumn({
                    name: 'maxConcurrentIterations',
                    type: 'int',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const goals = await queryRunner.getTable('goals');
        if (goals?.findColumnByName('maxConcurrentIterations')) {
            await queryRunner.dropColumn('goals', 'maxConcurrentIterations');
        }
        const steps = await queryRunner.getTable('task_template_steps');
        if (steps?.findColumnByName('extraRepos')) {
            await queryRunner.dropColumn('task_template_steps', 'extraRepos');
        }
        // Re-read: dropColumn on sqlite rebuilds the table, so the
        // metadata captured above is stale for the second drop.
        const stepsAfter = await queryRunner.getTable('task_template_steps');
        if (stepsAfter?.findColumnByName('workId')) {
            await queryRunner.dropColumn('task_template_steps', 'workId');
        }
    }
}
