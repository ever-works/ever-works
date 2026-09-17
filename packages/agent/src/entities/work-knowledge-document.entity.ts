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
    KbDecisionState,
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
    KbLockMode,
    KbReviewState,
} from './kb-types';
import { WorkKnowledgeUpload } from './work-knowledge-upload.entity';
import { TimestampColumn } from './_types';
import type { KbConsolidationMarker } from '../services/memory-consolidation';

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
// Knowledge library — the folder-filtered list and the default
// "recently changed" sort for the organization shelf and a Work's shelf.
@Index('idx_wkd_folder', ['folderId'])
@Index('idx_wkd_org_status_revision_at', ['organizationId', 'status', 'revisionAt'])
@Index('idx_wkd_work_status_revision_at', ['workId', 'status', 'revisionAt'])
export class WorkKnowledgeDocument {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Work-level scope. Set for all classes except when this row is an
     * org-level inheritable document, in which case `organizationId`
     * is set instead. Enforced by the `work_knowledge_documents_scope_xor`
     * CHECK constraint.
     */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @ManyToOne(() => Work, { onDelete: 'CASCADE', nullable: true })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work> | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A tenant scope.
    // organizationId already exists from earlier work (below); tenantId
    // joins it here. Both NULL until first-Org create (Phase 6).
    // Ordered tenantId-first to match the other 17 Tier A entities.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /**
     * Organization-level scope. Restricted at the service layer to
     * `kbDocumentClass IN ('legal', 'style', 'seo')` in v1 — see
     * `KB_ORG_INHERITABLE_CLASSES` in `kb-types.ts`.
     */
    @Column({ type: 'uuid', nullable: true })
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
    @Column({ type: 'uuid', nullable: true, name: 'source_upload_id' })
    sourceUploadId?: string | null;

    @ManyToOne(() => WorkKnowledgeUpload, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'source_upload_id' })
    sourceUpload?: ClassToObject<WorkKnowledgeUpload> | null;

    /** If imported from a URL via an extractor plugin. */
    @Column({ type: 'varchar', length: 2048, nullable: true, name: 'source_url' })
    sourceUrl?: string | null;

    /** Provenance for `source='agent'`. */
    @Column({ type: 'uuid', nullable: true, name: 'generated_by_agent_run_id' })
    generatedByAgentRunId?: string | null;

    @ManyToOne(() => WorkAgentRun, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'generated_by_agent_run_id' })
    generatedByAgentRun?: ClassToObject<WorkAgentRun> | null;

    @Column({ type: 'uuid', nullable: true, name: 'created_by_id' })
    createdById?: string | null;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'created_by_id' })
    createdBy?: ClassToObject<User> | null;

    @Column({ type: 'uuid', nullable: true, name: 'updated_by_id' })
    updatedById?: string | null;

    @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'updated_by_id' })
    updatedBy?: ClassToObject<User> | null;

    // EW-639 prod-hotfix: the 1779971 migration creates this column as
    // snake_case `last_indexed_at`; same camelCase/snake_case mismatch
    // class as the upload entity's `extractionStartedAt`. Pass the
    // explicit `name:` so TypeORM emits the right column in SELECTs.
    @TimestampColumn({ nullable: true, name: 'last_indexed_at' })
    lastIndexedAt?: Date | null;

    @Column({ type: 'varchar', length: 40, nullable: true, name: 'last_commit_sha' })
    lastCommitSha?: string | null;

    /** Free-form extension dict for future fields. */
    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, unknown> | null;

    /**
     * Memory Consolidation marker. `null` / absent = a normal document
     * (the feature is fully additive — nothing changes until a
     * consolidation run writes a marker). `promoted` docs surface with a
     * highlight badge in the org Memory feed; `superseded` docs stay
     * readable but are muted. Documents are NEVER deleted by
     * consolidation. See `services/memory-consolidation.ts` for the
     * marker shape + semantics; migration
     * `1782000000000-AddKbDocumentConsolidation` adds the column.
     */
    @Column({ type: 'simple-json', nullable: true })
    consolidation?: KbConsolidationMarker | null;

    /**
     * Decision lifecycle state (memory upgrades M4). Non-null only for
     * `kbDocumentClass = 'decision'` rows. Status transitions are
     * platform-side API calls validated against the status machine
     * (`KB_DECISION_STATUS_TRANSITIONS`) — never an external event.
     * Migration `1783700000000-AddKbDecisionReviewColumns` adds the
     * column; `null` on every pre-existing row (fully additive).
     */
    @Column({ type: 'simple-json', nullable: true })
    decision?: KbDecisionState | null;

    /**
     * Review state (memory upgrades M7). `'proposed'` for agent-authored
     * / consolidation-synthesized docs awaiting human review — such docs
     * are excluded from context injection until accepted. `null` (all
     * human-authored + pre-existing rows) is treated as `'accepted'`.
     */
    @Column({ type: 'varchar', nullable: true, name: 'review_state' })
    reviewState?: KbReviewState | null;

    /**
     * Knowledge library — the shared (organization-scope) folder this
     * document is filed in. `NULL` = Unfiled. Raw uuid, no `@ManyToOne`
     * (EW-654 no-cycle rule); the migration adds the FK to `memory_folders`
     * with `ON DELETE SET NULL`, and the library service also clears it
     * explicitly on folder delete so drivers without the FK behave alike.
     * A document is filed only into a folder of its own Organization — a
     * service-layer invariant, because the document's effective
     * Organization may come from its Work rather than this row.
     */
    @Column({ type: 'uuid', nullable: true, name: 'folder_id' })
    folderId?: string | null;

    /**
     * Knowledge library — substantive-change counter. Starts at 1 and moves
     * by exactly 1 when the title, description, tags, class or the
     * whitespace-normalized body changes.
     *
     * `updatedAt` cannot stand in for it: it is an `@UpdateDateColumn`, so
     * it moves whenever the mirror job stamps `lastCommitSha`, the embed job
     * stamps `lastIndexedAt`, or any other bookkeeping write touches the
     * row. Driving "changed since you last read it" from `updatedAt` would
     * flag every document for every reader after each background sweep.
     */
    @Column({ type: 'int', default: 1 })
    revision: number;

    /**
     * When `revision` last moved. Powers "changed 06:04" and the default
     * library sort without trusting `updatedAt` (see `revision`).
     */
    @Column({ type: Date, nullable: true, name: 'revision_at' })
    revisionAt?: Date | null;

    /**
     * SHA-256 of the whitespace-normalized body (`kb-content-hash.ts`) —
     * the comparison input for a substantive body change. `NULL` on rows
     * that predate the library: the first write seeds it without moving
     * `revision`, so shipping the library never flags old documents.
     */
    @Column({ type: 'varchar', length: 64, nullable: true, name: 'normalized_content_hash' })
    normalizedContentHash?: string | null;

    /** Knowledge library — when the document was last archived; `NULL` while on the shelf. */
    @Column({ type: Date, nullable: true, name: 'archived_at' })
    archivedAt?: Date | null;

    /**
     * Knowledge library — who archived it. Raw uuid; the migration adds the
     * FK to `users` with `ON DELETE SET NULL`.
     */
    @Column({ type: 'uuid', nullable: true, name: 'archived_by_id' })
    archivedById?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
