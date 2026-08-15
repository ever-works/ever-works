import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Autonomy layer — the `goal_events` table (the per-Goal ORCHESTRATOR LOG).
 *
 * The routing decision is the part of an autonomous loop an operator most
 * needs to audit and least can reconstruct afterwards: the iteration Task
 * records the OUTCOME of a decision ("agent X worked on this") but never
 * its REASONING ("iteration 4 went to X because the goal pins no agent
 * and X is next in round-robin over the two agents that have worked this
 * goal"). This table is where that reasoning lives.
 *
 * Rows are immutable and append-only — no `updatedAt`, no update path,
 * the same posture as `goal_metric_samples`. A decision that turned out
 * wrong stays in the log; the correction is a new row.
 *
 * ## Only `goalId` has a foreign key
 *
 * `agentId` and `taskId` are deliberately raw uuid pointers with NO FK.
 * A log line must survive the deletion of the thing it describes: an
 * audit trail that vacates itself the moment an agent is deleted is not
 * an audit trail. `goalId` DOES cascade, because a log line about a
 * deleted Goal has nothing left to explain.
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * Same reason as `workflow_runs` (1784830000000): `ScopeStampingSubscriber`
 * stamps `organizationId` on every insert for any entity declaring both
 * scope columns, so ordinary rows carry both and a copied XOR would abort
 * this migration on real data.
 *
 * Portable DDL via TypeORM's `Table`/`TableIndex`/`TableForeignKey` API —
 * production is Postgres, CI and the e2e stack run better-sqlite3.
 * `metadata` is `text` because that is what `simple-json` maps to on
 * every supported driver.
 *
 * Forward-only with an idempotent guard (house pattern, mirrors
 * 1784830000000-CreateWorkflowRuns).
 */
export class CreateGoalEvents1786900001000 implements MigrationInterface {
    name = 'CreateGoalEvents1786900001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('goal_events')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'goal_events',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'goalId', type: 'uuid' },
                    // Denormalized from the Goal so an owner-scoped read of
                    // the log needs no join.
                    { name: 'userId', type: 'uuid' },
                    // route | dispatch | complete | limit | nudge | control | dod
                    { name: 'kind', type: 'varchar', length: '16' },
                    { name: 'message', type: 'text' },
                    { name: 'agentId', type: 'uuid', isNullable: true },
                    { name: 'taskId', type: 'uuid', isNullable: true },
                    { name: 'iteration', type: 'int', default: 0 },
                    // `simple-json` ⇒ text. Written already bounded by the
                    // orchestrator; never a raw run transcript.
                    { name: 'metadata', type: 'text', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // THE query this table exists to serve: one Goal's log, newest first.
        await queryRunner.createIndex(
            'goal_events',
            new TableIndex({
                name: 'idx_goal_events_goal_created',
                columnNames: ['goalId', 'createdAt'],
            }),
        );
        await queryRunner.createIndex(
            'goal_events',
            new TableIndex({
                name: 'idx_goal_events_goal_iteration',
                columnNames: ['goalId', 'iteration'],
            }),
        );

        // Guarded on the referenced tables existing so this cannot explode
        // on a fresh database whose tables are created in another order.
        if (await queryRunner.hasTable('goals')) {
            await queryRunner.createForeignKey(
                'goal_events',
                new TableForeignKey({
                    name: 'fk_goal_events_goal',
                    columnNames: ['goalId'],
                    referencedTableName: 'goals',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'goal_events',
                new TableForeignKey({
                    name: 'fk_goal_events_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting discards the orchestrator log. Acceptable only because
        // it removes a feature wholesale rather than mangling rows anything
        // else still reads.
        if (await queryRunner.hasTable('goal_events')) {
            await queryRunner.dropTable('goal_events');
        }
    }
}
