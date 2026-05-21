import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { KbCitationConsumerType } from './kb-types';
import { WorkKnowledgeDocument } from './work-knowledge-document.entity';

/**
 * Audit row recording that a KB document was used as context by some
 * consumer (agent run, generation pipeline, conversation message,
 * community PR, comparison). Powers the "what context was used"
 * audit trail and the reverse-lookup "what referenced this doc".
 *
 * Append-only — never updated, never deleted except via the parent
 * Work's cascade.
 *
 * The `consumerId` field is polymorphic by `consumerType` — there is
 * no FK on it because TypeORM doesn't support polymorphic FKs cleanly.
 * Integrity is enforced at the service layer.
 */
@Entity({ name: 'work_knowledge_citations' })
@Index(['documentId', 'createdAt'])
@Index(['consumerType', 'consumerId'])
@Index(['workId', 'createdAt'])
export class WorkKnowledgeCitation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ name: 'document_id' })
    documentId: string;

    @ManyToOne(() => WorkKnowledgeDocument, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'document_id' })
    document: ClassToObject<WorkKnowledgeDocument>;

    /** Discriminator for `consumerId`. See `KbCitationConsumerType`. */
    @Column({ type: 'varchar', name: 'consumer_type' })
    consumerType: KbCitationConsumerType;

    /**
     * UUID of the consumer row keyed by `consumerType`. Polymorphic;
     * resolved at the service layer to the right table (agent run,
     * generation history, conversation message, community PR,
     * comparison).
     */
    @Column({ name: 'consumer_id' })
    consumerId: string;

    /**
     * Byte / line / chunk offset range, if a partial section was cited
     * rather than the whole document.
     */
    @Column({ type: 'simple-json', nullable: true, name: 'chunk_range' })
    chunkRange?: { start: number; end: number } | null;

    /** Retrieval ranking score (semantic / lexical / blended). */
    @Column({ type: 'float', nullable: true, name: 'relevance_score' })
    relevanceScore?: number | null;

    @CreateDateColumn()
    createdAt: Date;
}
