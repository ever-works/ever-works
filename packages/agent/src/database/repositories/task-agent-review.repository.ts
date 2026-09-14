import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
    TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS,
    TaskAgentReview,
    type TaskAgentReviewState,
} from '../../entities/task-agent-review.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { agentReviewClaimKey } from '../../tasks-domain/task-agent-review';
import { serializeOnSingleConnection } from './single-connection-write-queue';

export interface ClaimAgentReviewInput {
    taskId: string;
    reviewerAgentId: string;
    approverId: string;
    /** Idempotency coordinate — UNIQUE per Task. See the entity doc. */
    claimKey: string;
    headSha: string;
    /**
     * The Task's lifetime review budget. The claim takes a slot in
     * `[0, maxRuns)` or is refused `budget-spent` — see {@link
     * TaskAgentReviewRepository.claim}. Required: a claim that does not
     * say what the budget is cannot be checked against it.
     */
    maxRuns: number;
    prNumber?: number | null;
    ciState?: string | null;
    workId?: string | null;
    tenantId?: string | null;
    organizationId?: string | null;
}

/** What {@link TaskAgentReviewRepository.claim} did. */
export type ClaimAgentReviewResult =
    | { outcome: 'claimed'; review: TaskAgentReview }
    | { outcome: 'already-claimed' }
    | { outcome: 'budget-spent' };

/** The verdict write {@link TaskAgentReviewRepository.recordVerdict} performs. */
export interface RecordAgentVerdictInput {
    reviewId: string;
    /** The review ledger's terminal state for this verdict. */
    state: 'approved' | 'changes-requested';
    summary?: string | null;
    approver: {
        /** `task_approvers.id` — the row the review was dispatched for. */
        id: string;
        taskId: string;
        /** The agent the approver row must still name. */
        reviewerAgentId: string;
        approvalState: 'approved' | 'rejected';
        decidedByRunId: string | null;
        decidedHeadSha: string;
    };
}

/**
 * What the verdict write did.
 *
 *  - `recorded`             — the review is settled AND the approver row
 *    carries the decision. Both committed.
 *  - `review-not-open`      — the review was already settled (a second call
 *    of the verdict tool, or a concurrent one that won). Nothing written.
 *  - `approver-not-written` — the approver write matched no row. The whole
 *    write rolled back; the review is still OPEN.
 *  - `superseded`           — the approver row already carries a verdict
 *    from a review claimed AFTER this one (a newer commit's review answered
 *    first). Nothing written; the review is still OPEN, and the caller
 *    closes it — an older verdict must not overwrite a newer one.
 */
export type RecordAgentVerdictOutcome =
    | 'recorded'
    | 'review-not-open'
    | 'approver-not-written'
    | 'superseded';

/** Internal: aborts the verdict transaction when the approver write missed. */
class ApproverNotWrittenRollback extends Error {
    constructor() {
        super('agent-review-approver-not-written');
    }
}

/** Internal: aborts the verdict transaction when a newer verdict holds the row. */
class SupersededVerdictRollback extends Error {
    constructor() {
        super('agent-review-verdict-superseded');
    }
}

/**
 * Reviewer agent stage (slice AD, EW-811) — the review ledger's
 * operations, and no more.
 *
 * Every method here is on the money path or the authorization path:
 * `claim` IS the lifetime budget (a unique slot) and the idempotency guard
 * (a unique claim key), `countForTask` is its cheap early exit,
 * `recordVerdict` IS the one write that settles a review and its approver
 * row together, `bindRun` + `findOpenForRun` ARE the proof that the platform
 * dispatched THIS run for this review. All of them are allowed to THROW, and the
 * caller depends on it — a budget nobody can count is not a budget, a
 * claim that cannot be written must not be treated as won, and an
 * authorization lookup that fails must refuse rather than admit.
 * Nothing in this file swallows an error into a permissive default.
 */
@Injectable()
export class TaskAgentReviewRepository {
    constructor(
        @InjectRepository(TaskAgentReview)
        private readonly repository: Repository<TaskAgentReview>,
    ) {}

