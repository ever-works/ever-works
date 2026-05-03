import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Work } from './work.entity';
import type { ClassToObject } from './types';

/**
 * Stores per-work custom prompts that are appended to the standard
 * hardcoded prompts during the work generation workflow.
 *
 * Each field is nullable - null/empty values mean the standard prompt is used as-is.
 * Non-empty values are appended as "Additional User Instructions" to the base prompt.
 */
@Entity({ name: 'work_advanced_prompts' })
export class WorkAdvancedPrompts {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    workId: string;

    @OneToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    /**
     * Additional instructions for relevance assessment.
     * Affects which web pages are considered relevant to the work topic.
     */
    @Column({ type: 'text', nullable: true })
    relevanceAssessment?: string | null;

    /**
     * Additional instructions for initial item generation.
     * Affects the AI-generated items when starting fresh.
     */
    @Column({ type: 'text', nullable: true })
    itemGeneration?: string | null;

    /**
     * Additional instructions for item extraction from web pages.
     * Affects what items are identified and their metadata.
     */
    @Column({ type: 'text', nullable: true })
    itemExtraction?: string | null;

    /**
     * Additional instructions for search query generation.
     * Affects what types of sources are discovered.
     */
    @Column({ type: 'text', nullable: true })
    searchQuery?: string | null;

    /**
     * Additional instructions for item categorization.
     * Affects how items are organized into categories and tagged.
     */
    @Column({ type: 'text', nullable: true })
    categorization?: string | null;

    /**
     * Additional instructions for deduplication.
     * Affects how duplicate items are identified and merged.
     */
    @Column({ type: 'text', nullable: true })
    deduplication?: string | null;

    /**
     * Additional instructions for source URL validation.
     * Affects which URLs are accepted as official sources.
     */
    @Column({ type: 'text', nullable: true })
    sourceValidation?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
