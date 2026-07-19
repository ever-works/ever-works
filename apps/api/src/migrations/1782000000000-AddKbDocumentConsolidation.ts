import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Memory Consolidation — adds the nullable `consolidation` marker column
 * to `work_knowledge_documents`.
 *
 * The column backs the on-demand "Consolidate" pass over org-wide Memory
 * (`POST /api/memory/consolidate`): a `simple-json` payload of shape
 * `{ state: 'promoted' | 'superseded'; supersededById?; reason; score?;
 * runAt }` (see `packages/agent/src/services/memory-consolidation.ts`).
 * `NULL` = a normal document untouched by consolidation, so existing
 * rows and installs that never run consolidation are completely
 * unaffected — the feature is additive by construction.
 *
 * `simple-json` maps to `text` on every supported driver (Postgres in
 * prod, SQLite in the test/CLI adapter), so a plain nullable `text`
 * column is correct here — no driver branch needed.
 *
 * Forward-only and idempotent (`hasColumn`-guarded), matching the house
 * migration pattern.
 */
export class AddKbDocumentConsolidation1782000000000 implements MigrationInterface {
    name = 'AddKbDocumentConsolidation1782000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('work_knowledge_documents', 'consolidation'))) {
            await queryRunner.addColumn(
                'work_knowledge_documents',
                new TableColumn({
                    name: 'consolidation',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('work_knowledge_documents', 'consolidation')) {
            await queryRunner.dropColumn('work_knowledge_documents', 'consolidation');
        }
    }
}
