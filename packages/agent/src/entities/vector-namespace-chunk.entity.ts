import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * AW-07 — a vector chunk in a namespace that is NOT a Work.
 *
 * The bundled pgvector vector store keeps Knowledge Base chunks in
 * `work_knowledge_chunks`, whose `work_id` and `document_id` are foreign
 * keys to `works` and `work_knowledge_documents`. Anything else the
 * vector-store capability serves — today a workspace's memory facts, keyed by
 * a deterministic per-workspace namespace UUID — cannot be written there, so
 * the plugin's host repository routes those namespaces to this table instead.
 * `work_knowledge_chunks` and its re-embed sweep are untouched.
 *
 * This is storage behind the EXISTING vector-store port
 * (`PgVectorChunkRepositoryPort`), not a second vector abstraction: callers
 * still go through `VectorStoreFacadeService`, and a different vector-store
 * plugin (e.g. Qdrant) never touches this table.
 *
 * **Composite primary key `(namespaceId, id)`** mirrors
 * `work_knowledge_chunks (work_id, id)`: the namespace is the leftmost key,
 * and every read is `WHERE namespace_id = $1`, so one namespace can never
 * read another's vectors.
 *
 * No foreign keys on `namespace_id` / `document_id`: a namespace is not a
 * row anywhere, and the document is whatever the namespace's owner says it is
 * (a fact id for memory facts). Owners delete their own vectors through the
 * port (`deleteByDocument` / `deleteByWork`), which the memory-fact purge
 * sweep already does.
 *
 * The `embedding` column is `vector(1536)` on Postgres (set by migration
 * `1791110080000-CreateVectorNamespaceChunks`), `TEXT` on SQLite; declared
 * `simple-json` here for the same reason `WorkKnowledgeChunk` does.
 */
@Entity({ name: 'vector_namespace_chunks' })
@Index('idx_vnc_namespace_doc', ['namespaceId', 'documentId'])
export class VectorNamespaceChunk {
    /** The id half of the composite PK. Caller-assigned. */
    @PrimaryColumn('uuid')
    id: string;

    /** Leftmost part of the composite PK — the namespace every read filters by. */
    @PrimaryColumn('uuid', { name: 'namespace_id' })
    namespaceId: string;

    /** The namespace owner's document id (a fact id for memory facts). */
    @Column({ type: 'uuid', name: 'document_id' })
    documentId: string;

    /** 0-based ordinal of this chunk within the document. */
    @Column({ type: 'int', name: 'chunk_index' })
    chunkIndex: number;

    /** The chunk's text. */
    @Column({ type: 'text' })
    content: string;

    /** Embedding vector — `vector(1536)` on Postgres; see the class JSDoc. */
    @Column({ type: 'simple-json', nullable: true })
    embedding?: number[] | null;

    @Column({ type: 'int', name: 'token_count' })
    tokenCount: number;

    /** Free-form metadata the owner attaches (e.g. `{ kind: 'memory-fact', scope }`). */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    /** Owning workspace (Tier C) — recorded for offboarding and audits. */
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
