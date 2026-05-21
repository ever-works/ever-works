import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
    JoinColumn,
    Check,
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';
import { WorkAgentRun } from './work-agent-run.entity';
import { ClassToObject } from './types';
import {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
} from './kb-types';
import { WorkKnowledgeUpload } from './work-knowledge-upload.entity';

/**
 * A typed Knowledge Base document.
 *
 * Scoped to a Work for most classes. The `legal` / `style` / `seo`
 * classes additionally support org-level scope (one of `workId` /
 * `organizationId` is set, the other NULL — enforced by the CHECK
 * constraint). Org-scoped docs are inherited by every Work in the org
 * unless the Work overrides at the same `path`.
 *
 * Two-layer persistence: this row is the metadata source-of-truth; the
 * Markdown body + sidecar YAML live in the Work's Git data repo at
 * `.content/kb/<class>/<slug>.{yml,md}`. See spec
 * `docs/specs/features/knowledge-base/spec.md` §6.1 + §7 for the full
 * shape.
 */
@Entity({ name: 'work_knowledge_documents' })
@Check(
    'work_knowledge_documents_scope_xor',
    '("workId" IS NOT NULL AND "organizationId" IS NULL) OR ("workId" IS NULL AND "organizationId" IS NOT NULL)',
)
@Index(['workId', 'kbDocumentClass'])
@Index(['organizationId', 'kbDocumentClass'])
@Index(['workId', 'status'])
@Index(['workId', 'updatedAt'])
export class WorkKnowledgeDocument {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Work-level scope. Set for all classes except when this row is an
     * org-level inheritable document, in which case `organizationId`
     * is set instead. Enforced by the `work_knowledge_documents_scope_xor`
     * CHECK constraint.
     */
    @Column({ nullable: true })
    workId?: string | null;

    @ManyToOne(() => Work, { onDelete: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work> | null;

    /**
     * Organization-level scope. Restricted at the service layer to
     * `kbDocumentClass IN ('legal', 'style', 'seo')` in v1 — see
     * `KB_ORG_INHERITABLE_CLASSES` in `kb-types.ts`.
     */
    @Column({ nullable: true })
    organizationId?: string | null;

    /** Forward-slash separated, relative to `.content/kb/`. e.g. `brand/voice.md`. */
    @Column({ type: 'varchar', length: 512 })
    path: string;

    /** Kebab-case, last path segment without extension. */
    @Column({ type: 'varchar', length: 255 })
    slug: string;

    @Column({ type: 'varchar', length: 255 })
    title: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    /** See `KbDocumentClass` for per-class agent semantics. */
    @Column({ type: 'varchar', name: 'kb_document_class' })
    kbDocumentClass: KbDocumentClass;

    @Column({ type: 'simple-json', nullable: true })
    tags?: string[] | null;

    @Column({ type: 'simple-json', nullable: true })
    categories?: string[] | null;

    @Column({ type: 'varchar', default: KbDocumentStatus.ACTIVE })
    status: KbDocumentStatus;

    /**
     * When `true`, scheduled regeneration + agent runs may not mutate
     * this document. See spec §17.3 for the precedence rules.
     */
    @Column({ default: false })
    locked: boolean;

    @Column({ type: 'varchar', nullable: true, name: 'lock_mode' })
    lockMode?: KbLockMode | null;

    /** BCP-47 language tag. */
    @Column({ type: 'varchar', length: 8, default: 'en' })
    language: string;

    @Column({ type: 'int', nullable: true, name: 'word_count' })
    wordCount?: number | null;

    @Column({ type: 'int', nullable: true, name: 'token_count' })
    tokenCount?: number | null;

    @Column({ type: 'varchar', default: KbDocumentSource.USER })
    source: KbDocumentSource;

    /** Set when this document was derived from an upload. */
    @Column({ nullable: true, name: 'source_upload_id' })
    sourceUploadId?: string | null;

    @ManyToOne(() => WorkKnowledgeUpload, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'source_upload_id' })
    sourceUpload?: ClassToObject<WorkKnowledgeUpload> | null;

    /** If imported from a URL via an extractor plugin. */
    @Column({ type: 'varchar', length: 2048, nullable: true, name: 'source_url' })
    sourceUrl?: string | null;

    /** Provenance for `source='agent'`. */
    @Column({ nullable: true, name: 'generated_by_agent_run_id' })
    generatedByAgentRunId?: string | null;

    @ManyToOne(() => WorkAgentRun, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'generated_by_agent_run_id' })
    generatedByAgentRun?: ClassToObject<WorkAgentRun> | null;

    @Column({ nullable: true, name: 'created_by_id' })
    createdById?: string | null;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'created_by_id' })
    createdBy?: ClassToObject<User> | null;

    @Column({ nullable: true, name: 'updated_by_id' })
    updatedById?: string | null;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'updated_by_id' })
    updatedBy?: ClassToObject<User> | null;

    @Column({ type: 'timestamptz', nullable: true, name: 'last_indexed_at' })
    lastIndexedAt?: Date | null;

    @Column({ type: 'varchar', length: 40, nullable: true, name: 'last_commit_sha' })
    lastCommitSha?: string | null;

    /** Free-form extension dict for future fields. */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
