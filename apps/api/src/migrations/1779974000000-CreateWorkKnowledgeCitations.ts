import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `work_knowledge_citations` — append-only audit log of every
 * time a KB document was used as context by an agent run, generation
 * pipeline, AI conversation message, community PR proposal, or
 * comparison generator run. See spec §6.4.
 *
 * `consumer_id` is polymorphic by `consumer_type` — no FK because
 * TypeORM 0.3.x doesn't support polymorphic FKs cleanly. Integrity is
 * enforced at the service layer.
 *
 * EW-639 / EW-640.
 */
export class CreateWorkKnowledgeCitations1779974000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const uuidDefault = isPostgres ? 'DEFAULT gen_random_uuid()' : '';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_citations" (
                "id" uuid PRIMARY KEY ${uuidDefault},
                "workId" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
                "document_id" uuid NOT NULL REFERENCES "work_knowledge_documents"("id") ON DELETE CASCADE,
                "consumer_type" varchar NOT NULL,
                "consumer_id" uuid NOT NULL,
                "chunk_range" text NULL,
                "relevance_score" double precision NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await queryRunner.query(
            `CREATE INDEX "idx_wkc_doc_created" ON "work_knowledge_citations"("document_id","createdAt")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wkc_consumer" ON "work_knowledge_citations"("consumer_type","consumer_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wkc_work_created" ON "work_knowledge_citations"("workId","createdAt")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkc_work_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkc_consumer"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkc_doc_created"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_citations"`);
    }
}
