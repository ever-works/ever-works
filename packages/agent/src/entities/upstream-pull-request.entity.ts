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
    UpstreamChecksSummary,
    UpstreamPreparationReport,
    UpstreamPullRequestOrigin,
    UpstreamPullRequestState,
    UpstreamReviewSummary,
    UpstreamSignatureState,
} from '@ever-works/contracts';
import { User } from './user.entity';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { PortableDateColumn } from './_types';

/** `diffStats` as stored (plan §3.1). */
export interface UpstreamPullRequestDiffStats {
    files: number;
    additions: number;
    deletions: number;
    /** ≤ `UPSTREAM_SIZE.maxExtraFiles` paths "Not in the original change" (FR-10). */
    extraFiles: string[];
}

/** One agent-reported check (FR-47), as stored in `checkResults`. */
export type UpstreamPullRequestCheckResult = UpstreamPreparationReport['checks'][number] & {
    source?: 'agent';
};

/**
 * The `preparationPausedMs` bigint comes back as a STRING from the Postgres driver;
 * the record reads it as a number on every driver.
 */
const BIGINT_AS_NUMBER = {
    to: (value: unknown): unknown => value,
    from: (value: unknown): number => {
        const parsed = typeof value === 'number' ? value : Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    },
};

/**
 * APW-09 — one upstream pull request record (plan §3.1, CONTRACTS §1 `UpstreamPullRequest`).
 *
 * One row per proposal from a fork App Work to its upstream repository, from the first
 * `preparing` step to a final `merged` / `closed` / `refused` / `failed` / `expired` /
 * `withdrawn`, and one row per pull request the member opened directly through
 * `POST /api/works/:id/upstream-pr` (`origin: 'direct'`).
 *
 * ## What this row never holds
 *
 * A token. The pull request is opened with the member's own connection, resolved at the
 * moment of use (FR-24, FR-43) — nothing here can be replayed against the provider.
 * `refusalDetail` holds at most a quoted guide sentence or the provider's own message
 * (≤ 500), never a diff and never a secret-screen sample (G13).
 *
 * ## The one active row per source Task
 *
 * `uq_upr_active_source` is a PARTIAL unique index over `sourceTaskId` while the state
 * is one of `UPSTREAM_ACTIVE_STATES` (FR-5, S27): a closed or refused row frees the slot.
 * Migration `1792090100000-CreateUpstreamPullRequests`. MySQL/MariaDB receive the index
 * without the predicate (no partial indexes), the same posture as
 * `uq_work_app_provisionings_active`.
 *
 * ## Two columns beyond plan §3.1 (additive, recorded in the APW-09 lane log)
 *
 * - `origin` (`proposal` · `direct`) — the direct route opens a draft from an existing
 *   fork branch with no preparation step; its rows count toward the same rate limits.
 * - `draft` — whether the pull request was opened as a draft.
 *
 * And one relaxation: `sourceTaskId` is NULLABLE, because the direct route may name a
 * fork branch rather than a Task. A proposal always carries one. NULLs never collide in
 * the partial unique index on either driver.
 *
 * ## Keys
 *
 * `userId → users(id)` and `workId → works(id)`, both ON DELETE CASCADE: the record is
 * the author's and the App Work's. Every Task id is bare (no FK): a Task deletion must not
 * erase a published pull request's record. Scope columns are plain uuids with no relation
 * (EW-654/EW-655), stamped by the scope subscriber.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/upstream-pull-requests.jsonl` through the parent Work ids;
 * nothing is redacted (plan §3 preamble). The domain-table row is the account-transfer
 * lane's to add.
 */
