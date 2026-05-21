import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `work_knowledge_tags` — per-Work tag catalog for KB
 * documents. See spec §6.3.
 *
 * Tags on documents are stored as a simple-json string-array on
 * `work_knowledge_documents.tags`; this table provides normalization
 * (name, color token, description) for UI autocomplete and filter
 * chips. The unique constraint on `(workId, slug)` is what prevents
 * accidental duplicates from inline-create-on-first-use flows.
 *
 * EW-639 / EW-640.
 */
export class CreateWorkKnowledgeTags1779973000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const uuidDefault = isPostgres ? 'DEFAULT gen_random_uuid()' : '';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_tags" (
                "id" uuid PRIMARY KEY ${uuidDefault},
                "workId" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
                "slug" varchar(64) NOT NULL,
                "name" varchar(128) NOT NULL,
                "color" varchar(16) NULL,
                "description" text NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "uq_wkt_work_slug" UNIQUE ("workId","slug")
            )
        `);

        await queryRunner.query(
            `CREATE INDEX "idx_wkt_work_slug" ON "work_knowledge_tags"("workId","slug")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkt_work_slug"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_tags"`);
    }
}
