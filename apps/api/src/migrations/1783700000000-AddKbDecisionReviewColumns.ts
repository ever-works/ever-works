import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Decision documents + review states (memory upgrades M4 + M7).
 *
 * `work_knowledge_documents.decision` — nullable `simple-json` payload
 * of shape `{ status: 'proposed' | 'accepted' | 'superseded' |
 * 'archived'; supersededByDocId?; supersededBySlug?; supersedesDocId?;
 * rationale? }` backing the `decision` KB class status machine (see
 * `packages/agent/src/entities/kb-types.ts` —
 * `KB_DECISION_STATUS_TRANSITIONS`). `NULL` = a non-decision document.
 *
 * `work_knowledge_documents.review_state` — nullable varchar
 * (`'proposed' | 'accepted'`). Agent-authored / consolidation-
 * synthesized documents land as `proposed` and are excluded from
 * context injection until accepted via the review-action endpoints.
 * `NULL` (every pre-existing row + all human-authored docs) is treated
 * as `accepted`, so the feature is additive by construction — no
 * backfill needed.
 *
 * `simple-json` maps to `text` on every supported driver (Postgres in
 * prod, SQLite in the test/CLI adapter), so a plain nullable `text`
 * column is correct — same as `1782000000000-AddKbDocumentConsolidation`.
 *
 * Forward-only and idempotent (`hasColumn`-guarded), matching the house
 * migration pattern.
 */
export class AddKbDecisionReviewColumns1783700000000 implements MigrationInterface {
    name = 'AddKbDecisionReviewColumns1783700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('work_knowledge_documents', 'decision'))) {
            await queryRunner.addColumn(
                'work_knowledge_documents',
                new TableColumn({
                    name: 'decision',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('work_knowledge_documents', 'review_state'))) {
            await queryRunner.addColumn(
                'work_knowledge_documents',
                new TableColumn({
                    name: 'review_state',
                    type: 'varchar',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('work_knowledge_documents', 'review_state')) {
            await queryRunner.dropColumn('work_knowledge_documents', 'review_state');
        }
        if (await queryRunner.hasColumn('work_knowledge_documents', 'decision')) {
            await queryRunner.dropColumn('work_knowledge_documents', 'decision');
        }
    }
}
