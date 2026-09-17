import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { BackupManifestSummary } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Workspace backup (AW-22) — one record of one attempt to produce a complete
 * archive of one workspace.
 *
 * ## Why this table exists at all
 *
 * The account export that ships today is stateless: it computes a payload
 * and returns it. Nothing can answer "when was my last backup", "is one
 * running right now", "how big was it", "what was left out" or "has it
 * expired" — and spec FR-3 (one at a time), FR-5 (progress and stall
 * detection), FR-28 (retention), FR-29 (the record outliving the bytes),
 * FR-30 (the history list), FR-31 (delete now) and FR-33 (one notification
 * per backup) all need those answers to be durable.
 *
 * No existing noun carries them. An `AgentRun` is one agent's execution, an
 * `ActivityLog` row is a past-tense fact with no lifecycle, and a `Task` is
 * delegated work with an assignee. This is a job record with an artefact
 * attached, and it is the only new noun the epic introduces.
 *
 * ## No new columns anywhere else
 *
 * A backup READS the other fifteen domains and writes only this row. Nothing
 * in the existing export/import/config-repo-sync path is touched.
 *
 * ## The index the decorators deliberately do NOT declare
 *
 * Spec FR-3 — at most one backup queued or running per workspace — is
 * enforced at the database by a PARTIAL unique index on
 * `(userId, COALESCE(organizationId, <nil uuid>)) WHERE status IN
 * ('queued','running')`, so two tabs pressing Create cannot race past an
 * application-level check. It is created as raw SQL in
 * `1791220000000-CreateWorkspaceBackups`, guarded on the Postgres driver,
 * and is intentionally absent from the decorators here: TypeORM's
 * `synchronize` (used only by the in-memory SQLite test driver) would
 * otherwise synthesise a NON-partial duplicate that rejected every second
 * backup a workspace ever took. `work_budgets` records the same reasoning
 * for the same reason.
 *
 * `userId` is a raw uuid with no `@ManyToOne` per the EW-654 cycle-avoidance
 * rule; its FK to `users(id)` ON DELETE CASCADE lives in the migration.
 */
@Entity({ name: 'workspace_backups' })
@Index('idx_workspace_backups_scope', ['userId', 'organizationId', 'requestedAt'])
@Index('idx_workspace_backups_sweep', ['status', 'expiresAt'])
export class WorkspaceBackup {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The workspace owner who asked for it (spec FR-10). */
    @Column({ type: 'uuid' })
    userId: string;

    // Tier C scope denormalization (EW-657). No @ManyToOne — cycle
    // avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /**
     * `NULL` means the owner's un-organized workspace. A backup covers
     * exactly one scope and never mixes two (spec FR-9).
     */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * `queued` `running` `ready` `ready_with_gaps` `failed` `cancelled`
     * `expired` `deleted`. Kept as a varchar rather than a database enum so
     * a new state never needs a migration on a column every row reads.
     */
    @Column({ type: 'varchar', length: 24 })
    status: string;

    /**
     * `stalled` `timeout` `too_large` `storage_unavailable`
     * `cancelled_by_user` `internal` — the reason the card renders specific
     * copy for, never a generic error.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    failureReason?: string | null;

    /** Operator-facing detail. Never rendered raw to the user, never in a response DTO. */
    @Column({ type: 'text', nullable: true })
    failureDetail?: string | null;

    /** Spec FR-7 — lifts the trim windows to the three-year ceiling. */
    @Column({ type: 'boolean', default: false })
    includeFullHistory: boolean;

    /** The archive format this run targeted, e.g. `1.0` (spec FR-27). */
    @Column({ type: 'varchar', length: 16 })
    formatVersion: string;

    /** The Ever Works build that produced it (spec FR-24). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    buildRef?: string | null;

    @CreateDateColumn()
    requestedAt: Date;

    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    finishedAt?: Date | null;

    /**
     * Stall detection (spec FR-5). A running backup that has not reported
     * for ten minutes is failed by the sweeper and its partial archive is
     * deleted, rather than sitting at "running" forever.
     */
    @PortableDateColumn({ nullable: true })
    lastHeartbeatAt?: Date | null;

    @Column({ type: 'int', default: 0 })
    progressPercent: number;

    /** A `BackupDomainKey`. Stored untranslated; the card renders its own label. */
    @Column({ type: 'varchar', length: 48, nullable: true })
    currentDomain?: string | null;

    @Column({ type: 'int', default: 0 })
    domainsCompleted: number;

    /**
     * Stored rather than derived from the current domain list, so a row
     * taken before a domain was added still reads "14 of 14" instead of
     * silently becoming "14 of 16".
     */
    @Column({ type: 'int', default: 15 })
    domainsTotal: number;

    /**
     * The manifest minus its per-file omission list — the one unbounded
     * part. Survives the artefact's deletion so the history list and the
     * coverage drawer stay legible for the ninety days the record outlives
     * its bytes (spec FR-29).
     */
    @Column({ type: 'simple-json', nullable: true })
    manifestSummary?: BackupManifestSummary | null;

    /** Which storage backend holds the bytes. Recorded, never branched on. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    storageBackend?: string | null;

    /** Opaque key from the storage plugin. Never leaves the server. */
    @Column({ type: 'varchar', length: 512, nullable: true })
    storageKey?: string | null;

    @Column({ type: 'bigint', nullable: true })
    sizeBytes?: string | number | null;

    /** SHA-256 of the archive itself, echoed on the download response. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    sha256?: string | null;

    @Column({ type: 'int', default: 0 })
    fileCount: number;

    /** Files described by their metadata row but left out for size (spec FR-15). */
    @Column({ type: 'int', default: 0 })
    omittedFileCount: number;

    /** `finishedAt + retention` (spec FR-28). */
    @PortableDateColumn({ nullable: true })
    expiresAt?: Date | null;

    /** Set when the bytes go, by expiry or by Delete now (spec FR-31). */
    @PortableDateColumn({ nullable: true })
    artifactDeletedAt?: Date | null;

    @Column({ type: 'int', default: 0 })
    downloadCount: number;

    @PortableDateColumn({ nullable: true })
    lastDownloadedAt?: Date | null;

    /** Handle returned by the job-runtime dispatcher, for cancellation. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    runtimeRunId?: string | null;

    /**
     * Enqueue-time tenant-runtime credential stamp, mirroring
     * `runtime-binding-stamper.service.ts`. Lets the worker resolve the
     * snapshot that was active when the backup was requested even if the
     * tenant rotates its overlay mid-run.
     */
    @Column({ type: 'int', nullable: true })
    credentialVersion?: number | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
