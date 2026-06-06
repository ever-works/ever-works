import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * EW-642 — invalidation coordinates for a `(workId, documentId)` chunk
 * set.
 *
 * Per RFC §7 (data model split), the platform owns ONLY the
 * coordinates — "what was embedded where, when, with which model" —
 * while the actual chunk rows + vectors live inside the vector-store
 * plugin's own store (`work_knowledge_chunks` for the default pgvector
 * plugin, a Qdrant collection for the Qdrant plugin, etc.).
 *
 * The coordinate table lets the platform:
 *
 *  - decide whether a re-embed sweep is needed when the embedding
 *    model or vector store changes — without scanning the chunk
 *    table or the plugin's own backend;
 *  - power the activity-log / Trigger.dev `kb-reembed-work` task by
 *    selecting stale rows via `(vector_store_id, embedding_model)`;
 *  - keep the chunk-table data path agnostic of which plugin is
 *    currently wired in.
 *
 * Composite PK `(workId, documentId)` mirrors the natural identity of
 * "what was embedded". The index on `(vectorStoreId, embeddingModel)`
 * supports the sweep filter.
 */
@Entity({ name: 'work_knowledge_chunk_coordinates' })
@Index(['vectorStoreId', 'embeddingModel'])
export class WorkKnowledgeChunkCoordinate {
    /** Owning Work — leftmost half of the composite PK. */
    @PrimaryColumn('uuid', { name: 'work_id' })
    workId: string;

    /** Source document — second half of the composite PK. */
    @PrimaryColumn('uuid', { name: 'document_id' })
    documentId: string;

    /**
     * Vector-store plugin id that holds the actual chunks for this
     * `(workId, documentId)` pair. Defaults to `'pgvector'` for the
     * platform-bundled store; rows pointing at other plugins (Qdrant,
     * Pinecone, …) get the plugin's `id` here.
     */
    @Column({ type: 'text', name: 'vector_store_id' })
    vectorStoreId: string;

    /** Number of chunk rows last written for this pair. */
    @Column({ type: 'int', name: 'chunk_count', default: 0 })
    chunkCount: number;

    /** Wall-clock at which the chunks were last (re)embedded + written. */
    @Column({ type: 'timestamptz', name: 'last_embedded_at' })
    lastEmbeddedAt: Date;

    /**
     * Embedding model used. Required for the re-embed sweep — when the
     * platform-managed default flips (e.g. `text-embedding-3-small` →
     * `text-embedding-3-large`), the sweep finds every coordinate row
     * with the old model and queues a `kb-reembed-work` run.
     */
    @Column({ type: 'text', name: 'embedding_model' })
    embeddingModel: string;

    /**
     * Vector dimension used. Pinned alongside the model so a future
     * model change that keeps the same name but flips dims (rare but
     * possible — providers do bump dim defaults) is still detected.
     */
    @Column({ type: 'int', name: 'embedding_dims' })
    embeddingDims: number;
}
