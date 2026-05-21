import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    Unique,
    JoinColumn,
} from 'typeorm';
import { Work } from './work.entity';
import { ClassToObject } from './types';

/**
 * Per-Work tag catalog.
 *
 * Documents (`work_knowledge_documents.tags`) store the tag slugs as
 * a `simple-json` array; this table provides normalization (name,
 * color token, description) for UI autocomplete + filter rendering.
 *
 * Tags are per-Work. No org-level tag taxonomy in v1.
 */
@Entity({ name: 'work_knowledge_tags' })
@Unique(['workId', 'slug'])
@Index(['workId', 'slug'])
export class WorkKnowledgeTag {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ type: 'varchar', length: 64 })
    slug: string;

    @Column({ type: 'varchar', length: 128 })
    name: string;

    /**
     * Design-token color name (e.g. `slate`, `blue`, `emerald`).
     * Stored as a token name (varchar), not a hex value, so dark/light
     * mode rendering is automatic and contrast is guaranteed by the
     * design system. See spec §11.1 for the fixed palette + the
     * auto-derive-from-slug fallback.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    color?: string | null;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
