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
import type {
    SkillReadinessDetail,
    SkillReadinessState,
    SkillReviewState,
} from '@ever-works/contracts';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

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
@Index('idx_skills_user_invocation', ['userId', 'invocationSlug'])
// Skills shelf — the "needs attention" filter and summary count.
@Index('idx_skills_user_readiness', ['userId', 'readiness'])
// Skills shelf — the readiness sweep's oldest-verdict-first scan.
@Index('idx_skills_readiness_checked', ['readinessCheckedAt'])
// Skills shelf — one drafted Skill per run, as a database guarantee.
@Index('uq_skills_captured_run', ['capturedFromRunId'], {
    unique: true,
    where: '"capturedFromRunId" IS NOT NULL',
})
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

    /**
     * Optional user-facing slash command (`/plan`) that resolves this
     * Skill from a chat/task message. Normalized `^[a-z0-9][a-z0-9-]*$`,
     * unique per userId — uniqueness is enforced in `SkillsService`
     * (409 with the conflicting skill named) rather than by a DB
     * constraint so the error can carry the conflicting title.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    invocationSlug?: string | null;

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

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    // ── Skills shelf (additive; migration 1791110080000) ──────────────
    // Appended after every pre-existing column on purpose — nothing above
    // this line changed type, order or default.

    /**
     * The workspace-level off switch. `null` = on. A timestamp rather than a
     * boolean so "when did this stop being used" needs no audit join.
     * `SkillBindingRepository.resolveActive` excludes a Skill with this set;
     * its bindings are never touched.
     */
    @PortableDateColumn({ nullable: true })
    disabledAt?: Date | null;

    /**
     * Cached readiness verdict (`SkillReadinessState`). Starts `'unknown'` —
     * a verdict nobody computed is never reported as ready.
     */
    @Column({ type: 'varchar', length: 24, default: 'unknown' })
    readiness: SkillReadinessState;

    /** Why the verdict is what it is. Identifiers only — never a credential value. */
    @Column({ type: 'simple-json', nullable: true })
    readinessDetail?: SkillReadinessDetail | null;

    /** When the verdict was last computed; drives the hourly staleness sweep. */
    @PortableDateColumn({ nullable: true })
    readinessCheckedAt?: Date | null;

    /**
     * `'proposed'` for a Skill drafted by an agent and not yet accepted by a
     * person; `null` means accepted. Same vocabulary and null-means-accepted
     * convention as `work_knowledge_documents.reviewState`. A proposed Skill
     * is excluded from `resolveActive`.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    reviewState?: SkillReviewState | null;

    /**
     * The `agent_runs.id` a drafted Skill came from. No FK: deleting a run
     * must not delete the Skill it taught.
     */
    @Column({ type: 'uuid', nullable: true })
    capturedFromRunId?: string | null;
}
