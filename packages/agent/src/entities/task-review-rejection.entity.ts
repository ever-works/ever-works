import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Where a rejection came from.
 *
 * - `task-review`  — a platform reviewer moved a `task_reviewers` row to
 *                    `requested-changes` and typed feedback.
 * - `pull-request` — a human OR an allow-listed reviewer bot rejected the
 *                    agent's PR on the git provider (`changes_requested`
 *                    review, an inline finding, or a summary comment).
 *                    `reviewerKind` tells the two apart.
 * - `gate`         — a quality gate exhausted its attempts; the machine
 *                    feedback is recorded so a later resume replays it.
 */
export type TaskReviewRejectionSource = 'task-review' | 'pull-request' | 'gate';

export const TASK_REVIEW_REJECTION_SOURCES: readonly TaskReviewRejectionSource[] = [
    'task-review',
    'pull-request',
    'gate',
];

/**
 * Trusted review bots (self-build fleet, finding R16) — the severity a
 * reviewer bot tagged a finding with, folded onto one scale: CodeRabbit's
 * `Critical | Major | Minor`, and Codex / Greptile `P1 | P2 | P3`. The
 * house rule "fix P2+ before the PR is clean" is exactly
 * `critical | major`. NULL = not stated (every human rejection, and a bot
 * body with no recognisable marker). Readers MUST treat NULL on a bot row
 * as `major`: an unrecognised marker is not evidence of a nit, and the
 * seeded prompt says so.
 */
export type TaskReviewRejectionSeverity = 'critical' | 'major' | 'minor';

export const TASK_REVIEW_REJECTION_SEVERITIES: readonly TaskReviewRejectionSeverity[] = [
    'critical',
    'major',
    'minor',
];

/**
 * Who rejected: a person, or an allow-listed reviewer bot. NULL on rows
 * written before the column existed, which were all human or gate.
 */
export type TaskReviewRejectionReviewerKind = 'human' | 'bot';

/** Hard cap on stored feedback. Applied by the writer before persisting. */
export const TASK_REVIEW_REJECTION_MAX_FEEDBACK_CHARS = 8000;

/**
 * Orchestration M9 — the **minimal durable review record**.
 *
 * The plan's mechanism is "when a reviewer rejects, the rejection text is
 * persisted and prepended to the resumed session's context". Before this
 * entity there was nowhere to persist it: `task_reviewers.reviewState`
 * carries a three-value enum and no text, and the PR review loop posted
 * its verdict to the provider and kept nothing.
 *
 * Deliberately append-only and deliberately NOT a workflow object — it is
 * one fact ("a human said no, here is why") with one consumer
 * (`RunSteeringService.resume`). `consumedByRunId` is the whole state
 * machine: NULL means the next resumed run for this Task will be seeded
 * with this feedback; non-NULL means it already was, exactly once.
 *
 * Rows are Task-scoped rather than run-scoped on purpose: the run that
 * produced the rejected work is usually already terminal, and the next
 * run is a NEW row (runs are immutable), so the Task is the only stable
 * join between "rejected" and "resumed".
 */
@Entity({ name: 'task_review_rejections' })
// The resume lookup: newest unconsumed rejection for a Task.
@Index('idx_task_review_rejection_task_consumed', ['taskId', 'consumedByRunId'])
@Index('idx_task_review_rejection_work', ['workId'])
export class TaskReviewRejection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    /** Denormalized Work scope for per-Work reporting. NULL when unknown. */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    /** The run whose output was rejected, when the rejection named one. */
    @Column({ type: 'uuid', nullable: true })
    runId?: string | null;

    @Column({ type: 'varchar', length: 16 })
    source: TaskReviewRejectionSource;

    /**
     * Platform user who rejected. NULL for `gate` (machine) and for a
     * provider-side reviewer with no linked platform account.
     */
    @Column({ type: 'uuid', nullable: true })
    reviewerUserId?: string | null;

    /**
     * Display name of the rejecting reviewer as reported by the source
     * (a provider login for `pull-request`). Untrusted external text —
     * neutralized before it ever reaches a prompt.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    reviewerLabel?: string | null;

    /**
     * The rejection text itself. UNTRUSTED: a PR review body is written
     * by whoever reviewed, so every consumer neutralizes control tokens
     * before splicing it into a prompt.
     */
    @Column({ type: 'text' })
    feedback: string;

    /** Pull request this rejection was recorded on, when applicable. */
    @Column({ type: 'int', nullable: true })
    prNumber?: number | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    prUrl?: string | null;

    /**
     * Severity the reviewer bot attached to this finding (R16). NULL for
     * human rejections and for bot bodies with no marker — the seeded
     * prompt then states no severity rather than inventing one.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    severity?: TaskReviewRejectionSeverity | null;

    /**
     * `human` | `bot` (R16). Lets the resumed run read an automated
     * finding as a reviewer bot's opinion, not the owner's instruction.
     */
    @Column({ type: 'varchar', length: 8, nullable: true })
    reviewerKind?: TaskReviewRejectionReviewerKind | null;

    /**
     * The resumed run this rejection was seeded into. NULL = still
     * pending, and that is the only "open/closed" state this record has.
     */
    @Column({ type: 'uuid', nullable: true })
    consumedByRunId?: string | null;

    @PortableDateColumn({ nullable: true })
    consumedAt?: Date | null;

    // Tier C scope denormalization (EW-657). No @ManyToOne — cycle
    // avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
