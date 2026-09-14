import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Where a review row stands.
 *
 * - `dispatched` — claimed and handed to the job runtime. The reviewer
 *   may still submit a verdict.
 * - `approved` / `changes-requested` — the run said something explicit,
 *   and the `task_approvers` row was written.
 * - `refused` — the platform declined to accept the verdict (self-review,
 *   a head that moved, an approver that vanished). NOTHING was written.
 * - `failed` — the claim was taken but the dispatch never happened.
 *
 * Only `dispatched` is open; everything else is terminal, which is what
 * makes "has this reviewer already answered for this commit?" a single
 * indexed read.
 */
export type TaskAgentReviewState =
    | 'dispatched'
    | 'approved'
    | 'changes-requested'
    | 'refused'
    | 'failed';

export const TASK_AGENT_REVIEW_STATES: readonly TaskAgentReviewState[] = [
    'dispatched',
    'approved',
    'changes-requested',
    'refused',
    'failed',
];

/** `claimKey` is `varchar(200)`; every writer caps before persisting. */
export const TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS = 200;

/**
 * Reviewer agent stage (self-build slice AD, EW-811) — the review ledger.
 *
 * ## Two jobs, one row
 *
 * 1. **The budget.** One row IS one review run. The row is inserted
 *    BEFORE the dispatch and its `(taskId, claimKey)` unique index is the
 *    claim, exactly like `task_ci_auto_resume_attempts`: a retried
 *    transition, two API replicas handling one transition, a Task that
 *    flip-flops out of and back into `in_review` on the same commit, and
 *    a review run that transitions its own Task all resolve to the same
 *    `agent-review:<reviewerAgentId>:<headSha>` key and therefore to ONE
 *    row and ONE model run. Counting rows for a Task counts runs, never
 *    transitions, and it survives a crash, a redeploy and a replica swap.
 *
 * 2. **The binding.** It is the only durable link between a review run
 *    and the `task_approvers` row that run may write. `runId` is written
 *    by `bindRun` right after the run row is created and BEFORE the job
 *    runtime hears about it, and the verdict tool is handed the id of the
 *    run that is speaking from the tool loop's own context. "Did the
 *    platform dispatch THIS run to review this Task?" is answered by
 *    `idx_task_agent_review_run`; a run with no open row here — including
 *    any later run of the same agent — can record no verdict at all.
 *    (Before review, the binding was (task, agent), which let any run of
 *    the reviewer, even one that never received a diff, answer a review
 *    whose own run had died.)
 *
 * ## Why `headSha` is on the row and not implied
 *
 * A review is a statement about a COMMIT. Recording which commit was
 * reviewed is what lets the verdict be refused when the branch moved
 * while the run was in flight — the push-during-review case. Without it,
 * an approval rendered against code that has since been force-pushed away
 * would land on the approver row and read as current.
 *
 * ## What this row is NOT
 *
 * It is not, and can never become, the human merge approval slice AE
 * (EW-805) requires. That lives in `agent_action_proposals` with
 * `decidedVia = 'user'` and a non-null human decider;
 * `MergeApprovalService.verifyMergeApproval` reads that table and only
 * that table. Nothing here is written there.
 *
 * Append-mostly: the only updates are the pre-enqueue `runId` binding and
 * the one terminal `state` write. Nothing deletes a row — the budget is
 * the history.
 */
@Entity({ name: 'task_agent_reviews' })
// The budget read: how many review runs has this Task bought?  Also the
// "which reviews are still open for this Task?" lookup.
@Index('idx_task_agent_review_task', ['taskId'])
// The open-review lookup the verdict path uses, and the self-review
// disqualification's "did this agent already review this Task?" question.
@Index('idx_task_agent_review_reviewer', ['taskId', 'reviewerAgentId'])
// THE authorization lookup: which open review, if any, is bound to the run
// that is submitting a verdict?
@Index('idx_task_agent_review_run', ['runId'])
// The claim. UNIQUE is load-bearing: it is what turns a Task that
// re-enters review on the same commit into zero extra model runs.
@Index('uq_task_agent_review_claim', ['taskId', 'claimKey'], { unique: true })
export class TaskAgentReview {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    /** The `agents.id` this review was dispatched to. */
    @Column({ type: 'uuid' })
    reviewerAgentId: string;

    /**
     * The `task_approvers.id` this review's verdict may write. Captured at
     * dispatch so a verdict cannot be steered onto a different row later.
     */
    @Column({ type: 'uuid' })
    approverId: string;

    /**
     * The idempotency coordinate. UNIQUE per Task — see the class doc.
     * Untrusted provider values (a head SHA) are capped and never
     * interpolated anywhere but here.
     */
    @Column({ type: 'varchar', length: TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS })
    claimKey: string;

    /** The commit this review is a statement about. */
    @Column({ type: 'varchar', length: 64 })
    headSha: string;

    /** Pull request the diff came from, for reporting. */
    @Column({ type: 'int', nullable: true })
    prNumber?: number | null;

    /** CI roll-up handed to the reviewer in its brief. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    ciState?: string | null;

    /**
     * The run this review is bound to — the ONLY run that may answer it.
     * NULL when the row was claimed but no run row was ever created; the
     * claim still counts, deliberately, for the same reason slice AC keeps
     * a burned attempt: a claim a redelivery could retry forever is the
     * review storm this ledger exists to stop.
     */
    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    @Column({ type: 'varchar', length: 24, default: 'dispatched' })
    state: TaskAgentReviewState;

    /** Stable machine-readable note for a `refused` / `failed` row. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    refusalCode?: string | null;

    /** Reviewer's own summary, capped. Untrusted model output. */
    @Column({ type: 'text', nullable: true })
    summary?: string | null;

    /** When the terminal state was written. */
    @PortableDateColumn({ nullable: true })
    decidedAt?: Date | null;

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
