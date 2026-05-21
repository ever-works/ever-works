import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Base prerequisite: enable the `pgvector` extension on
 * Postgres so the `work_knowledge_chunks` table (next migration) can
 * declare its `embedding vector(1536)` column + ivfflat index.
 *
 * Idempotent (`IF NOT EXISTS`); safe to re-run.
 *
 * Skipped on SQLite (used in tests + local CLI) where `CREATE
 * EXTENSION` is not supported. The chunks table on SQLite stores the
 * embedding as JSON via the entity's `simple-json` column type —
 * semantic retrieval is Postgres-only.
 *
 * EW-639 / EW-640.
 */
export class EnablePgvectorExtension1779970000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type === 'postgres') {
            await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector;');
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Intentional no-op. Dropping `vector` would invalidate every
        // index that depends on it (across this codebase + any other
        // schema on the same database). Treat the extension as a
        // forever-on prerequisite; manual `DROP EXTENSION vector` is
        // an explicit operator decision.
    }
}
