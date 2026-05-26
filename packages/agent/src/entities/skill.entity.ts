import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * Skills feature — Phase 8.1 (spec.md `features/skills/plan.md §3.1`).
 *
 * A `Skill` is a small Markdown document with YAML frontmatter that
 * describes a focused capability the platform can inject into AI runs
 * (e.g. "When you see a cron expression, default to UTC", "Style
 * guide for product page copy"). It is owned by one of five owner
 * types and resolved into the system message via
 * `SkillBindingRepository.resolveActive()`.
 *
 * Owner type lattice:
 *   - tenant  → user-wide; visible to any of the user's Agents.
 *   - mission → scoped to a single Mission; visible to Agents in that Mission.
 *   - idea    → scoped to a single Idea (a Mission's child).
 *   - work    → scoped to a single Work (a deployable artifact).
 *   - agent   → owned by a single Agent (its private "memory note").
 */
export type SkillOwnerType = 'tenant' | 'mission' | 'idea' | 'work' | 'agent';

export interface SkillFrontmatter {
    name: string;
    description: string;
    allowedTools?: string[];
    tags?: string[];
    [key: string]: unknown;
}

@Entity({ name: 'skills' })
@Index('uq_skills_owner_slug', ['ownerType', 'ownerId', 'slug'], { unique: true })
@Index('idx_skills_owner', ['ownerType', 'ownerId'])
@Index('idx_skills_user', ['userId'])
export class Skill {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 16 })
    ownerType: SkillOwnerType;

    @Column('uuid')
    ownerId: string;

    @Column({ type: 'varchar', length: 80 })
    slug: string;

    @Column({ type: 'varchar', length: 120 })
    title: string;

    @Column({ type: 'text' })
    description: string;

    @Column({ type: 'simple-json' })
    frontmatter: SkillFrontmatter;

    @Column({ type: 'text' })
    instructionsMd: string;

    @Column({ type: 'varchar', length: 64 })
    contentHash: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    sourcePath?: string | null;

    @Column({ type: 'varchar', length: 80, nullable: true })
    sourceCatalogSlug?: string | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    sourceCatalogVersion?: string | null;

    @Column({ type: 'varchar', length: 16, default: '1.0.0' })
    version: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
