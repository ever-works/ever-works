import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AW-07 — `vector_namespace_chunks`: pgvector chunks for vector namespaces
 * that are not a Work.
 *
 * Timestamp: AW-07 block, directly after `1791110070000-CreateMemoryFacts`
 * and above every migration on `develop`. `…0080000` is deliberately NOT a
 * multiple of 100000, so it cannot collide with any epic's reserved slot.
 *
 * Entity: `packages/agent/src/entities/vector-namespace-chunk.entity.ts`
 *
 * ## Why a second chunk table
 *
 * The bundled pgvector vector store writes Knowledge Base chunks to
 * `work_knowledge_chunks`, whose `work_id` references `works(id)` and
 * `document_id` references `work_knowledge_documents(id)`. Memory facts are
 * embedded through the same vector-store capability into a deterministic
 * per-WORKSPACE namespace UUID, which is no Work — so every fact write was
 * refused by those foreign keys and fact search silently stayed in
 * exact-words mode on pgvector-only installs.
 *
 * Making `work_id` nullable was the alternative, but it is half of that
 * table's composite primary key (`(work_id, id)`, laid out for a future
 * `PARTITION BY HASH (work_id)`) and the key every Knowledge Base query and
 * the re-embed sweep filter on. A separate namespace-keyed table leaves
 * `work_knowledge_chunks`, its indexes and its sweep byte-for-byte untouched.
 *
 * ## Shape
 *
 * Mirrors `work_knowledge_chunks` with `namespace_id` in place of `work_id`:
 * composite PK `(namespace_id, id)` (the namespace is the leftmost key every
 * read filters on, so one namespace can never read another's vectors), no
 * foreign keys (a namespace is not a row, and the owner deletes its own
 * vectors through the port), plus the Tier C `tenantId` / `organizationId`
 * of the owning workspace.
 *
 * On Postgres `embedding` is `vector(1536)` with an `ivfflat` cosine index,
 * exactly like the Knowledge Base table; on SQLite (tests, local CLI, the
 * OSS e2e stack) it degrades to `TEXT` and semantic retrieval is disabled.
 *
 * Forward-only + idempotent (`hasTable` guard).
 */
export class CreateVectorNamespaceChunks1791110080000 implements MigrationInterface {
    name = 'CreateVectorNamespaceChunks1791110080000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('vector_namespace_chunks')) {
            return;
        }

        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME';
        const embeddingType = isPostgres ? 'vector(1536)' : 'TEXT';

        await queryRunner.query(`
            CREATE TABLE "vector_namespace_chunks" (
                "id" uuid NOT NULL,
                "namespace_id" uuid NOT NULL,
                "document_id" uuid NOT NULL,
                "chunk_index" int NOT NULL,
                "content" text NOT NULL,
                "embedding" ${embeddingType} NULL,
                "token_count" int NOT NULL,
                "metadata" text NULL,
                "tenantId" uuid NULL,
                "organizationId" uuid NULL,
                "createdAt" ${tsType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY ("namespace_id","id")
            )
        `);

        await queryRunner.query(
            `CREATE INDEX "idx_vnc_namespace_doc" ON "vector_namespace_chunks"("namespace_id","document_id")`,
        );

        if (isPostgres) {
            // Same ANN strategy as `idx_wknc_embedding`: ivfflat over cosine
            // distance, the namespace filter applied to the candidates (the
            // composite PK keeps that cheap).
            await queryRunner.query(`
                CREATE INDEX "idx_vnc_embedding"
                ON "vector_namespace_chunks"
                USING ivfflat ("embedding" vector_cosine_ops)
                WITH (lists = 100)
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_vnc_embedding"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_vnc_namespace_doc"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "vector_namespace_chunks"`);
    }
}
