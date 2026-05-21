import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `work_knowledge_uploads` — original uploaded source files
 * backing KB documents. See spec §6.2.
 *
 * File bytes live in the Work's configured Storage plugin
 * (`github-storage` / `aws-s3` / `minio` / `local-fs`); this row holds
 * the metadata + extraction lifecycle.
 *
 * Dedup by `(workId, sha256)` via the `idx_wku_work_sha256` index;
 * uniqueness is enforced at the service layer (not as a UNIQUE
 * constraint) so the same SHA can intentionally back multiple distinct
 * upload rows during a re-upload-after-tombstone race.
 *
 * EW-639 / EW-640.
 */
export class CreateWorkKnowledgeUploads1779972000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const uuidDefault = isPostgres ? 'DEFAULT gen_random_uuid()' : '';
        const bigintType = isPostgres ? 'BIGINT' : 'BIGINT';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_uploads" (
                "id" uuid PRIMARY KEY ${uuidDefault},
                "workId" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
                "storage_provider" varchar(64) NOT NULL,
                "storage_path" varchar(1024) NOT NULL,
                "original_filename" varchar(512) NOT NULL,
                "mime_type" varchar(128) NOT NULL,
                "file_size" ${bigintType} NOT NULL,
                "sha256" varchar(64) NOT NULL,
                "normalized_format" varchar(64) NULL,
                "extraction_status" varchar NOT NULL DEFAULT 'pending',
                "extraction_plugin_id" varchar(64) NULL,
                "extraction_error" text NULL,
                "extraction_started_at" bigint NULL,
                "extraction_finished_at" bigint NULL,
                "extracted_document_id" uuid NULL REFERENCES "work_knowledge_documents"("id") ON DELETE SET NULL,
                "uploaded_by_id" uuid NULL,
                "tags" text NULL,
                "categories" text NULL,
                "metadata" text NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await queryRunner.query(
            `CREATE INDEX "idx_wku_work_status" ON "work_knowledge_uploads"("workId","extraction_status")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wku_work_sha256" ON "work_knowledge_uploads"("workId","sha256")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_wku_work_created" ON "work_knowledge_uploads"("workId","createdAt")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wku_work_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wku_work_sha256"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wku_work_status"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_uploads"`);
    }
}
