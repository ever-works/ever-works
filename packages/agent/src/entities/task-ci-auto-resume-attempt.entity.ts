import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What produced an auto-resume attempt.
 *
 * - `ci`     — a completed, FAILING check result arrived from the git
 *              provider (`check_run` / `check_suite` / `workflow_run`).
 * - `review` — a durable reviewer rejection was recorded for the Task
 *              (a human `changes_requested`, or a trusted reviewer bot's
 *              finding — slice AB) and nothing has consumed it yet.
 */
export type TaskAutoResumeTrigger = 'ci' | 'review';

export const TASK_AUTO_RESUME_TRIGGERS: readonly TaskAutoResumeTrigger[] = ['ci', 'review'];

/** `claimKey` is `varchar(200)`; every writer caps before persisting. */
export const TASK_AUTO_RESUME_CLAIM_KEY_MAX_CHARS = 200;

/**
 * CI feedback and the autonomous fix loop (self-build slice AC, EW-806) —
 * the **attempt ledger**, and the only durable retry budget the loop has.
 *
 * ## Why a ledger and not a counter column
 *
 * A single pull request emits DOZENS of `check_run` deliveries per push
 * (created + completed per job, more while jobs queue), GitHub redelivers
 * anything it did not get a 2xx for, and each spurious resume is a whole
 * model run on one of six fleet PCs. So the budget cannot be "increment a
 * number when an event arrives" — an event is not an attempt.
 *
 * One row here IS one attempt. The row is inserted BEFORE the resume is
 * dispatched and its `(taskId, claimKey)` unique index is the claim: the
 * loser of a race (and every redelivery) hits the constraint, is told the
 * attempt already exists, and resumes nothing. Counting rows for a Task
 * is therefore counting attempts, never events, and it survives a crash,
 * a redeploy and a replica swap because it is a row and not memory.
 *
 * `claimKey` is what makes a resume idempotent for a given
 * (task, head commit, failure):
 *
 *   * `ci:<headSha>`        — one attempt per Task per HEAD COMMIT. This is
 *                             deliberately stronger than one-per-failing-
 *                             check: a 12-job matrix goes red 12 times for
 *                             one push and that is ONE thing to fix.
 *   * `review:<rejectionId>` — one attempt per durable rejection row. The
 *                             row's own `consumedByRunId` CAS is the second
 *                             guard behind this one.
 *
 * `failureKey` is a fingerprint of WHAT failed (the failing check names
 * plus a digest of the reported output). It is not part of the claim; it
 * answers a different question — "has this Task already been retried
 * against this exact failure?" — so a failure that recurs byte-identical
 * on a NEW head stops the loop instead of buying another attempt.
 * Retrying an unchanged failure is not progress.
 *
 * Append-only. Nothing ever updates a row except the best-effort
 * `resumedRunId` stamp, and nothing deletes one: the budget is the
 * history.
 */
@Entity({ name: 'task_ci_auto_resume_attempts' })
// The budget read: how many attempts has this Task spent?  Also the
// no-progress lookup, which filters `failureKey` inside the same Task.
@Index('idx_task_ci_auto_resume_task', ['taskId'])
// The claim. UNIQUE is load-bearing: it is what makes a redelivered
// check event, or two API replicas racing on one delivery, resolve to
// exactly ONE resume instead of two model runs.
@Index('uq_task_ci_auto_resume_claim', ['taskId', 'claimKey'], { unique: true })
export class TaskCiAutoResumeAttempt {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    /** `ci` | `review` — which signal bought this attempt. */
    @Column({ type: 'varchar', length: 16 })
    trigger: TaskAutoResumeTrigger;

    /**
     * The idempotency coordinate. UNIQUE per Task — see the class doc.
     * Untrusted provider values (a head SHA) are capped and never
     * interpolated anywhere but here.
     */
    @Column({ type: 'varchar', length: TASK_AUTO_RESUME_CLAIM_KEY_MAX_CHARS })
    claimKey: string;

    /** Head commit the failing checks were reported against. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    headSha?: string | null;

    /**
     * Fingerprint of the failure this attempt answered — failing check
     * names + a digest of the reported output. NULL for `review`
     * attempts, whose "what" is the rejection text itself.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    failureKey?: string | null;

    /** The run this attempt resumed FROM (already terminal). */
    @Column({ type: 'uuid', nullable: true })
    sourceRunId?: string | null;

    /**
     * The run the resume created. NULL when the row was claimed but the
     * dispatch then failed — deliberately: a burned attempt that bought
     * nothing still costs budget, because the alternative is a claim that
     * can be retried forever by a redelivery.
     */
    @Column({ type: 'uuid', nullable: true })
    resumedRunId?: string | null;

    /** Short machine-readable note (`check_run:lint-and-test`, …). */
    @Column({ type: 'varchar', length: 200, nullable: true })
    detail?: string | null;

    /** Denormalized Work scope, for per-Work reporting. */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    // Tier C scope denormalization (EW-657). No @ManyToOne — cycle
    // avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
