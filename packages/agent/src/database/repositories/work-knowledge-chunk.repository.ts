import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkKnowledgeChunk } from '../../entities/work-knowledge-chunk.entity';

/**
 * Input shape for `replaceForDocument`. Caller (the embedding
 * Trigger.dev task in row 29b) is responsible for generating UUIDs +
 * estimating token counts; this repo stays generic and doesn't bake in
 * tokenizer choices that might drift between embedding models.
 */
export interface ChunkUpsertInput {
    /** UUID — the `id` half of the composite PK. Caller generates via `randomUUID()`. */
    id: string;
    /** Document the chunk belongs to. (workId is passed separately.) */
    documentId: string;
    /** 0-based ordinal within the document. */
    chunkIndex: number;
    /** The chunk's text. */
    content: string;
    /** Token count for budget accounting. */
    tokenCount: number;
    /** Embedding vector, when known. Row 29b populates this before insert. */
    embedding?: number[] | null;
    /** Free-form per-chunk metadata (e.g. `headingPath`, `charRange`). */
    metadata?: Record<string, unknown> | null;
}

/**
 * Repository for `WorkKnowledgeChunk` rows.
 *
 * EW-641 Phase 2/a row 29a. The chunk table is partition-ready
 * (composite PK `(workId, id)`); EVERY query path goes through a
 * `workId` filter so a future `PARTITION BY HASH (workId)` migration
 * is a no-op for application code.
 *
 * **Why `replaceForDocument` and not piecewise upsert?** A doc save
 * typically yields a different *number* of chunks than the previous
 * version (a paragraph added or deleted shifts every subsequent
 * `chunkIndex`). Reconciling row-by-row would need either index-level
 * upsert (complicated, error-prone) or a quiescence window
 * (race-prone). Wiping the doc's chunks then inserting the new set is
 * idempotent, fast at v1 chunk counts (low hundreds at most), and the
 * txn boundary guarantees retrieval never sees a half-empty doc.
 *
 * Embedding vectors are stored via the entity's `simple-json` column
 * declaration; the migration sets the real `vector(1536)` type. That
 * round-trip cost is acceptable at v1; we'll revisit if it shows up as
 * a hot path in retrieval benchmarks.
 */
@Injectable()
export class WorkKnowledgeChunkRepository {
    constructor(
        @InjectRepository(WorkKnowledgeChunk)
        private readonly repository: Repository<WorkKnowledgeChunk>,
    ) {}

