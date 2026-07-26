import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Append-only record of ONE Knowledge Base retrieval — the "what did we
 * inject, for which question, and did it return anything" log that the
 * memory eval loop (memory upgrades M10) measures against.
 *
 * Why its own table rather than more `work_knowledge_citations` rows:
 * a citation row is keyed by a document FK, so a retrieval that
 * returned **nothing** could not be represented at all — and the
 * zero-result queries are precisely the signal the gap-fed synthesis
 * prompt (M11) needs ("questions asked that retrieval could not
 * answer"). Citation rows stay exactly what they are (observed usage);
 * this table is observed *supply*. Joining the two gives the recall-hit
 * rate.
 *
 * Invariants:
 *  - **Append-only.** Never updated; pruned only by retention sweeps or
 *    the parent Work's cascade.
 *  - **Best-effort.** Writing a row can never fail a retrieval — the
 *    service wraps the insert and swallows errors.
 *  - **Bounded.** `queryText` is capped at write time; `documentIds` is
 *    a small ordered id list, never document bodies.
 */
@Entity({ name: 'kb_retrieval_logs' })
@Index(['workId', 'createdAt'])
@Index(['organizationId', 'createdAt'])
export class KbRetrievalLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * The Work whose Knowledge Base was queried. No `@ManyToOne` here on
     * purpose — the FK is declared in the migration with
     * `ON DELETE CASCADE`, and skipping the relation keeps this entity
     * out of the Work import cycle (same posture as the Tier C scope
     * columns elsewhere).
     */
    @Column({ type: 'uuid' })
    workId: string;

    /**
     * Denormalized org scope so the health endpoint can aggregate
     * without joining `works`. NULL when the retrieval happened outside
     * an organization (personal Work).
     */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * The query the retrieval ran, capped to
     * {@link KB_RETRIEVAL_LOG_QUERY_MAX} characters. NULL for a bundle
     * with no query at all (always-injected context only).
     */
    @Column({ type: 'varchar', length: 512, nullable: true, name: 'query_text' })
    queryText?: string | null;

    /** Number of documents the retrieval returned. `0` marks a gap. */
    @Column({ type: 'int', name: 'result_count', default: 0 })
    resultCount: number;

    /**
     * Ids of the returned documents, in injection order. Bounded by the
     * retrieval limit; stored as `simple-json` (text on every driver).
     */
    @Column({ type: 'simple-json', nullable: true, name: 'document_ids' })
    documentIds?: string[] | null;

    /**
     * Which surface asked — `pipeline`, `pr-review`, `agent-run`, … .
     * Free-form label, never used for authorization.
     */
    @Column({ type: 'varchar', length: 64, nullable: true, name: 'consumer_kind' })
    consumerKind?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}

/** Hard cap on the stored query text (matches the column length). */
export const KB_RETRIEVAL_LOG_QUERY_MAX = 512;
