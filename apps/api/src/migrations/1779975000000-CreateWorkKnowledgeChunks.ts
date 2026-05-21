import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `work_knowledge_chunks` — embedding chunks for semantic
 * retrieval. See spec §6 + §15.2.
 *
 * The composite primary key `(work_id, id)` is deliberate — it puts
 * `work_id` first so a future migration to
 * `PARTITION BY HASH (work_id)` does not require a table rewrite.
 *
 * On Postgres the `embedding` column is `vector(1536)` (pgvector) with
 * an `ivfflat` index on `(work_id, embedding)` for tenant-filtered
 * ANN. On SQLite (tests + local CLI) the column degrades to `TEXT`
 * holding the JSON-encoded vector; semantic retrieval is gracefully
 * disabled in that environment.
 *
 * **Every retrieval query MUST include `WHERE work_id = $1`** —
 * enforced at the service layer. Without that filter the ivfflat
 * search degrades dramatically and recall suffers (the candidate set
 * may not contain enough chunks for the target Work after filtering).
 *
 * EW-639 / EW-640.
 */
export class CreateWorkKnowledgeChunks1779975000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const embeddingType = isPostgres ? 'vector(1536)' : 'TEXT';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_chunks" (
                "id" uuid NOT NULL,
                "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
                "document_id" uuid NOT NULL REFERENCES "work_knowledge_documents"("id") ON DELETE CASCADE,
                "chunk_index" int NOT NULL,
                "content" text NOT NULL,
                "embedding" ${embeddingType} NULL,
                "token_count" int NOT NULL,
                "metadata" text NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY ("work_id","id")
            )
        `);

        await queryRunner.query(
            `CREATE INDEX "idx_wknc_work_doc" ON "work_knowledge_chunks"("work_id","document_id")`,
        );

        if (isPostgres) {
            // ivfflat ANN index on the embedding column. `lists = 100`
            // is a sane default for the expected per-tenant chunk
            // count; tune via `SET ivfflat.probes` at query time if
            // needed. We're not creating a composite ivfflat index on
            // (work_id, embedding) — pgvector ivfflat doesn't support
            // leading scalar columns; the work_id filter is applied
            // after the ANN candidate fetch (still cheap thanks to the
            // composite PK).
            await queryRunner.query(`
                CREATE INDEX "idx_wknc_embedding"
                ON "work_knowledge_chunks"
                USING ivfflat ("embedding" vector_cosine_ops)
                WITH (lists = 100)
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wknc_embedding"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wknc_work_doc"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_chunks"`);
    }
}