@Entity({ name: 'upstream_pull_requests' })
@Index('idx_upr_work_state', ['workId', 'state'])
@Index('idx_upr_user_upstream_opened', ['userId', 'upstreamOwner', 'upstreamRepo', 'openedAt'])
@Index('idx_upr_upstream_opened', ['upstreamOwner', 'upstreamRepo', 'openedAt'])
@Index('idx_upr_due', ['state', 'nextCheckAt'])
@Index('idx_upr_preparing_started', ['state', 'preparationStartedAt'])
@Index('uq_upr_active_source', ['sourceTaskId'], {
    unique: true,
    where: "state IN ('preparing', 'needs_signature', 'awaiting_approval', 'opening', 'open')",
})
export class UpstreamPullRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The author — the member whose GitHub account the pull request carries (FR-21, FR-24). */
    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'uuid' })
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** The Task whose merged change is proposed. NULL only for a direct, branch-named pull request. */
    @Column({ type: 'uuid', nullable: true })
    sourceTaskId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    preparationTaskId?: string | null;

    /** The latest review follow-up Task (FR-31). */
    @Column({ type: 'uuid', nullable: true })
    followUpTaskId?: string | null;

    /** `proposal` · `direct` — see the class docstring. */
    @Column({ type: 'varchar', length: 16, default: 'proposal' })
    origin: UpstreamPullRequestOrigin;

    @Column({ type: 'varchar', length: 100 })
    upstreamOwner: string;

    @Column({ type: 'varchar', length: 100 })
    upstreamRepo: string;

    @Column({ type: 'varchar', length: 255 })
    baseBranch: string;

    /** The fork's owner — the head is `{headOwner}:{headBranch}`. */
    @Column({ type: 'varchar', length: 100 })
    headOwner: string;

    @Column({ type: 'varchar', length: 100 })
    headRepo: string;

    /** `upstream-pr/{slug≤40}-{4 hex}` for a proposal; the named fork branch for a direct one. */
    @Column({ type: 'varchar', length: 255 })
    headBranch: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    headSha?: string | null;

    /** G01 — the upstream default-branch commit `headBranch` was cut from (the squash base). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    upstreamBaseSha?: string | null;

    /** G14 — when the 90-minute running clock started. */
    @PortableDateColumn({ nullable: true })
    preparationStartedAt?: Date | null;

    /** G14 — when the row was last parked by a hold (NULL while running). */
    @PortableDateColumn({ nullable: true })
    preparationHeldSince?: Date | null;

    /** G14 — accumulated pause time, subtracted from the running clock. */
    @Column({ type: 'bigint', default: 0, transformer: BIGINT_AS_NUMBER })
    preparationPausedMs: number;

    /** `UPSTREAM_PULL_REQUEST_STATES`. */
    @Column({ type: 'varchar', length: 24, default: 'preparing' })
    state: UpstreamPullRequestState;

    @Column({ type: 'int', nullable: true })
    number?: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    url?: string | null;

    @Column({ type: 'boolean', default: false })
    draft: boolean;

    /** Public text by design; kept for the approval and audit. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    title?: string | null;

    @Column({ type: 'text', nullable: true })
    body?: string | null;

    @Column({ type: 'varchar', length: 300, nullable: true })
    disclosureText?: string | null;

    /** G04 — the agreement link the preparation report carried (FR-19). */
    @Column({ type: 'varchar', length: 512, nullable: true })
    claUrl?: string | null;

    /** G04 — ≤ 10 short strings from the report's `doesNotPort` list (S21). */
    @Column({ type: 'simple-json', nullable: true })
    missingPieces?: string[] | null;

    @Column({ type: 'boolean', default: true })
    maintainerCanModify: boolean;

    /** FR-23 — sha256 hex of the approved values; never the values themselves. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    fingerprint?: string | null;

    @Column({ type: 'uuid', nullable: true })
    approvalProposalId?: string | null;

    @PortableDateColumn({ nullable: true })
    approvalExpiresAt?: Date | null;

    /** G06 / FR-49 — "I've reviewed the extra files", recorded for the caller. */
    @PortableDateColumn({ nullable: true })
    extraFilesAcknowledgedAt?: Date | null;

    @Column({ type: 'uuid', nullable: true })
    extraFilesAcknowledgedById?: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    checksSummary?: UpstreamChecksSummary | null;

    @Column({ type: 'varchar', length: 24, nullable: true })
    reviewSummary?: UpstreamReviewSummary | null;

    @Column({ type: 'varchar', length: 24, nullable: true })
    signatureState?: UpstreamSignatureState | null;

    /** An `UPSTREAM_REFUSAL_CODES` value. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    refusalCode?: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    refusalDetail?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    diffStats?: UpstreamPullRequestDiffStats | null;

    @Column({ type: 'simple-json', nullable: true })
    checkResults?: UpstreamPullRequestCheckResult[] | null;

    /** ≤ 200 provider review ids; the oldest is evicted past 200 (G23). */
    @Column({ type: 'simple-json', nullable: true })
    seenReviewIds?: number[] | null;

    /** ≤ 20 ISO times of approved pushes (the 24-hour push window). */
    @Column({ type: 'simple-json', nullable: true })
    pushTimestamps?: string[] | null;

    @PortableDateColumn({ nullable: true })
    forkBranchDeletedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastUpstreamActivityAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastCheckedAt?: Date | null;

    /** The status poll's schedule; NULL = not polled (paused, or final). */
    @PortableDateColumn({ nullable: true })
    nextCheckAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    openedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    mergedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    closedAt?: Date | null;

    // EW-655 — Tier A scope columns, plain uuids with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
