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
    AppActionsState,
    AppReadinessState,
    AppRepositoryMode,
    AppSyncResult,
    AppUpstreamStatus,
} from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * App Works — the per-Work Upstream state row (APW-02).
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md` (FR-17…
 * FR-52). Plan: `…/plan.md` §3.1 (`plan.md:205-259`) is the normative column
 * list — this file implements it column for column, with the three index names
 * the plan fixes at `plan.md:258-259`. Migration:
 * `apps/api/src/migrations/1792020000000-CreateWorkUpstreamStates.ts` (§3.2).
 *
 * ## One row per App Work
 *
 * `workId` is UNIQUE (`uq_work_upstream_states_work`): the whole lifecycle of
 * one App Work — readiness, Actions hygiene, the schedule, the divergence
 * reading, the manual-sync allowance — is ONE row, so a second writer cannot
 * leave two half-states behind. The migration's FK is
 * `workId → works(id) ON DELETE CASCADE`: deleting the Work deletes its
 * Upstream state, because there is nothing left for it to describe.
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * Exactly as in `WorkDeployment` (`_types.ts:69-85`). A raw `Date` column is
 * `timestamp with time zone` on Postgres and `datetime` on SQLite, and the
 * dispatcher's hot predicate is a numeric comparison (`nextSyncAt <= :now`)
 * that has to mean the same thing on both. The transformer turns the stored
 * epoch back into a `Date` on read.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `relation`, `readinessState`, `lastSyncResult`, `upstreamStatus` and
 * `actionsState` are typed by the contracts unions (`APP_REPOSITORY_MODES`,
 * `APP_READINESS_STATES`, `APP_SYNC_RESULTS`, `APP_UPSTREAM_STATUSES`,
 * `APP_ACTIONS_STATES` — `packages/contracts/src/apps/app-upstream.ts`,
 * APW-02 T11), so a value the API can render is a value the column can hold.
 * `readinessReason` / `lastSyncReason` stay deliberately plain varchars: the
 * sets are closed in contracts (`AppReadinessFailureReason`, `AppSyncReason`)
 * and widened there first, never by a migration here.
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the reason `WorkDeployment` records at `:89-94` (EW-654/EW-655): a
 * relation here drags the Tenant/Organization entity graph into the decorator
 * evaluation of the whole inventory and re-creates the import cycle that bit
 * Phase 2. `conflictTaskId` is a bare uuid for the same class of reason the
 * plan states at `plan.md:244` — a deleted Task must not cascade into a state
 * row whose only connection to it is a link in a description.
 *
 * ## `nextSyncAt` is both the schedule and the pause
 *
 * `plan.md:236` — NULL while paused and for a `link` relation, otherwise the
 * next slot the dispatcher may claim. That is why the dispatcher's due scan
 * needs no separate "paused" flag: a paused Work has no `nextSyncAt` to claim.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/upstream-states.jsonl`, reached through the parent
 * Work ids; no column is redacted (`plan.md:203`, T45).
 *
 * ## APW-09 T43 — one column joins the plan's 55 (additive)
 *
 * `credentialMemberUserId` (FR-43) is the **only** column here that plan §3.1
 * does not list: APW-09's T43 asks for the credential of record to live on
 * "APW-02's upstream state where it already carries one" (`tasks.md:789`), and
 * until 2026-09-19 the row carried none, so a handover failed closed with
 * `handover_unavailable`. It is nullable with no default, so every row that
 * exists on both drivers is unchanged by its arrival and no backfill is owed
 * (see the column's own docstring). Nothing else about this table moves: the
 * three index names, the single `@ManyToOne` and the scope columns are exactly
 * as the plan fixes them.
 */
@Entity({ name: 'work_upstream_states' })
@Index('uq_work_upstream_states_work', ['workId'], { unique: true })
@Index('idx_work_upstream_states_next_sync', ['nextSyncAt'])
@Index('idx_work_upstream_states_readiness', ['readinessState', 'readinessHeartbeatAt'])
export class WorkUpstreamState {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work this row describes. One row per Work — see the class docstring. */
    @Column({ type: 'uuid' })
    workId: string;

    /** `link` · `fork` · `private-copy` (`APP_REPOSITORY_MODES`, spec §5.1). */
    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /** `link` (upstream only) · `fork` · `private-copy` — how the App Work was created. */
    @Column({ type: 'varchar', length: 16 })
    relation: AppRepositoryMode;

    /** The Work Repository's owner — the canonical coordinates every job reads. */
    @Column({ type: 'varchar', length: 100 })
    dataOwner: string;

    @Column({ type: 'varchar', length: 100 })
    dataRepo: string;

    /** The tracked branch: what sync merges into and diffing compares against. */
    @Column({ type: 'varchar', length: 255 })
    dataDefaultBranch: string;

    /** NULL for a `link` relation: a linked App Work has no upstream (FR-44). */
    @Column({ type: 'varchar', length: 100, nullable: true })
    upstreamOwner?: string | null;

    @Column({ type: 'varchar', length: 100, nullable: true })
    upstreamRepo?: string | null;

    /** Updated in place when upstream renames it (FR-43); the previous name is kept below. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    upstreamDefaultBranch?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    upstreamPreviousDefaultBranch?: string | null;

    /** `preparing` · `ready` · `timed_out` · `failed` · `waiting_for_setup_pr` (FR-17…FR-24a). */
    @Column({ type: 'varchar', length: 24, default: 'preparing' })
    readinessState: AppReadinessState;

    /**
     * A reason code from the closed set (`access_revoked`,
     * `dispatch_unavailable`, `too_large_for_private_copy`, `uses_lfs`,
     * `setup_pull_request_closed`, …). 48 characters is the plan's width.
     */
    @Column({ type: 'varchar', length: 48, nullable: true })
    readinessReason?: string | null;

    /**
     * When the readiness job was requested. NOT NULL by the plan
     * (`plan.md:222`) and reset by **Try again** (FR-19), so every row has a
     * clock the dispatcher can measure idleness against even before the first
     * probe reports.
     */
    @TimestampColumn()
    readinessStartedAt: Date;

    /** Stamped by each probe; the stale-preparing sweeper's liveness signal (FR-23). */
    @TimestampColumn({ nullable: true })
    readinessHeartbeatAt?: Date | null;

    /** Automatic dispatches so far — at most 3 (FR-23), then `timed_out`. */
    @Column({ type: 'int', default: 0 })
    readinessDispatches: number;

    /** **Try again** attempts inside the current rolling hour — at most 3 (FR-19). */
    @Column({ type: 'int', default: 0 })
    readinessManualRetries: number;

    /** Start of the rolling hour `readinessManualRetries` counts in. NULL = no window yet. */
    @TimestampColumn({ nullable: true })
    readinessManualWindowAt?: Date | null;

    @TimestampColumn({ nullable: true })
    readyAt?: Date | null;

    /** The setup pull request APW-01's handler outcome reported (Resolution R-4). */
    @Column({ type: 'varchar', length: 500, nullable: true })
    setupPullRequestUrl?: string | null;

    /** Read by the setup pull request check (FR-24a) — the number, never the URL, is the key. */
    @Column({ type: 'int', nullable: true })
    setupPullRequestNumber?: number | null;

    /** Last setup pull request check; throttles the on-view check to once per 60 s (FR-24a). */
    @TimestampColumn({ nullable: true })
    setupCheckedAt?: Date | null;

    /** Private-copy idempotency: the head this copy already pushed (FR-21). */
    @Column({ type: 'varchar', length: 40, nullable: true })
    copyPushedSha?: string | null;

    @Column({ type: 'int', nullable: true })
    aheadBy?: number | null;

    @Column({ type: 'int', nullable: true })
    behindBy?: number | null;

    @TimestampColumn({ nullable: true })
    divergenceComputedAt?: Date | null;

    /** `behindBy` at the last `app.upstream.behind` (FR-48) — one event per new commit. */
    @Column({ type: 'int', nullable: true })
    behindEventCount?: number | null;

    /** Upstream's default-branch head as the last read saw it. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    upstreamHeadSha?: string | null;

    /** The effective cron (the App spec's value, else the platform default — FR-32). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    syncSchedule?: string | null;

    /** NULL while paused or for a `link`; otherwise the next claimable slot (plan §3.1, §6.4). */
    @TimestampColumn({ nullable: true })
    nextSyncAt?: Date | null;

    /** `syncStartedAt > syncFinishedAt` means "running" for display; the lock is authoritative (FR-34). */
    @TimestampColumn({ nullable: true })
    syncStartedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    syncFinishedAt?: Date | null;

    /** `up_to_date` · `fast_forwarded` · `pull_request_opened` · … (`APP_SYNC_RESULTS`). */
    @Column({ type: 'varchar', length: 24, nullable: true })
    lastSyncResult?: AppSyncResult | null;

    @Column({ type: 'varchar', length: 48, nullable: true })
    lastSyncReason?: string | null;

    /** The upstream sha a fast-forward reached (FR-40). */
    @Column({ type: 'varchar', length: 40, nullable: true })
    lastSyncedUpstreamSha?: string | null;

    @Column({ type: 'int', nullable: true })
    lastSyncCommitCount?: number | null;

    @Column({ type: 'int', nullable: true })
    syncPullRequestNumber?: number | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    syncPullRequestUrl?: string | null;

    /**
     * Head of a sync pull request the member closed. While it equals upstream's
     * head the platform does not reopen one (S26) — upstream moving is what
     * makes the next sync open a fresh pull request.
     */
    @Column({ type: 'varchar', length: 40, nullable: true })
    syncPullRequestClosedHeadSha?: string | null;

    /** The conflict Task (FR-38). No FK — see the class docstring. */
    @Column({ type: 'uuid', nullable: true })
    conflictTaskId?: string | null;

    /** **Sync now** attempts inside the current rolling hour — at most 6 (FR-33). */
    @Column({ type: 'int', default: 0 })
    manualSyncCount: number;

    /** Start of the rolling hour `manualSyncCount` counts in. NULL = no window yet. */
    @TimestampColumn({ nullable: true })
    manualSyncWindowAt?: Date | null;

    /** Consecutive rate-limited syncs; 3 or more shows the persistent notice (FR-52). */
    @Column({ type: 'int', default: 0 })
    consecutiveRateLimited: number;

    /** Set from the provider's reset time; the dispatcher skips rows still inside it. */
    @TimestampColumn({ nullable: true })
    rateLimitedUntil?: Date | null;

    /** `available` · `archived` · `unavailable` · `none` · `unknown` (FR-41). */
    @Column({ type: 'varchar', length: 16, default: 'unknown' })
    upstreamStatus: AppUpstreamStatus;

    /** When upstream was last read back. Drives the 24-hour re-check while `unavailable` (FR-41). */
    @TimestampColumn({ nullable: true })
    upstreamCheckedAt?: Date | null;

    /** `available` · `missing` — `missing` stops every background job for the Work (FR-42). */
    @Column({ type: 'varchar', length: 16, default: 'available' })
    dataRepositoryStatus: 'available' | 'missing';

    /** `pending` · `clean` · `needs_admin` · `permission_missing` · `failed` · `not_applicable`. */
    @Column({ type: 'varchar', length: 24, default: 'pending' })
    actionsState: AppActionsState;

    /**
     * Workflow ids hygiene has already judged (≤ 500) — FR-27's "a workflow the
     * member turns back on stays on": an id in here is never touched again.
     */
    @Column({ type: 'simple-json', nullable: true })
    actionsSeenWorkflowIds?: number[] | null;

    /** `{ id, path }[]` (≤ 100) for the Activity entry and the Upstream card (FR-29). */
    @Column({ type: 'simple-json', nullable: true })
    actionsDisabledWorkflows?: Array<{ id: number; path: string }> | null;

    @Column({ type: 'simple-json', nullable: true })
    actionsKeptWorkflows?: Array<{ id: number; path: string }> | null;

    @TimestampColumn({ nullable: true })
    actionsCheckedAt?: Date | null;

    // APW-09 T43 (FR-43, XC-18) — the App Work's credential of record.
    /**
     * The member whose connection is the **credential of record** for this App
     * Work's background work, once a handover has recorded one.
     *
     * NULL means **no handover has been recorded**, and the credential of record
     * is then the Work's creator (`Work.userId`) — the member APW-01 FR-15 made
     * the fork with (decision D2). A handover (`spec.md:343-352`) writes this
     * column and nothing else: the member it names is re-read by every
     * background job that acts without a member present (scheduled sync, Actions
     * hygiene, build polling, upstream pull request status polling), which is
     * what FR-43's "never a different member's connection" means in practice.
     *
     * The default is NULL and it stays NULL for every row that exists today —
     * nobody has handed anything over yet, and inventing the creator's id here
     * would make "no handover" and "handed over to the creator" the same row.
     * The read is `WorkUpstreamStateRepository.findCredentialMemberUserId`; NULL
     * from a Work that has no state row at all reads the same way, which is why
     * the derivation is a fallback and not an error.
     *
     * Migration: `apps/api/src/migrations/1792090000000-AddWorkUpstreamCredentialMember.ts`.
     */
    @Column({ type: 'uuid', nullable: true })
    credentialMemberUserId?: string | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
