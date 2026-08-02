import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Judgment layer G5 — the `workflows` table.
 *
 * `WorkflowGraphExecutorService` could already execute a graph, and its
 * only caller was an agent chat tool handed an inline, model-authored
 * one. So a graph could be RUN but never KEPT: nothing could be authored
 * once and re-run, and no UI could point at one. This is the row that
 * makes a workflow something a user owns.
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * `work_knowledge_documents` carries a CHECK enforcing that exactly one
 * of `workId` / `organizationId` is set. Copying it here would abort the
 * migration — and that is not hypothetical, it happened once already
 * when the pattern was copied onto `work_knowledge_uploads`.
 * `ScopeStampingSubscriber` stamps `organizationId` on EVERY insert for
 * any entity declaring both `tenantId` and `organizationId`, so ordinary
 * rows have BOTH populated and the XOR fails on real data.
 *
 * Here `workId` is an optional NARROWING — "this workflow belongs to one
 * Work" — never an alternative to the organization. No constraint should
 * encode a relationship the stamping subscriber contradicts.
 *
 * ## Portable DDL
 *
 * Built with TypeORM's `Table`/`TableIndex`/`TableForeignKey` API rather
 * than raw SQL, because the e2e stack and CI run better-sqlite3 while
 * production runs Postgres. Raw `gen_random_uuid()` /
 * `CREATE INDEX IF NOT EXISTS` would work in prod and fail every CI run.
 *
 * `graph` is `text` (what TypeORM's `simple-json` maps to on every
 * supported driver) holding the whole `WorkflowGraph`. Nodes and edges
 * are only ever read and written WHOLE — the executor takes a complete
 * graph, validates it and walks it — so separate tables would buy
 * referential integrity over a structure nothing queries into, at the
 * cost of a join-heavy read and a migration per future node kind.
 * `validateWorkflowGraph` is the integrity check, applied on write.
 *
 * Forward-only with an idempotent guard (house pattern, mirrors
 * 1784780000000-CreateToolGrants).
 */
export class CreateWorkflows1784820000000 implements MigrationInterface {
    name = 'CreateWorkflows1784820000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('workflows')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'workflows',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '200' },
                    { name: 'description', type: 'text', isNullable: true },
                    { name: 'status', type: 'varchar', length: '16', default: "'draft'" },
                    // The whole graph. `simple-json` ⇒ text on every driver.
                    { name: 'graph', type: 'text' },
                    // Optional narrowing to one Work. NOT an XOR partner
                    // for organizationId — see the class note.
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    // Denormalized display state so a list view needs no
                    // aggregate join. Advisory: the authoritative record
                    // of a run is its own row (a later slice).
                    { name: 'runCount', type: 'int', default: 0 },
                    { name: 'lastRunAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'workflows',
            new TableIndex({
                name: 'idx_workflows_user_status',
                columnNames: ['userId', 'status'],
            }),
        );
        await queryRunner.createIndex(
            'workflows',
            new TableIndex({ name: 'idx_workflows_org', columnNames: ['organizationId'] }),
        );
        await queryRunner.createIndex(
            'workflows',
            new TableIndex({ name: 'idx_workflows_work', columnNames: ['workId'] }),
        );

        // Guarded on the table existing: the migration must not explode
        // on a fresh database whose user table has not been created yet.
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'workflows',
                new TableForeignKey({
                    name: 'fk_workflows_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // This DOES destroy user-authored content — unlike the additive
        // column migrations around it, reverting here discards every
        // saved workflow. Acceptable only because it removes a feature
        // wholesale rather than mangling rows something else still
        // reads; an operator running it is choosing that.
        if (await queryRunner.hasTable('workflows')) {
            await queryRunner.dropTable('workflows');
        }
    }
}
