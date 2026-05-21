import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `work_knowledge_documents` — the typed Knowledge Base
 * document table. See `docs/specs/features/knowledge-base/spec.md` §6.1
 * for the full column contract.
 *
 * The `work_knowledge_documents_scope_xor` CHECK constraint enforces
 * the invariant that a document is either Work-scoped (`workId IS NOT
 * NULL`) or organization-scoped (`organizationId IS NOT NULL`) but
 * never both, never neither. Org-scoped docs are restricted at the
 * service layer to `kbDocumentClass IN ('legal', 'style', 'seo')` in
 * v1.
 *
 * EW-639 / EW-640.
 */
export class CreateWorkKnowledgeDocuments1779971000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const uuidDefault = isPostgres ? 'DEFAULT gen_random_uuid()' : '';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_documents" (
                "id" uuid PRIMARY KEY ${uuidDefault},
                "workId" uuid NULL REFERENCES "works"("id") ON DELETE CASCADE,
                "organizationId" uuid NULL,
                "path" varchar(512) NOT NULL,
                "slug" varchar(255) NOT NULL,
                "title" varchar(255) NOT NULL,
                "description" text NULL,
                "kb_document_class" varchar NOT NULL,
                "tags" text NULL,
                "categories" text NULL,
                "status" varchar NOT NULL DEFAULT 'active',
                "locked" boolean NOT NULL DEFAULT false,
                "lock_mode" varchar NULL,
                "language" varchar(8) NOT NULL DEFAULT 'en',
                "word_count" int NULL,
                "token_count" int NULL,
                "source" varchar NOT NULL DEFAULT 'user',
                "source_upload_id" uuid NULL,
                "source_url" varchar(2048) NULL,
                "generated_by_agent_run_id" uuid NULL,
                "created_by_id" uuid NULL,
                "updated_by_id" uuid NULL,
                "last_indexed_at" bigint NULL,
                "last_commit_sha" varchar(40) NULL,
                "metadata" text NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "work_knowledge_documents_scope_xor" CHECK (
                    ("workId" IS NOT NULL AND "organizationId" IS NULL)
                    OR
                    ("workId" IS NULL AND "organizationId" IS NOT NULL)
                )
            )
        `);

        // Composite + filter indexes per spec §6.1
        await queryRunner.query(
            `CREATE INDEX "idx_wkd_work_class" ON "work_knowledge_documents"("workId","kb_document_class")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wkd_org_class" ON "work_knowledge_documents"("organizationId","kb_document_class")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wkd_work_status" ON "work_knowledge_documents"("workId","status")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wkd_work_updated" ON "work_knowledge_documents"("workId","updatedAt")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkd_work_updated"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkd_work_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkd_org_class"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkd_work_class"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_documents"`);
    }
}
