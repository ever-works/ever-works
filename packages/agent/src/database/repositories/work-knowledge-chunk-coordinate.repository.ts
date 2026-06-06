import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkKnowledgeChunkCoordinate } from '../../entities/work-knowledge-chunk-coordinate.entity';

/**
 * EW-642 — input shape for `upsert` on the coordinate table. Mirrors
 * the entity columns minus the auto-populated `last_embedded_at`
 * (defaulted by the repo helper to `now()` when omitted).
 */
export interface ChunkCoordinateUpsertInput {
    workId: string;
    documentId: string;
    vectorStoreId: string;
    chunkCount: number;
    embeddingModel: string;
    embeddingDims: number;
    /** Optional — defaults to `now()` when omitted. */
    lastEmbeddedAt?: Date;
}

/**
 * EW-642 — repository for `WorkKnowledgeChunkCoordinate`.
 *
 * The coordinate table is the platform's source of truth for "what was
 * embedded where, when, with which model" (RFC §7 data model split).
 * Every retrieval path here is keyed on `(workId, documentId)` or the
 * `(vectorStoreId, embeddingModel)` index — the same shapes the
 * re-embed sweep (Trigger.dev `kb-reembed-work`) needs.
 *
 * Why a per-pair upsert and not row-level CRUD? A document re-ingest
 * always produces a different `chunkCount` and `lastEmbeddedAt`; the
 * embedding model + dims may also flip on the same pair (re-embed
 * sweep). The composite PK `(workId, documentId)` lets us model the
 * write as "upsert the whole coordinate row" — atomic, idempotent, no
 * row-level merge logic.
 */
@Injectable()
export class WorkKnowledgeChunkCoordinateRepository {
    constructor(
        @InjectRepository(WorkKnowledgeChunkCoordinate)
        private readonly repository: Repository<WorkKnowledgeChunkCoordinate>,
    ) {}

    /**
     * Lookup the coordinate row for a `(workId, documentId)` pair.
     * Returns `null` when the pair has never been embedded.
     */
    async findByWorkAndDocument(
        workId: string,
        documentId: string,
    ): Promise<WorkKnowledgeChunkCoordinate | null> {
        return this.repository.findOne({ where: { workId, documentId } });
    }

    /**
     * Upsert by composite PK. On Postgres uses TypeORM's `upsert`
     * helper (single round-trip via `INSERT … ON CONFLICT DO UPDATE`);
     * on dialects that don't expose `upsert` (SQLite in tests) we fall
     * back to the read-then-save pattern inside a transaction so the
     * caller still gets idempotent semantics.
     */
    async upsert(input: ChunkCoordinateUpsertInput): Promise<void> {
        const now = input.lastEmbeddedAt ?? new Date();
        const driverType = this.repository.manager.connection.options.type;

        const row: WorkKnowledgeChunkCoordinate = {
            workId: input.workId,
            documentId: input.documentId,
            vectorStoreId: input.vectorStoreId,
            chunkCount: input.chunkCount,
            embeddingModel: input.embeddingModel,
            embeddingDims: input.embeddingDims,
            lastEmbeddedAt: now,
        };

        if (driverType === 'postgres') {
            await this.repository.upsert(row, {
                conflictPaths: ['workId', 'documentId'],
                skipUpdateIfNoValuesChanged: false,
            });
            return;
        }

        await this.repository.manager.transaction(async (manager) => {
            const existing = await manager.findOne(WorkKnowledgeChunkCoordinate, {
                where: { workId: input.workId, documentId: input.documentId },
            });
            if (existing) {
                await manager.update(
                    WorkKnowledgeChunkCoordinate,
                    { workId: input.workId, documentId: input.documentId },
                    {
                        vectorStoreId: row.vectorStoreId,
                        chunkCount: row.chunkCount,
                        embeddingModel: row.embeddingModel,
                        embeddingDims: row.embeddingDims,
                        lastEmbeddedAt: row.lastEmbeddedAt,
                    },
                );
            } else {
                await manager.insert(WorkKnowledgeChunkCoordinate, row);
            }
        });
    }

    /**
     * List every coordinate row for a Work. Used by the activity-log
     * and by `kb-reembed-work` to enumerate documents that need a
     * re-embed.
     */
    async listByWork(workId: string): Promise<WorkKnowledgeChunkCoordinate[]> {
        return this.repository.find({
            where: { workId },
            order: { documentId: 'ASC' },
        });
    }

    /**
     * Select stale coordinate rows for the re-embed sweep — every
     * `(workId, documentId)` that points at `vectorStoreId` and was
     * embedded with `embeddingModel`. The index on
     * `(vector_store_id, embedding_model)` keeps this O(matches).
     */
    async listByEmbeddingModel(
        vectorStoreId: string,
        embeddingModel: string,
    ): Promise<WorkKnowledgeChunkCoordinate[]> {
        return this.repository.find({
            where: { vectorStoreId, embeddingModel },
            order: { workId: 'ASC', documentId: 'ASC' },
        });
    }

    /**
     * Delete the coordinate row for a `(workId, documentId)` pair.
     * Called by `deleteByDocument` on the knowledge base service after
     * the underlying chunks have been wiped.
     */
    async deleteByDocument(workId: string, documentId: string): Promise<void> {
        await this.repository.delete({ workId, documentId });
    }

    /** Cascade-delete every coordinate row owned by a Work. */
    async deleteByWork(workId: string): Promise<void> {
        await this.repository.delete({ workId });
    }
}
