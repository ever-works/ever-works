import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Knowledge library — one person's relationship with one Knowledge Base
 * document: when they last opened it, which revision they last read, and
 * whether they pinned it.
 *
 * ## Why this cannot live on the document row
 *
 * A document is shared by everyone in its Work / Organization, but "have I
 * read this?" and "is this one of MY pinned documents?" are irreducibly per
 * person. Putting either on `work_knowledge_documents` would make one
 * teammate's reading clear the badge for everybody. Nor can it be derived
 * from the activity log, which is an append-only audit trail rather than a
 * queryable per-person cursor.
 *
 * ## Shape
 *
 *  - One row per `(userId, documentId)`, written lazily: no row exists until
 *    a person opens or pins a document, so a large library does not allocate
 *    a row per member per document up front.
 *  - `lastReadRevision` compares against `WorkKnowledgeDocument.revision`.
 *    `0` means "opened before, but treat as unread" — what marking a
 *    document unread writes — so the badge reads UPDATED, never NEW.
 *  - `pinnedAt` non-null ⇒ pinned; it is also the ordering key of the pinned
 *    group.
 *  - Raw uuid columns with FKs declared by the migration, no `@ManyToOne`
 *    (EW-654 no-cycle rule, same as `memory-folder.entity.ts`).
 *  - Tier C scope columns (`tenantId` / `organizationId`) are stamped by
 *    `ScopeStampingSubscriber` on insert.
 */
@Entity({ name: 'knowledge_document_reader_states' })
@Index('uq_knowledge_reader_state_user_doc', ['userId', 'documentId'], { unique: true })
@Index('idx_knowledge_reader_state_user_pinned', ['userId', 'pinnedAt'])
@Index('idx_knowledge_reader_state_doc', ['documentId'])
export class KnowledgeDocumentReaderState {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The reader. Raw uuid — FK to `users` (CASCADE) by migration. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The document. Raw uuid — FK to `work_knowledge_documents` (CASCADE) by migration. */
    @Column({ type: 'uuid' })
    documentId: string;

    /** First time the document was recorded as read by this person. */
    @Column({ type: Date, nullable: true })
    lastOpenedAt?: Date | null;

    /**
     * Revision this person last read. `0` = treat as unread although the
     * document has been opened before (the "mark as unread" write).
     */
    @Column({ type: 'int', default: 0 })
    lastReadRevision: number;

    /** Non-null ⇒ pinned by this person; orders the pinned group. */
    @Column({ type: Date, nullable: true })
    pinnedAt?: Date | null;

    // Tier C scope denormalization — see the class comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
