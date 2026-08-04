import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Judgment layer G5 — the `workflow_runs` table.
 *
 * PR #1986 made a graph something a user OWNS. This makes running one
 * leave a TRACE: until now the only way to execute a graph was an agent
 * chat tool whose result was handed to a model and then discarded, so
 * nothing could be reviewed or debugged after the fact.
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * Same reason as `workflows` (1784820000000): `ScopeStampingSubscriber`
 * stamps `organizationId` on EVERY insert for any entity declaring both
 * scope columns, so ordinary rows have both populated and a copied XOR
 * would abort this migration on real data. That is not hypothetical — it
 * happened once already when the pattern was copied onto
 * `work_knowledge_uploads`.
 *
 * ## `workflowId` CASCADEs, and that is a deliberate reversal
 *
 * `workflows.controller.ts` currently claims deleting a workflow leaves
 * run records "unaffected". That was written before this table existed
 * and is not the behaviour shipped here: the FK below is `ON DELETE
 * CASCADE`, matching `agent_runs`' documented posture on `agents.id`
 * ("archiving an Agent does NOT lose run history but delete-Agent DOES").
 *
 * The alternative — no FK, letting run rows outlive their graph — leaves
 * permanent orphans whose `workflowId` points at nothing, in a table that
 * only grows, for rows nobody can interpret without the graph they ran.
 * A workflow is authored configuration and its delete is already a hard
 * delete; removing it removes the feature wholesale, history included.
 * The stale docstring is corrected in the same change so the code and the
 * comment agree.
 *
 * ## Portable DDL
 *
 * Built with TypeORM's `Table`/`TableIndex`/`TableForeignKey` API rather
 * than raw SQL, because production is Postgres while CI and the e2e stack
 * run better-sqlite3. Raw `gen_random_uuid()` / `CREATE INDEX IF NOT
 * EXISTS` would work in prod and fail every CI run.
 *
 * `trace` and `output` are `text` — what TypeORM's `simple-json` maps to
 * on every supported driver. Both are written already CAPPED by
 * `summarizeWorkflowRun`; the raw `nodeOutputs` map (which can hold whole
 * Knowledge Base documents for a `kb.search` node) is never persisted.
 *
 * Forward-only with an idempotent guard (house pattern, mirrors
 * 1784820000000-CreateWorkflows).
 */
export class CreateWorkflowRuns1784830000000 implements MigrationInterface {
    name = 'CreateWorkflowRuns1784830000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('workflow_runs')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'workflow_runs',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'workflowId', type: 'uuid' },
                    // Denormalized from the workflow so an owner-scoped
                    // read of a run needs no join.
                    { name: 'userId', type: 'uuid' },
                    // queued | running | completed | failed | cancelled.
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'triggerRunId', type: 'varchar', length: '64', isNullable: true },
                    { name: 'startedAt', type: 'timestamp', isNullable: true },
                    { name: 'finishedAt', type: 'timestamp', isNullable: true },
                    { name: 'durationMs', type: 'int', isNullable: true },
                    { name: 'errorMessage', type: 'text', isNullable: true },
                    // The capped walk record. `simple-json` ⇒ text.
                    { name: 'trace', type: 'text', isNullable: true },
                    { name: 'output', type: 'text', isNullable: true },
                    { name: 'outputTruncated', type: 'boolean', default: false },
                    { name: 'failureCode', type: 'varchar', length: '64', isNullable: true },
                    { name: 'failedNodeId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'stepCount', type: 'int', default: 0 },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // The run-history list for one workflow, newest first, is the
        // query this table exists to serve. Mirrors
        // `idx_agent_runs_agent_started`.
        await queryRunner.createIndex(
            'workflow_runs',
            new TableIndex({
                name: 'idx_workflow_runs_workflow_started',
                columnNames: ['workflowId', 'startedAt'],
            }),
        );
        await queryRunner.createIndex(
            'workflow_runs',
            new TableIndex({ name: 'idx_workflow_runs_status', columnNames: ['status'] }),
        );
        await queryRunner.createIndex(
            'workflow_runs',
            new TableIndex({ name: 'idx_workflow_runs_user', columnNames: ['userId'] }),
        );
        await queryRunner.createIndex(
            'workflow_runs',
            new TableIndex({ name: 'idx_workflow_runs_org', columnNames: ['organizationId'] }),
        );

        // Both FKs are guarded on the referenced table existing so this
        // cannot explode on a fresh database whose tables are created in a
        // different order.
        if (await queryRunner.hasTable('workflows')) {
            await queryRunner.createForeignKey(
                'workflow_runs',
                new TableForeignKey({
                    name: 'fk_workflow_runs_workflow',
                    columnNames: ['workflowId'],
                    referencedTableName: 'workflows',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'workflow_runs',
                new TableForeignKey({
                    name: 'fk_workflow_runs_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting discards run history. Acceptable only because it
        // removes a feature wholesale rather than mangling rows something
        // else still reads; an operator running it is choosing that.
        if (await queryRunner.hasTable('workflow_runs')) {
            await queryRunner.dropTable('workflow_runs');
        }
    }
}
