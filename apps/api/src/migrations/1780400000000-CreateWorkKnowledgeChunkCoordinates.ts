import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EW-642 — `work_knowledge_chunk_coordinates`.
 *
 * Per RFC §7 (data model split), the platform owns only the invalidation
 * **coordinates** of a chunk set; the actual chunk rows + vectors live
 * inside the vector-store plugin's own store (`work_knowledge_chunks`
 * for the default pgvector plugin, a Qdrant collection for the Qdrant
 * plugin, …).
 *
 * The coordinates table records "what was embedded where, when, with
 * which model" so the platform can:
 *
 *   - decide whether a re-embed sweep is needed when the embedding
 *     model or vector store changes (`(vector_store_id, embedding_model)`
 *     index supports the sweep filter);
 *   - power the activity-log / Trigger.dev `kb-reembed-work` task
 *     without scanning the chunk table;
 *   - keep the chunk-table data path agnostic of which plugin is wired
 *     in (the chunks table itself remains owned by the pgvector plugin).
 *
 * Backfill: every existing `(work_id, document_id)` pair in
 * `work_knowledge_chunks` is seeded as a coordinate row pointing at
 * `'pgvector'` + the default model + 1536 dimensions (matches migration
 * `1779975000000-CreateWorkKnowledgeChunks`). New ingests overwrite via
 * the application-level upsert path.
 *
 * Down: drops the table outright. The data is recoverable from a
 * re-embed sweep, so down is non-destructive in practice.
 */
export class CreateWorkKnowledgeChunkCoordinates1780400000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';

        await queryRunner.query(`
            CREATE TABLE "work_knowledge_chunk_coordinates" (
                "work_id" uuid NOT NULL,
                "document_id" uuid NOT NULL,
                "vector_store_id" text NOT NULL,
                "chunk_count" int NOT NULL DEFAULT 0,
                "last_embedded_at" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "embedding_model" text NOT NULL,
                "embedding_dims" int NOT NULL,
                PRIMARY KEY ("work_id","document_id")
            )
        `);

        // Sweep-filter index — the reembed task looks up coordinate rows
        // by `(vector_store_id, embedding_model)` to find stale entries
        // when an operator switches the platform-managed embedding model.
        await queryRunner.query(
            `CREATE INDEX "idx_wkcc_vs_model" ON "work_knowledge_chunk_coordinates"("vector_store_id","embedding_model")`,
        );

        // Backfill from the existing chunk table. The chunks table is
        // owned by the pgvector plugin today, so every backfilled row
        // points at `'pgvector'` + the default model + 1536 dims (the
        // values used by `CreateWorkKnowledgeChunks1779975000000`). New
        // ingests overwrite via the app-level upsert path.
        if (isPostgres) {
            await queryRunner.query(`
                INSERT INTO "work_knowledge_chunk_coordinates" (
                    "work_id",
                    "document_id",
                    "vector_store_id",
                    "chunk_count",
                    "last_embedded_at",
                    "embedding_model",
                    "embedding_dims"
                )
                SELECT
                    "work_id",
                    "document_id",
                    'pgvector' AS "vector_store_id",
                    COUNT(*)::int AS "chunk_count",
                    MAX("createdAt") AS "last_embedded_at",
                    'text-embedding-3-small' AS "embedding_model",
                    1536 AS "embedding_dims"
                FROM "work_knowledge_chunks"
                GROUP BY "work_id","document_id"
            `);
        } else {
            // SQLite path (tests + OSS e2e). `::int` cast is not
            // supported and `MAX("createdAt")` returns a text value the
            // TIMESTAMPTZ→DATETIME column accepts as-is.
            await queryRunner.query(`
                INSERT INTO "work_knowledge_chunk_coordinates" (
                    "work_id",
                    "document_id",
                    "vector_store_id",
                    "chunk_count",
                    "last_embedded_at",
                    "embedding_model",
                    "embedding_dims"
                )
                SELECT
                    "work_id",
                    "document_id",
                    'pgvector',
                    COUNT(*),
                    MAX("createdAt"),
                    'text-embedding-3-small',
                    1536
                FROM "work_knowledge_chunks"
                GROUP BY "work_id","document_id"
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_wkcc_vs_model"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "work_knowledge_chunk_coordinates"`);
    }
}