    /**
     * How many review runs this Task has already bought, over its whole
     * life. Rows, not transitions. THROWS on a read failure.
     *
     * An early exit only — read before any provider call so a spent Task
     * costs nothing. It is NOT the bound: two planners can read the same
     * count. {@link claim}'s unique slot is.
     */
    async countForTask(taskId: string): Promise<number> {
        return this.repository.count({ where: { taskId } });
    }

    /**
     * Claim ONE review AND one of the Task's lifetime budget slots, or say
     * precisely why not.
     *
     *  - `claimed`         — this caller inserted the row; it holds `slot`.
     *  - `already-claimed` — the `(taskId, claimKey)` unique index says a
     *    review for this coordinate already exists: a retried transition, a
     *    Task that left and re-entered `in_review` on the same commit, the
     *    loser of two API replicas handling one transition.
     *  - `budget-spent`    — every slot in `[0, maxRuns)` is held by another
     *    review of this Task.
     *
     * ## Why the budget lives HERE (Greptile P1-C on PR #2419)
     *
     * The budget used to be `countForTask` read by the planner BEFORE this
     * insert, and the only unique index was `(taskId, claimKey)`. Two
     * planners that interleaved at that count both saw one slot left and
     * inserted two DISTINCT claims — two reviewers, or two heads — and both
     * runs were dispatched; Greptile executed it with
     * `TASK_AGENT_REVIEW_MAX_RUNS=1`. The count is still read first, but
     * only as a cheap early exit; THIS is the bound.
     *
     * Every claim must take a slot number in `[0, maxRuns)`, and
     * `(taskId, slot)` is UNIQUE. The write is ONE autocommit INSERT (no
     * transaction, no lock, no engine-specific SQL), so it is atomic by the
     * same mechanism on both engines: Postgres's unique index makes the
     * second of two concurrent inserts of one slot wait for the first and
     * then fail with 23505; better-sqlite3 runs every statement serially on
     * its one connection and fails the second with SQLITE_CONSTRAINT_UNIQUE.
     * However the planners interleave, at most `maxRuns` rows can exist.
     *
     * A unique violation is disambiguated by re-reading the claim
     * coordinate: if that row now exists another caller won THIS review
     * (`already-claimed`); otherwise the slot was taken by a different
     * review and the next free slot is tried. The pre-reads (coordinate,
     * taken slots) only save doomed INSERTs; the constraints decide.
     *
     * `maxRuns` that is not a positive number claims nothing — fail closed.
     * Rows are never deleted, so a claim whose dispatch fails keeps its
     * slot: the budget is spent, deliberately.
     *
     * THROWS on any other store failure — a claim that cannot be written is
     * not a claim won.
     */
    async claim(input: ClaimAgentReviewInput): Promise<ClaimAgentReviewResult> {
        const claimKey = input.claimKey.slice(0, TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS);
        const maxRuns =
            typeof input.maxRuns === 'number' && Number.isFinite(input.maxRuns)
                ? Math.trunc(input.maxRuns)
                : 0;
        const existing = await this.repository.findOne({
            where: { taskId: input.taskId, claimKey },
        });
        if (existing) return { outcome: 'already-claimed' };
        if (maxRuns <= 0) return { outcome: 'budget-spent' };

        const taken = new Set(await this.listTakenSlotsForTask(input.taskId));
        for (let slot = 0; slot < maxRuns; slot += 1) {
            if (taken.has(slot)) continue;
            const entity = this.repository.create({
                taskId: input.taskId,
                reviewerAgentId: input.reviewerAgentId,
                approverId: input.approverId,
                claimKey,
                headSha: input.headSha,
                slot,
                prNumber: input.prNumber ?? null,
                ciState: input.ciState ?? null,
                state: 'dispatched',
                workId: input.workId ?? null,
                tenantId: input.tenantId ?? null,
                organizationId: input.organizationId ?? null,
            });
            let insertedId: unknown;
            try {
                // Queued on a single-connection driver, so this INSERT can
                // never land inside a verdict transaction and be rolled back
                // by it after this method reported the claim won.
                const inserted = await serializeOnSingleConnection(this.repository.manager, () =>
                    this.repository.insert(entity),
                );
                insertedId = inserted?.identifiers?.[0]?.id ?? entity.id;
            } catch (error) {
                if (!this.isUniqueViolation(error)) throw error;
                const winner = await this.repository.findOne({
                    where: { taskId: input.taskId, claimKey },
                });
                if (winner) return { outcome: 'already-claimed' };
                // Another review of this Task took this slot first.
                continue;
            }
            // The row IS inserted from here on, so this method must not
            // throw: a claim that exists but was reported as a failure is a
            // slot and a claim key nothing will ever dispatch or settle
            // (review of Greptile P1-C on PR #2419). The re-read is for the
            // caller's convenience (defaults the database filled in); when
            // it cannot be made, the inserted entity stands in for it, and
            // `bindRun` — a compare-and-set on this id — is still what proves
            // the row exists before any run is enqueued.
            let review: TaskAgentReview | null;
            try {
                review = await this.repository.findOne({
                    where: { taskId: input.taskId, claimKey },
                });
            } catch {
                review = typeof insertedId === 'string' ? { ...entity, id: insertedId } : null;
            }
            if (!review) {
                throw new Error(
                    `agent-review-claim-unreadable: review ${claimKey} on task ${input.taskId} vanished after its insert`,
                );
            }
            return { outcome: 'claimed', review };
        }
        return { outcome: 'budget-spent' };
    }

