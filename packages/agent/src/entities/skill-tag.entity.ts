import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Skill } from './skill.entity';
import { User } from './user.entity';

/**
 * Skills shelf — one row per (Skill, tag).
 *
 * A Skill's tags live inside its `frontmatter` JSON, which is a text blob in
 * Postgres: no index, no facet count, and no way to ask "which Skills carry
 * `billing`?" without parsing every row. This table is the queryable copy.
 *
 * Tags are DERIVED, never authored here: `SkillsService` re-derives them from
 * `frontmatter.tags` (through `normalizeSkillTags`) in the same transaction as
 * every Skill write, so the stored tags can never disagree with the
 * definition. There is no endpoint that writes a tag directly.
 *
 * `tag` is already normalised: lower-case `[a-z0-9-]`, at most 40 chars.
 */
@Entity({ name: 'skill_tags' })
@Index('uq_skill_tags_skill_tag', ['skillId', 'tag'], { unique: true })
@Index('idx_skill_tags_user_tag', ['userId', 'tag'])
@Index('idx_skill_tags_skill', ['skillId'])
export class SkillTag {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    skillId: string;

    @ManyToOne(() => Skill, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'skillId' })
    skill?: Skill;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 40 })
    tag: string;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