    /**
     * Atomically replace the chunk rows for a single document.
     *
     * Behaviour:
     *  - Empty `chunks` array → DELETE only, INSERT is skipped. Use this
     *    when re-saving an empty / whitespace-only doc body or when row
     *    29c wants to clear chunks before unwiring.
     *  - Non-empty → DELETE all prior rows for `(workId, documentId)`
     *    then INSERT the new set, all inside one transaction so a
     *    concurrent retrieval either sees the old chunk set in full or
     *    the new one in full.
     *
     * Caller must ensure every input belongs to the same `documentId`
     * (we don't filter by it — that would mask bugs). The workId on
     * each row is set from the function arg, not the input — keeps the
     * partition invariant local.
     */
    async replaceForDocument(
        workId: string,
        documentId: string,
        chunks: readonly ChunkUpsertInput[],
    ): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            await manager.delete(WorkKnowledgeChunk, { workId, documentId });
            if (chunks.length === 0) return;
            const rows = chunks.map((c) => {
                const row = manager.create(WorkKnowledgeChunk, {
                    id: c.id,
                    workId,
                    documentId: c.documentId,
                    chunkIndex: c.chunkIndex,
                    content: c.content,
                    tokenCount: c.tokenCount,
                    embedding: c.embedding ?? null,
                    metadata: c.metadata ?? null,
                });
                return row;
            });
            await manager.insert(WorkKnowledgeChunk, rows);
        });
    }

    /**
     * Read every chunk for a document, ordered by `chunkIndex` ASC.
     * Used by row 30 (RRF retrieval) and by tests that need to verify
     * a write landed as expected.
     */
    async findByWorkAndDocument(workId: string, documentId: string): Promise<WorkKnowledgeChunk[]> {
        return this.repository.find({
            where: { workId, documentId },
            order: { chunkIndex: 'ASC' },
        });
    }

    /**
     * Count chunks for an entire Work. Useful for budget-ledger checks
     * (row 41) and as a quick sanity gauge in tests.
     */
    async countByWork(workId: string): Promise<number> {
        return this.repository.count({ where: { workId } });
    }

    /**
     * EW-641 Phase 2/a row 30a — k-nearest-neighbor over the
     * `embedding` column using pgvector's cosine-distance operator
     * (`<=>`), matching the `vector_cosine_ops` ivfflat index from
     * migration `1779975000000-CreateWorkKnowledgeChunks`. Always
     * filters `WHERE work_id = $1` so the partition-ready PK + the
     * row-30c RRF retrieval never cross tenant boundaries.
     *
     * Returns `[]` when:
     *  - the underlying driver isn't Postgres (e.g. SQLite in unit
     *    tests or e2e). pgvector is a Postgres-only extension; callers
     *    (`KnowledgeBaseService.semanticSearch` + row 30c's RRF blend)
     *    treat empty semantic results as "no semantic signal" and
     *    fall through to lexical-only ordering.
     *  - the input embedding is empty or `limit <= 0` (defensive
     *    short-circuit so a malformed call can't fire a query).
     *
     * Implementation note: pgvector expects the `vector` literal as a
     * string like `'[0.1,0.2,...]'`. `JSON.stringify` on a plain
     * `number[]` produces exactly that bracketed form. The `::vector`
     * cast in the SQL coerces to the column type so the ivfflat index
     * can be used.
     *
     * Returned shape mirrors the chunk row minus the embedding (no
     * need to ship the vector back to the service layer) plus the raw
     * `distance` float for downstream ranking. Order: distance ASC
     * (nearest first).
     */
    async findNearestByEmbedding(
        workId: string,
        embedding: readonly number[],
        limit: number,
    ): Promise<
        Array<{
            id: string;
            workId: string;
            documentId: string;
            chunkIndex: number;
            content: string;
            distance: number;
        }>
    > {
        if (embedding.length === 0 || limit <= 0) return [];

        const driverType = this.repository.manager.connection.options.type;
        if (driverType !== 'postgres') {
            // SQLite in tests / OSS e2e has no pgvector. Caller will
            // RRF-blend with lexical-only — returning [] here is the
            // documented "no semantic signal" fallback.
            return [];
        }

        // pgvector vector literal: `'[a,b,c,...]'`. `JSON.stringify`
        // on a plain `number[]` produces exactly that bracket form.
        const vectorLiteral = JSON.stringify(embedding);

        const rows = (await this.repository.manager.query(
            `SELECT id,
                    work_id AS "workId",
                    document_id AS "documentId",
                    chunk_index AS "chunkIndex",
                    content,
                    embedding <=> $1::vector AS distance
             FROM work_knowledge_chunks
             WHERE work_id = $2
               AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector ASC
             LIMIT $3`,
            [vectorLiteral, workId, limit],
        )) as Array<{
            id: string;
            workId: string;
            documentId: string;
            chunkIndex: number;
            content: string;
            distance: number | string;
        }>;

        // Some node-postgres versions surface numeric columns as
        // strings (`parseFloat` is only applied to a subset of OIDs by
        // default). Coerce here so the row-30b RRF blend can compute
        // on a number directly without spreading the cast through
        // every consumer.
        return rows.map((r) => ({
            id: r.id,
            workId: r.workId,
            documentId: r.documentId,
            chunkIndex: r.chunkIndex,
            content: r.content,
            distance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
        }));
    }
}
