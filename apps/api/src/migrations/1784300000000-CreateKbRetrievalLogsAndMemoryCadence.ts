import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Memory cadence + eval loop (memory upgrades M9 + M10).
 *
 * 1. `kb_retrieval_logs` — append-only record of every Knowledge Base
 *    retrieval: which Work, which query, how many documents came back
 *    and which ones. It is a table of its own rather than more
 *    `work_knowledge_citations` rows because a citation row is keyed by
 *    a document FK, so a retrieval that returned NOTHING could not be
 *    represented at all — and those zero-result queries are exactly the
 *    signal the gap-fed synthesis prompt (M11) consumes.
 *    Entity: `packages/agent/src/entities/kb-retrieval-log.entity.ts`.
 *
 * 2. `organizations.memory_consolidation` — nullable `simple-json`
 *    payload of shape `{ enabled?, cadence?, mode?, notify?, lastRunAt? }`
 *    backing the per-org opt-in the `memory-consolidation-tick` cron
 *    reads. NULL (every existing row) means the cadence is OFF, so the
 *    feature is additive by construction — no backfill.
 *
 * `simple-json` maps to `text` on Postgres (prod) and on the
 * better-sqlite3 test/CLI driver, so plain nullable `text` columns are
 * correct — same shape as `1783700000000-AddKbDecisionReviewColumns`.
 *
 * Forward-only and idempotent (`hasTable` / `hasColumn` guarded),
 * matching the house migration pattern.
 */
export class CreateKbRetrievalLogsAndMemoryCadence1784300000000 implements MigrationInterface {
    name = 'CreateKbRetrievalLogsAndMemoryCadence1784300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('kb_retrieval_logs'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'kb_retrieval_logs',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'workId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'query_text', type: 'varchar', length: '512', isNullable: true },
                        { name: 'result_count', type: 'int', default: 0 },
                        { name: 'document_ids', type: 'text', isNullable: true },
                        { name: 'consumer_kind', type: 'varchar', length: '64', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // The health endpoint aggregates "this Work / this org, since
            // T" — both reads are covered by these two composite indexes.
            await queryRunner.createIndex(
                'kb_retrieval_logs',
                new TableIndex({
                    name: 'idx_kb_retrieval_logs_work_created',
                    columnNames: ['workId', 'createdAt'],
                }),
            );
            await queryRunner.createIndex(
                'kb_retrieval_logs',
                new TableIndex({
                    name: 'idx_kb_retrieval_logs_org_created',
                    columnNames: ['organizationId', 'createdAt'],
                }),
            );

            // Retrieval history is meaningless once its Work is gone —
            // and leaving orphans would skew every health metric.
            await queryRunner.createForeignKey(
                'kb_retrieval_logs',
                new TableForeignKey({
                    name: 'fk_kb_retrieval_logs_work',
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasColumn('organizations', 'memory_consolidation'))) {
            await queryRunner.addColumn(
                'organizations',
                new TableColumn({
                    name: 'memory_consolidation',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('organizations', 'memory_consolidation')) {
            await queryRunner.dropColumn('organizations', 'memory_consolidation');
        }
        if (await queryRunner.hasTable('kb_retrieval_logs')) {
            await queryRunner.dropTable('kb_retrieval_logs', true);
        }
    }
}
