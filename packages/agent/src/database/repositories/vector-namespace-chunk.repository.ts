import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VectorNamespaceChunk } from '../../entities/vector-namespace-chunk.entity';

/** One chunk handed to {@link VectorNamespaceChunkRepository.replaceForDocument}. */
export interface NamespaceChunkUpsertInput {
    id: string;
    documentId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
    embedding?: number[] | null;
    metadata?: Record<string, unknown> | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

/** One nearest-neighbour row. `workId` carries the namespace id (the port's leftmost key). */
export interface NamespaceChunkNearestRow {
    id: string;
    workId: string;
    documentId: string;
    chunkIndex: number;
    content: string;
    distance: number;
}

/**
 * AW-07 — repository for `vector_namespace_chunks`: the pgvector vector
 * store's chunks for namespaces that are not a Work.
 *
 * Same method set, same semantics and same argument order as the Work-scoped
 * `WorkKnowledgeChunkRepository`, because both implement the one
 * `PgVectorChunkRepositoryPort` the pgvector plugin delegates to; the
 * port's "work id" argument is the namespace id here.
 *
 * ## Isolation
 *
 * EVERY statement is keyed on `namespace_id`: replace and delete filter on
 * it, and the k-NN query applies `WHERE namespace_id = $2` before ordering by
 * distance. A query in one workspace's namespace can never return another
 * namespace's vectors.
 */
@Injectable()
export class VectorNamespaceChunkRepository {
    constructor(
        @InjectRepository(VectorNamespaceChunk)
        private readonly repository: Repository<VectorNamespaceChunk>,
    ) {}

    /**
     * Atomically replace the chunks of one document inside one namespace:
     * DELETE the prior rows for `(namespaceId, documentId)`, then INSERT the
     * new set, in one transaction. An empty `chunks` array deletes only.
     * The namespace on every row comes from the argument, never the input.
     */
    async replaceForDocument(
        namespaceId: string,
        documentId: string,
        chunks: readonly NamespaceChunkUpsertInput[],
    ): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            await manager.delete(VectorNamespaceChunk, { namespaceId, documentId });
            if (chunks.length === 0) return;
            const rows = chunks.map((c) =>
                manager.create(VectorNamespaceChunk, {
                    id: c.id,
                    namespaceId,
                    documentId: c.documentId,
                    chunkIndex: c.chunkIndex,
                    content: c.content,
                    tokenCount: c.tokenCount,
                    embedding: c.embedding ?? null,
                    metadata: c.metadata ?? null,
                    tenantId: c.tenantId ?? null,
                    organizationId: c.organizationId ?? null,
                }),
            );
            await manager.insert(VectorNamespaceChunk, rows);
        });
    }

    /**
     * pgvector cosine k-NN inside ONE namespace. Returns `[]` on a
     * non-Postgres driver (SQLite has no pgvector — the documented "no
     * semantic signal" fallback) and for an empty embedding or `limit <= 0`.
     */
    async findNearestByEmbedding(
        namespaceId: string,
        embedding: readonly number[],
        limit: number,
    ): Promise<NamespaceChunkNearestRow[]> {
        if (embedding.length === 0 || limit <= 0) return [];
        if (this.repository.manager.connection.options.type !== 'postgres') {
            return [];
        }

        const vectorLiteral = JSON.stringify(embedding);
        const rows = (await this.repository.manager.query(
            `SELECT id,
                    namespace_id AS "workId",
                    document_id AS "documentId",
                    chunk_index AS "chunkIndex",
                    content,
                    embedding <=> $1::vector AS distance
             FROM vector_namespace_chunks
             WHERE namespace_id = $2
               AND embedding IS NOT NULL
             ORDER BY embedding <=> $1::vector ASC
             LIMIT $3`,
            [vectorLiteral, namespaceId, limit],
        )) as Array<Omit<NamespaceChunkNearestRow, 'distance'> & { distance: number | string }>;

        return rows.map((r) => ({
            id: r.id,
            workId: r.workId,
            documentId: r.documentId,
            chunkIndex: r.chunkIndex,
            content: r.content,
            distance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
        }));
    }

    /** Delete every chunk of one document inside one namespace. */
    async deleteByDocument(namespaceId: string, documentId: string): Promise<void> {
        await this.repository.delete({ namespaceId, documentId });
    }

    /** Delete every chunk in one namespace (the port's `deleteByWork`). */
    async deleteByWork(namespaceId: string): Promise<void> {
        await this.repository.delete({ namespaceId });
    }

    /** Chunks of one document inside one namespace, in order. Tests and diagnostics. */
    async findByNamespaceAndDocument(
        namespaceId: string,
        documentId: string,
    ): Promise<VectorNamespaceChunk[]> {
        return this.repository.find({
            where: { namespaceId, documentId },
            order: { chunkIndex: 'ASC' },
        });
    }
}