    /**
     * The review this Task's ledger holds for one claim coordinate
     * (reviewer, head), whatever its state, or `null`. THROWS on a read
     * failure.
     *
     * Used by the planner to put a verdict the ledger already holds for the
     * live head back onto its approver row — see
     * `TaskApproverRepository.restoreAgentDecisionFromReview`.
     */
    async findByClaimKey(taskId: string, claimKey: string): Promise<TaskAgentReview | null> {
        return this.repository.findOne({
            where: { taskId, claimKey: claimKey.slice(0, TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS) },
        });
    }

    /**
     * The budget slots this Task's reviews already hold. A pre-read for
     * {@link claim}, which the `(taskId, slot)` unique index overrules.
     */
    async listTakenSlotsForTask(taskId: string): Promise<number[]> {
        const rows = await this.repository.find({
            where: { taskId },
            select: ['id', 'slot'],
        });
        return rows.map((row) => Number(row.slot));
    }

    /**
     * Every claim key this Task's ledger holds, whatever the row's state.
     *
     * The cheap pre-check `planReviews` runs BEFORE any provider call: when
     * every eligible reviewer already holds a claim for the head the Task
     * last recorded, a re-entry into `in_review` (a flip-flop, a retried
     * transition) costs no pull-request read and no diff download. Bounded
     * by the lifetime budget, which caps rows per Task.
     */
    async listClaimKeysForTask(taskId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { taskId },
            select: ['id', 'claimKey'],
        });
        return rows.map((row) => row.claimKey);
    }

    /**
     * The OPEN review bound to this RUN, or `null`.
     *
     * THIS is the authorization the verdict path runs on. The run id comes
     * from platform state (the tool loop's own run context), never from a
     * model, and the binding was written by `bindRun` BEFORE the run was
     * handed to a job runtime. So a later run of the same agent — a chat
     * reply, a run on another Task, a run started after this review's own
     * run died — holds no binding and can record no verdict, and a model
     * cannot point a verdict at a Task other than the one this run was
     * dispatched to review.
     *
     * THROWS on a read failure — see the class doc.
     */
    async findOpenForRun(runId: string): Promise<TaskAgentReview | null> {
        return this.repository.findOne({ where: { runId, state: 'dispatched' } });
    }

    /**
     * Bind a freshly created run to its review — BEFORE the enqueue.
     *
     * Compare-and-set: only an OPEN row with no run yet (or already bound
     * to this very run, so a retry is idempotent) accepts the binding.
     * THROWS when it does not land, so the dispatch that called it rolls
     * the run back instead of starting a review run nothing is bound to.
     */
    async bindRun(id: string, runId: string): Promise<void> {
        const result = await serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.update({ id, state: 'dispatched', runId: IsNull() }, { runId }),
        );
        if ((result.affected ?? 0) > 0) return;
        // Idempotent retry: the same run binding the same open review again.
        const already = await this.repository.findOne({
            where: { id, state: 'dispatched', runId },
        });
        if (already) return;
        throw new Error(`agent-review-binding-refused: review ${id} is not open for run ${runId}`);
    }

    /**
     * The OPEN review this agent holds on this Task, newest first, or
     * `null`.
     *
     * Reporting only. It is NOT an authorization: an agent can hold an
     * open row whose run has already died, and any other run of that agent
     * would pass a (task, agent) check. The verdict path authorizes on
     * {@link findOpenForRun}.
     *
     * THROWS on a read failure — see the class doc.
     */
    async findOpenForReviewer(
        taskId: string,
        reviewerAgentId: string,
    ): Promise<TaskAgentReview | null> {
        return this.repository.findOne({
            where: { taskId, reviewerAgentId, state: 'dispatched' },
            order: { createdAt: 'DESC', id: 'DESC' },
        });
    }

    /**
     * Every run id this Task's reviews were bound to.
     *
     * CANDIDATES for exclusion from the Task's authorship evidence, not
     * the exclusion itself: `TaskAgentReviewService` leaves a run out only
     * when its own row ALSO proves it was admitted with the review-only
     * tool scope, i.e. when it provably could not author anything. Without
     * any exclusion a reviewer would disqualify ITSELF the moment it
     * started, and no second-round review could ever happen.
     */
    async listRunIdsForTask(taskId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { taskId },
            select: ['id', 'runId'],
        });
        return rows.map((row) => row.runId).filter((id): id is string => Boolean(id));
    }

    /**
     * Attach the dispatched run after the fact. Best-effort bookkeeping —
     * the AUTHORITATIVE binding is {@link bindRun}, written before the
     * enqueue.
     */
    async stampRunId(id: string, runId: string): Promise<void> {
        await serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.update({ id }, { runId }),
        );
    }

    /**
     * Write the ONE terminal state for a review that writes NO approver
     * row — a refusal (`refused`) or a dispatch that never happened
     * (`failed`).
     *
     * Compare-and-set from `dispatched`, so a second settlement of the same
     * review affects zero rows and is reported as such. A verdict that
     * writes the approver row does NOT come through here: it is
     * {@link recordVerdict}, which settles the review and writes the
     * approver in one transaction.
     */
    async casSettle(
        id: string,
        state: Exclude<TaskAgentReviewState, 'dispatched'>,
        patch: { refusalCode?: string | null; summary?: string | null } = {},
    ): Promise<boolean> {
        const result = await serializeOnSingleConnection(this.repository.manager, () =>
            this.repository.update(
                { id, state: 'dispatched' },
                {
                    state,
                    refusalCode: patch.refusalCode ?? null,
                    summary: patch.summary ?? null,
                    decidedAt: new Date(),
                },
            ),
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * Record a reviewer's verdict: settle the review AND write its approver
     * row, in ONE database transaction.
     *
     * ## Why one transaction (Greptile P1-B on PR #2419)
     *
     * The verdict path used to run `casSettle` (review → terminal) and THEN
     * `TaskApproverRepository.setState`, as two independent writes. If the
     * approver write threw, the review was already terminal, so no retry
     * could ever record the verdict; if it matched no row, its result was
     * ignored and the tool reported `recorded` while the approver stayed
     * `pending`.
     *
     * Now, inside `manager.transaction` (the repository's standard pattern
     * — `CreditLedgerRepository.recordAtomic`, `TaskTemplateRepository`):
     *
     *  1. CAS the review from `dispatched` to `input.state`. Zero rows → the
     *     review is not open → `review-not-open`, nothing written. This is
     *     still the one-verdict-per-review guard, so a double tool call
     *     writes the approver row exactly once.
     *  2. Read the approver row, keyed on its id, its Task, AND the agent it
     *     must still name (`approverType = 'agent'`,
     *     `approverId = reviewerAgentId`). Gone or re-typed since the caller
     *     read it → roll step 1 back → `approver-not-written`, the review
     *     still open.
     *  3. Refuse to let an OLDER verdict overwrite a NEWER one. When the row
     *     already carries an `agent-review` decision about ANOTHER head, and
     *     the ledger review that produced it was claimed after this one (a
     *     higher budget slot — slots are taken lowest-free-first and never
     *     freed, so slot order is claim order), roll step 1 back →
     *     `superseded`. Without this, a verdict for head A whose live-head
     *     check read a lagging provider replica overwrote the approval a
     *     later review had just recorded for head B, and the gate at B then
     *     refused a Task its reviewer had approved (review of Greptile P1-B on
     *     PR #2419). A decision this cannot attribute to a newer review — no
     *     ledger row, no provenance, a human's — is overwritten as before: the
     *     verdict being written has just passed its own live-head check, and
     *     the `→ done` gate binds every agent decision to the current head
     *     anyway.
     *  4. Write the decision, as a compare-and-set on exactly the state read
     *     in step 2. Anything but exactly one row affected (the row changed
     *     in between) rolls step 1 back → `approver-not-written`.
     *
     * Any other throw (any statement) also rolls everything back and
     * propagates; the caller reports an error and the review stays open.
     *
     * ## Engines
     *
     * Postgres: `BEGIN … COMMIT` on a pooled connection. Step 1's UPDATE
     * takes the review row's lock, so a concurrent second verdict for the
     * same review blocks on it and, once the first commits, re-evaluates
     * `state = 'dispatched'` against the committed row and affects zero rows
     * (if the first rolled back, the second proceeds as if alone). Exactly
     * one approver write either way. Step 4's compare-and-set covers a
     * concurrent writer of the approver row that step 2's plain read does not
     * lock out.
     *
     * better-sqlite3 — the DEFAULT `DATABASE_TYPE`, so every local and
     * self-hosted install without Postgres, plus CI and e2e: the same
     * `BEGIN … COMMIT / ROLLBACK`, but TypeORM runs every query of a
     * DataSource on ONE shared connection, and two `manager.transaction` calls
     * that overlap in time collide on it ("cannot start a transaction within a
     * transaction") — measured: a concurrent double tool call then failed BOTH
     * verdicts. So this method, and every other write the review stage makes
     * to the ledger and to agent approver rows (`claim`'s INSERT, `bindRun`,
     * `stampRunId`, `casSettle`, the approver reset / restore), is queued per
     * DataSource ({@link serializeOnSingleConnection}): none of them can land
     * inside this transaction, and the second verdict call starts after the
     * first committed or rolled back. Exactly one approver write, as on
     * Postgres.
     *
     * What no queue in this file can do is keep a statement from OUTSIDE the
     * review stage (another repository's transaction, a Task status write)
     * off that one connection while this transaction is open — a property of
     * every `manager.transaction` on that driver in this repository. Both
     * ways it can touch a verdict fail closed: a rollback here erases that
     * statement too (its own caller then sees state it did not expect), and
     * an overlapping transaction that later rolls back erases this verdict
     * after it reported `recorded` — which leaves the review `dispatched` and
     * the approver `pending`, i.e. the `→ done` gate SHUT until a human or a
     * new review decides.
     */
    async recordVerdict(input: RecordAgentVerdictInput): Promise<RecordAgentVerdictOutcome> {
        return serializeOnSingleConnection(this.repository.manager, () =>
            this.recordVerdictInTransaction(input),
        );
    }

    private async recordVerdictInTransaction(
        input: RecordAgentVerdictInput,
    ): Promise<RecordAgentVerdictOutcome> {
        try {
            return await this.repository.manager.transaction(async (manager) => {
                const reviews = manager.getRepository(TaskAgentReview);
                const approvers = manager.getRepository(TaskApprover);
                const settled = await reviews.update(
                    { id: input.reviewId, state: 'dispatched' },
                    {
                        state: input.state,
                        refusalCode: null,
                        summary: input.summary ?? null,
                        decidedAt: new Date(),
                    },
                );
                if ((settled.affected ?? 0) === 0) return 'review-not-open' as const;

                const approverKey = {
                    id: input.approver.id,
                    taskId: input.approver.taskId,
                    approverType: 'agent' as const,
                    approverId: input.approver.reviewerAgentId,
                };
                const current = await approvers.findOne({ where: approverKey });
                if (!current) throw new ApproverNotWrittenRollback();
                if (await this.isSupersededInTransaction(reviews, input, current)) {
                    throw new SupersededVerdictRollback();
                }

                const written = await approvers.update(
                    {
                        ...approverKey,
                        approvalState: current.approvalState,
                        decidedVia: current.decidedVia ?? IsNull(),
                        decidedHeadSha: current.decidedHeadSha ?? IsNull(),
                    },
                    {
                        approvalState: input.approver.approvalState,
                        approvedAt: new Date(),
                        // The provenance that keeps this distinguishable
                        // forever. `agent-review` has no meaning in the
                        // merge-approval line.
                        decidedVia: 'agent-review',
                        decidedByRunId: input.approver.decidedByRunId,
                        decidedHeadSha: input.approver.decidedHeadSha,
                    },
                );
                // `affected` unreported counts as zero: an approver write
                // nobody can confirm is not a recorded verdict.
                if ((written.affected ?? 0) !== 1) throw new ApproverNotWrittenRollback();
                return 'recorded' as const;
            });
        } catch (error) {
            if (error instanceof ApproverNotWrittenRollback) return 'approver-not-written';
            if (error instanceof SupersededVerdictRollback) return 'superseded';
            throw error;
        }
    }

    /**
     * Step 3 of {@link recordVerdict}: does the approver row already carry
     * a verdict from a review claimed AFTER the one being recorded?
     */
    private async isSupersededInTransaction(
        reviews: Repository<TaskAgentReview>,
        input: RecordAgentVerdictInput,
        current: TaskApprover,
    ): Promise<boolean> {
        if (current.approvalState === 'pending' || current.decidedVia !== 'agent-review') {
            return false;
        }
        const priorHead = (current.decidedHeadSha ?? '').trim();
        if (!priorHead || priorHead === input.approver.decidedHeadSha) return false;
        const mine = await reviews.findOne({ where: { id: input.reviewId } });
        const prior = await reviews.findOne({
            where: {
                taskId: input.approver.taskId,
                claimKey: agentReviewClaimKey(input.approver.reviewerAgentId, priorHead).slice(
                    0,
                    TASK_AGENT_REVIEW_CLAIM_KEY_MAX_CHARS,
                ),
            },
        });
        if (!mine || !prior) return false;
        return Number(prior.slot) > Number(mine.slot);
    }

    /** Reviews for one Task, oldest first. Reporting and tests. */
    async listForTask(taskId: string): Promise<TaskAgentReview[]> {
        return this.repository.find({
            where: { taskId },
            order: { createdAt: 'ASC', id: 'ASC' },
        });
    }

    private isUniqueViolation(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const driverCode = (error as { driverError?: { code?: string } }).driverError?.code;
        const topCode = (error as { code?: string }).code;
        // Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite SQLITE_CONSTRAINT*.
        // The sqlite arm is a PREFIX match: better-sqlite3 reports the
        // EXTENDED result code (`SQLITE_CONSTRAINT_UNIQUE`), so an exact
        // comparison misses a real unique hit and `claim()` throws instead
        // of losing the race gracefully. Same reasoning as
        // `TaskCiAutoResumeAttemptRepository.isUniqueViolation`.
        const codes = ['23505', 'ER_DUP_ENTRY'];
        for (const code of [driverCode, topCode]) {
            if (typeof code !== 'string') continue;
            if (codes.includes(code) || code.startsWith('SQLITE_CONSTRAINT')) return true;
        }
        return false;
    }
}
