import {
    Entity,
    Column,
    PrimaryColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { WorkKnowledgeDocument } from './work-knowledge-document.entity';

/**
 * A chunk of a KB document's body with its embedding vector.
 *
 * Produced by the hybrid chunker (heading-aware H2/H3 + fixed-size
 * fallback per spec §15.2). Consumed by semantic retrieval blended
 * with lexical FTS via Reciprocal Rank Fusion.
 *
 * **Composite primary key `(workId, id)` is deliberate**: it puts
 * `workId` first so that a future migration to
 * `PARTITION BY HASH (workId)` does not require a table rewrite.
 * Every retrieval query MUST include `WHERE workId = $1` — enforced
 * at the service layer.
 *
 * The `embedding` column is `pgvector`'s `vector` type. The dimension
 * (1536) matches the platform-managed default embedding model
 * (`text-embedding-3-small`); orgs may override via plugin settings.
 * If the dimension ever changes for a particular org, the chunks of
 * any document re-embedded under the new model are stored in a
 * separate column (or table) — out of scope for v1.
 */
@Entity({ name: 'work_knowledge_chunks' })
@Index(['workId', 'documentId'])
export class WorkKnowledgeChunk {
    /**
     * The id portion of the composite PK. Auto-generated UUID at
     * insert time (not `@PrimaryGeneratedColumn` because that conflicts
     * with composite PKs in TypeORM 0.3.x — service layer assigns the
     * UUID via `randomUUID()`).
     */
    @PrimaryColumn('uuid')
    id: string;

    /** Leftmost part of the composite PK — drives future partitioning. */
    @PrimaryColumn('uuid', { name: 'work_id' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'work_id' })
    work: ClassToObject<Work>;

    @Column({ name: 'document_id' })
    documentId: string;

    @ManyToOne(() => WorkKnowledgeDocument, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'document_id' })
    document: ClassToObject<WorkKnowledgeDocument>;

    /** 0-based ordinal of this chunk within the document. */
    @Column({ type: 'int', name: 'chunk_index' })
    chunkIndex: number;

    /** The chunk's text. */
    @Column({ type: 'text' })
    content: string;

    /**
     * Embedding vector. The `pgvector` column type is added via raw
     * SQL in the migration (TypeORM 0.3.x has no first-class
     * `vector(N)` mapping); this property is read/written as a
     * `number[]`. The ivfflat index on `(workId, embedding)` is also
     * declared in the migration.
     *
     * Declared as `simple-json` here so TypeORM ignores the column for
     * schema-sync (in tests / synchronize=true mode), with the real
     * column type set by the migration. Postgres returns the vector
     * as a string like `[0.1,0.2,...]`; the service layer parses on
     * read and stringifies on write. v1 is fine with this round-trip
     * cost; if it becomes a hot path we'll move to a dedicated
     * pgvector column transformer.
     */
    @Column({ type: 'simple-json', nullable: true })
    embedding?: number[] | null;

    @Column({ type: 'int', name: 'token_count' })
    tokenCount: number;

    /**
     * Free-form per-chunk metadata. Common keys:
     *  - `headingPath`: e.g. `["Brand voice", "Examples", "Email"]` —
     *    for citation rendering.
     *  - `charRange`: `{ start, end }` byte offsets into the parent
     *    document body.
     */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;
}
