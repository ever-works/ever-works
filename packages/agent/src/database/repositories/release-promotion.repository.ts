import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import {
    PROMOTION_LANE_OPEN,
    RELEASE_VERIFY_STATES,
    isReleaseVerifyTerminal,
    promotionLaneKey,
    type PromotionGateVerdict,
    type PromotionRung,
    type PromotionState,
    type ReleaseVerifyState,
} from '@ever-works/contracts';
import { ReleasePromotion } from '../../entities/release-promotion.entity';

/** What a lane claim resolved to. */
export interface PromotionLaneClaim {
    /** True when THIS caller created the row. */
    claimed: boolean;
    /** The live promotion for the lane — this caller's, or the winner's. */
    promotion: ReleasePromotion;
}

export interface ClaimPromotionLaneInput {
    userId: string;
    workId: string;
    rung: PromotionRung;
    headBranch: string;
    baseBranch: string;
    gateWorkflow: string;
    tenantId?: string | null;
    organizationId?: string | null;
}

/**
 * How long an OPEN promotion may hold its lane with NO pull request
 * bound to it before the next claimant treats it as abandoned.
 *
 * The lane is claimed BEFORE the provider is touched — deliberately, so a
 * race loses in the database rather than on GitHub — which leaves a
 * window spanning one `createPullRequest` round trip. A process that dies
 * inside that window (deploy, OOM, node crash) used to leave the row
 * `open` with `prNumber` NULL forever: nothing sweeps it (the PR-status
 * sweep selects on `prNumber IS NOT NULL`), there is no abandon endpoint,
 * and the UNIQUE index then works against the operator — every later
 * promotion for that rung is refused `already-open` until somebody edits
 * the database.
 *
 * Ten minutes is far longer than opening a pull request can legitimately
 * take and far shorter than a human's patience. Reclaiming is safe rather
 * than duplicating because `openPromotion` ADOPTS an already-open
 * head → base pull request instead of asking for a second one.
 */
export const PROMOTION_LANE_ABANDON_MS = 10 * 60 * 1000;

/**
 * Release promotion lane (self-build slice AI, EW-808) — the store for
 * `release_promotions`.
 *
 * DELIBERATELY NOT in `_repository-inventory.ts`. That file is the
 * DatabaseModule-owned set; this repository belongs to the promotion lane
 * and is listed in `ReleasePromotionModule`'s own providers, the same way
 * `MergeApprovalModule` lists `TaskRepository`. Adding it to the inventory
 * would export it to every module in the platform for the benefit of one.
 */
@Injectable()
export class ReleasePromotionRepository {
    constructor(
        @InjectRepository(ReleasePromotion)
        private readonly repository: Repository<ReleasePromotion>,
    ) {}

    /**
     * Take the `(workId, rung)` lane, or report who already has it.
     *
     * THE anti-duplicate guarantee, and the reason it is an INSERT rather
     * than a read-then-write: two merges to `develop` seconds apart, or a
     * cron worker racing an operator's retry, both see "no open promotion"
     * if you look first. Only the UNIQUE `(workId, rung, laneKey)` index
     * can decide, so the insert IS the decision and the loser reads the
     * winner back.
     *
     * Modelled on `MergeApprovalService.requestMergeApproval`, including
     * the pre-read: skipping it would make the ordinary "already open"
     * case log a constraint violation on every sweep.
     */
    async claimLane(input: ClaimPromotionLaneInput): Promise<PromotionLaneClaim> {
        const existing = await this.findOpenForLane(input.workId, input.rung);
        if (existing) {
            // An open row that never got a pull request bound to it, older
            // than the abandon window, is wreckage from a process that died
            // between the claim and `recordPullRequest` — see
            // {@link PROMOTION_LANE_ABANDON_MS}. Nothing else can ever free
            // it: the PR-status sweep only looks at Tasks that HAVE a pull
            // request. Retire it and let this caller through.
            if (!isAbandonedLane(existing)) return { claimed: false, promotion: existing };
            await this.closeLane(existing.id, 'refused', 'abandoned-before-pull-request');
        }

        try {
            const created = await this.repository.save(
                this.repository.create({
                    userId: input.userId,
                    workId: input.workId,
                    rung: input.rung,
                    headBranch: input.headBranch,
                    baseBranch: input.baseBranch,
                    gateWorkflow: input.gateWorkflow,
                    state: 'open',
                    laneKey: PROMOTION_LANE_OPEN,
                    tenantId: input.tenantId ?? null,
                    organizationId: input.organizationId ?? null,
                }),
            );
            return { claimed: true, promotion: created };
        } catch {
            // Lost the race (or a genuine write failure). Re-read: a
            // winner means "already open", and no winner means the write
            // really failed and the caller must not proceed.
            const winner = await this.findOpenForLane(input.workId, input.rung);
            if (!winner) throw new Error('Could not claim the promotion lane.');
            return { claimed: false, promotion: winner };
        }
    }

    /** The live promotion for one lane, if there is one. */
    async findOpenForLane(workId: string, rung: PromotionRung): Promise<ReleasePromotion | null> {
        return this.repository.findOne({
            where: { workId, rung, laneKey: PROMOTION_LANE_OPEN },
        });
    }

    /**
     * The promotion a Task reports, if it reports one.
     *
     * One Task files one promotion, so in practice this is a single row.
     * The OPEN row is asked for FIRST anyway, deliberately: this is the
     * lookup the merge guard runs, and "there is a live promotion for this
     * Task" must never lose a sort to a terminal one. Ordering the two
     * together by `laneKey` would do exactly that — `'closed:…'` and
     * `'merged:…'` both sort before `'open'`.
     *
     * `null` is a normal outcome; most Tasks are not promotions.
     */
    async findByTaskId(taskId: string): Promise<ReleasePromotion | null> {
        const open = await this.repository.findOne({
            where: { taskId, laneKey: PROMOTION_LANE_OPEN },
        });
        if (open) return open;
        return this.repository.findOne({ where: { taskId }, order: { createdAt: 'DESC' } });
    }

    /**
     * The LIVE promotion a Task reports, if it has one.
     *
     * THE identity lookup for both halves of the lane, and one query
     * rather than {@link findByTaskId}'s two, because it runs for every
     * Task on every PR-status sweep and for every green pull request the
     * merge gate considers. It is asked BEFORE anything looks at a Task's
     * labels: labels are free-form and any owner can rewrite them through
     * `PATCH /api/tasks/:id`, so a lane whose identity came from them
     * could be disarmed by one request while the promotion row still said
     * `open`. Hits `idx_release_promotions_task`.
     */
    async findOpenByTaskId(taskId: string): Promise<ReleasePromotion | null> {
        return this.repository.findOne({ where: { taskId, laneKey: PROMOTION_LANE_OPEN } });
    }

    async findById(id: string): Promise<ReleasePromotion | null> {
        return this.repository.findOne({ where: { id } });
    }

    /** Owner-scoped history for one Work, newest first. */
    async listForWork(workId: string, userId: string, limit = 20): Promise<ReleasePromotion[]> {
        return this.repository.find({
            where: { workId, userId },
            order: { createdAt: 'DESC' },
            take: Math.max(1, Math.min(limit, 100)),
        });
    }

    /** Bind the reporting Task to the claimed lane. */
    async attachTask(id: string, taskId: string): Promise<void> {
        await this.repository.update({ id }, { taskId });
    }

    /** Record the opened pull request and the head it was opened at. */
    async recordPullRequest(
        id: string,
        patch: {
            prNumber: number;
            prUrl: string | null;
            headSha: string | null;
            headRecordedAt: Date;
        },
    ): Promise<void> {
        await this.repository.update(
            { id },
            {
                prNumber: patch.prNumber,
                prUrl: patch.prUrl,
                headSha: patch.headSha,
                headRecordedAt: patch.headRecordedAt,
            },
        );
    }

    /**
     * Adopt a NEW head commit for a live promotion.
     *
     * Clears the gate verdict in the same write: a verdict is about a
     * commit, and this one has not been judged. Leaving it would let a
     * `success` recorded for an old commit authorise a merge of a new one.
     */
    async recordHeadMoved(id: string, headSha: string, at: Date): Promise<void> {
        await this.repository.update(
            { id },
            {
                headSha,
                headRecordedAt: at,
                gateVerdict: null,
                gateVerdictSha: null,
                gateRunUrl: null,
                // The waiver went with the verdict: a label applied to an
                // older commit's run says nothing about this one.
                gateOverridden: false,
            },
        );
    }

    /**
     * Record one reading of the gate, stamped with the commit it was
     * about, and report whether it CHANGED anything.
     *
     * A compare-and-set rather than a read-then-write, for the same reason
     * {@link claimInboxNotice} is one: the two-minute PR-status sweep and
     * an on-demand `?refresh=true` run in different processes, so two
     * callers holding the same stale in-memory row would both compute
     * "this is new" and both narrate it into the Task thread. `changed`
     * comes from the database's own answer to "did this row actually
     * differ?", so exactly one caller narrates a given transition.
     *
     * `gateCheckedAt` is written either way — the operator surface shows
     * when the gate was last LOOKED at, which is a different fact from
     * when it last changed.
     */
    async recordGateVerdict(
        id: string,
        patch: {
            gateVerdict: PromotionGateVerdict;
            gateVerdictSha: string;
            gateCheckedAt: Date;
            gateRunUrl?: string | null;
            /**
             * Was the gate's E2E leg waived by the `override-e2e-gate`
             * label rather than green? Part of the compare-and-set, not a
             * side note: a label applied to a live pull request re-runs the
             * gate and flips a red run to `success`, and the human has to
             * be told that transition happened.
             */
            gateOverridden: boolean;
        },
    ): Promise<{ changed: boolean }> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                gateVerdict: patch.gateVerdict,
                gateVerdictSha: patch.gateVerdictSha,
                gateCheckedAt: patch.gateCheckedAt,
                gateRunUrl: patch.gateRunUrl ?? null,
                gateOverridden: patch.gateOverridden,
            })
            .where('id = :id', { id })
            .andWhere(
                '(gateVerdict IS NULL OR gateVerdict != :verdict OR gateVerdictSha IS NULL OR gateVerdictSha != :sha OR gateOverridden IS NULL OR gateOverridden != :overridden)',
                {
                    verdict: patch.gateVerdict,
                    sha: patch.gateVerdictSha,
                    overridden: patch.gateOverridden,
                },
            )
            .execute();
        if ((result.affected ?? 0) > 0) return { changed: true };

        // Unchanged reading: keep the "last looked at" stamp honest and
        // say nothing.
        await this.repository.update(
            { id },
            { gateCheckedAt: patch.gateCheckedAt, gateRunUrl: patch.gateRunUrl ?? null },
        );
        return { changed: false };
    }

    /**
     * Take a promotion terminal and FREE its lane, so the next one can be
     * opened by a human when they decide to.
     *
     * `laneKey` is computed by the shared helper rather than written here,
     * so the value the unique index sees can never drift from the value
     * the claim path expects.
     */
    async closeLane(
        id: string,
        state: Exclude<PromotionState, 'open'>,
        refusalCode?: string | null,
    ): Promise<void> {
        await this.repository.update(
            { id },
            {
                state,
                laneKey: promotionLaneKey(state, id),
                ...(refusalCode === undefined ? {} : { refusalCode }),
            },
        );
    }

    /**
     * Claim the right to file the ONE Inbox notice for this (head commit,
     * reading) pair.
     *
     * Compare-and-set, not a read-then-write: the two-minute PR-status
     * sweep and an on-demand `?refresh=true` run in different processes
     * and would otherwise both file one. `true` means this caller won and
     * must file; `false` means somebody already filed THIS reading for
     * THIS commit.
     *
     * The `token` half is load-bearing and was missing. Keyed on the
     * commit alone, the first reading to clear the grace window took the
     * slot — and `pending` past twenty minutes is routine on this gate,
     * because `node-contract` has a 20-minute budget plus self-hosted ARC
     * queue time, and a single transient 403/5xx (recorded `unreadable`)
     * does the same. The verdict that actually decided the promotion,
     * including a FAILURE, was then never filed at all. Callers pass
     * `'stuck'` for every undecided reading, so a `pending → unreadable →
     * pending` flap is still ONE notice, and `success` / `failure` /
     * `cancelled` / `skipped` each get theirs.
     */
    async claimInboxNotice(id: string, headSha: string, token: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({ inboxFiledForSha: headSha, inboxFiledVerdict: token })
            .where('id = :id', { id })
            .andWhere(
                '(inboxFiledForSha IS NULL OR inboxFiledForSha != :headSha OR inboxFiledVerdict IS NULL OR inboxFiledVerdict != :token)',
                { headSha, token },
            )
            .execute();
        return (result.affected ?? 0) > 0;
    }

    // ── Post-deploy verification (slice AJ, EW-809) ───────────────────
    //
    // Every write below is a CONDITIONAL update whose WHERE clause
    // restates the precondition, the same posture `FleetJobService` uses
    // for the lease protocol and `recordGateVerdict` uses for the gate.
    // Two API replicas run this sweep and this listener, and the row is
    // the only thing that can arbitrate between them.

    /**
     * Start a verification, but only for a promotion that has never had
     * one.
     *
     * `WHERE verifyState IS NULL` is what makes "exactly once per
     * promotion" a database fact rather than an argument about call sites.
     * The merge-detection block that calls this frees the lane in the same
     * pass, so in practice it runs once anyway — but "in practice" is how
     * two Inbox notices for one event get shipped.
     */
    async beginVerification(
        id: string,
        patch: {
            verifyState: ReleaseVerifyState;
            verifyExpectedSha: string | null;
            verifyTargetUrl: string | null;
            verifyStartedAt: Date;
            verifyDeadlineAt: Date | null;
            verifyRetryAt: Date | null;
            verifyDetail: string | null;
        },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyState: patch.verifyState,
                verifyExpectedSha: patch.verifyExpectedSha,
                verifyTargetUrl: patch.verifyTargetUrl,
                verifyStartedAt: patch.verifyStartedAt,
                verifyDeadlineAt: patch.verifyDeadlineAt,
                verifyRetryAt: patch.verifyRetryAt,
                verifyDetail: patch.verifyDetail,
                verifyAttempts: 0,
                verifyStreak: 0,
                verifyJobId: null,
            })
            .where('id = :id', { id })
            .andWhere('verifyState IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Rows the verification sweep should look at: still being verified,
     * and due.
     *
     * Deliberately NOT filtered on `verifyJobId IS NULL`. A row whose
     * browser check never comes back must still be able to reach its
     * deadline and settle, or one wedged fleet job would hold a promotion
     * in `awaiting-rollout` for ever — exactly the unbounded state this
     * lane is not allowed to have. The sweep decides per row whether it is
     * claiming an attempt or expiring the row.
     */
    async findVerificationsDue(now: Date, limit = 25): Promise<ReleasePromotion[]> {
        return this.repository.find({
            where: {
                // DERIVED, not restated. A verification state added later is
                // live unless `isReleaseVerifyTerminal` says otherwise, so a
                // new state cannot be introduced into a lane the sweep
                // silently never visits — which would be a promotion stuck
                // for ever with nothing to notice it.
                verifyState: In(LIVE_VERIFY_STATES),
                verifyRetryAt: LessThanOrEqual(now),
            },
            order: { verifyRetryAt: 'ASC' },
            take: Math.max(1, Math.min(limit, 100)),
        });
    }

    /** The promotion a browser check belongs to, so a completion can be routed back. */
    async findByVerifyJobId(jobId: string): Promise<ReleasePromotion | null> {
        return this.repository.findOne({ where: { verifyJobId: jobId } });
    }

    /**
     * Take ownership of the next probe.
     *
     * The caller enqueues FIRST (with a key deterministic in
     * `(promotion, attempt)`) and claims second. Both orderings leak
     * something; this one leaks the harmless thing. A crash between the
     * two leaves an enqueued job nobody recorded, and the next sweep
     * computes the SAME attempt number, re-enqueues the SAME key, is
     * handed the SAME job row back by `FleetJobService`, and records it.
     * Claiming first and enqueuing second would instead leave a row
     * pointing at a job that does not exist, which nothing can complete.
     *
     * `WHERE verifyJobId IS NULL AND verifyState = :state` is the mutual
     * exclusion: at most one browser is ever pointed at one environment
     * for one promotion.
     *
     * `reconsiderAt` is when the sweep should LOOK at this row again — not
     * when it may enqueue again, which is gated on the job coming back. See
     * the note on `verifyRetryAt` below.
     */
    async claimVerifyAttempt(
        id: string,
        state: ReleaseVerifyState,
        patch: { jobId: string; attempts: number; targetUrl: string; reconsiderAt: Date },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyJobId: patch.jobId,
                verifyAttempts: patch.attempts,
                verifyTargetUrl: patch.targetUrl,
                // NOT null, and this is load-bearing. `verifyRetryAt` is the
                // sweep's WHERE clause, so a row that nulled it while a
                // check was out would become invisible to the only thing
                // that can enforce the deadline — and a browser job that
                // never came back would hold the promotion open for ever,
                // which is precisely the unbounded state this lane is not
                // allowed to have. Instead the row stays sweepable: the
                // sweep re-reads it, sees `verifyJobId` set, and declines to
                // enqueue a second check while still being able to expire
                // the row. (The fleet settles a stuck job on its own — a
                // lease it exhausts or a queue SLA it expires both emit a
                // completion — but "the other subsystem will notice" is not
                // a bound, it is a hope.)
                verifyRetryAt: patch.reconsiderAt,
            })
            .where('id = :id', { id })
            .andWhere('verifyState = :state', { state })
            .andWhere('verifyJobId IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Burn an attempt WITHOUT binding a job to it.
     *
     * Added during the slice-AJ review, for the one case
     * {@link claimVerifyAttempt}'s recovery argument does not cover:
     * `FleetJobService.enqueue` short-circuits on the idempotency key with
     * a bare `findOne({ where: { idempotencyKey } })` that has no status
     * filter and no owner scope, so re-deriving the same key can hand back
     * a job that has ALREADY SETTLED (its completion fired while nothing
     * was bound to it, and no second one will ever arrive) or a job
     * somebody else created under that key. Binding either would wedge the
     * verification until its deadline for a reason nobody recorded.
     *
     * Advancing `verifyAttempts` is what breaks the loop: the next sweep
     * derives attempt N+1, therefore a DIFFERENT idempotency key,
     * therefore a genuinely new job. The attempt cap still bounds it.
     *
     * `WHERE verifyJobId IS NULL AND verifyState = :state` for the same
     * reason the claim has it: this must never overwrite a live claim.
     */
    async burnVerifyAttempt(
        id: string,
        state: ReleaseVerifyState,
        patch: { attempts: number; reconsiderAt: Date; detail: string | null },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyAttempts: patch.attempts,
                verifyRetryAt: patch.reconsiderAt,
                verifyDetail: patch.detail,
            })
            .where('id = :id', { id })
            .andWhere('verifyState = :state', { state })
            .andWhere('verifyJobId IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Push a row with a check STILL IN FLIGHT further down the sweep queue.
     *
     * Added during the slice-AJ review. {@link findVerificationsDue} pages
     * a platform-wide 25 rows ordered `verifyRetryAt ASC` and deliberately
     * keeps in-flight rows in the result set so their deadline can still be
     * enforced — but the sweep used to skip such a row without rescheduling
     * it, so once a check had been out for longer than one interval the row
     * was permanently `verifyRetryAt <= now` and drifted further into the
     * past on every pass. Twenty-five of those — one owner whose fleet has
     * no browser-capable node is enough — filled the page for ever and no
     * other tenant's verification was enqueued or expired again.
     *
     * Pinned to the job it is waiting on, so this cannot silently reschedule
     * a row whose check came back in the meantime.
     */
    async deferVerification(
        id: string,
        state: ReleaseVerifyState,
        jobId: string,
        reconsiderAt: Date,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({ verifyRetryAt: reconsiderAt })
            .where('id = :id', { id })
            .andWhere('verifyState = :state', { state })
            .andWhere('verifyJobId = :jobId', { jobId })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Let go of a job binding without settling the row.
     *
     * Added during the slice-AJ review for the wedge case: the row points
     * at a fleet job that has reached a terminal state but whose result
     * could not be recorded (the in-process listener's transient failure,
     * or an API replica that restarted between the fleet write and the
     * handler). Nothing would ever complete that job again, and the sweep
     * declines to enqueue while `verifyJobId` is set, so the promotion
     * burned its whole eight-hour budget having checked nothing.
     *
     * Releases the binding and burns the attempt in ONE write, so the next
     * sweep enqueues a fresh check under a fresh idempotency key.
     */
    async releaseVerifyJob(
        id: string,
        state: ReleaseVerifyState,
        jobId: string,
        patch: { attempts: number; reconsiderAt: Date; detail: string | null },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyJobId: null,
                verifyAttempts: patch.attempts,
                verifyRetryAt: patch.reconsiderAt,
                verifyDetail: patch.detail,
            })
            .where('id = :id', { id })
            .andWhere('verifyState = :state', { state })
            .andWhere('verifyJobId = :jobId', { jobId })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Record one probe result and schedule (or not) the following one.
     *
     * Pinned to the job that produced it, so a late completion from a
     * superseded job cannot advance a row that has already moved on. The
     * state is pinned too: a result read against `checking-app` cannot
     * land on a row that has since become `confirming-failure`.
     */
    async recordVerifyResult(
        id: string,
        from: { jobId: string; state: ReleaseVerifyState },
        patch: {
            verifyState: ReleaseVerifyState;
            verifyStreak: number;
            verifyCheckedAt: Date;
            verifyRetryAt: Date | null;
            verifyDetail: string | null;
        },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyState: patch.verifyState,
                verifyStreak: patch.verifyStreak,
                verifyCheckedAt: patch.verifyCheckedAt,
                verifyRetryAt: patch.verifyRetryAt,
                verifyDetail: patch.verifyDetail,
                verifyJobId: null,
            })
            .where('id = :id', { id })
            .andWhere('verifyJobId = :jobId', { jobId: from.jobId })
            .andWhere('verifyState = :state', { state: from.state })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Settle a verification, from a state it is still in.
     *
     * The `from` pin is what makes "exactly one process narrates this
     * verdict" true, and therefore what makes "exactly one Inbox notice"
     * true: the caller files the notice only when this returned `true`.
     * Clears `verifyRetryAt` and `verifyJobId` in the same write, so a
     * settled row is invisible to the sweep and deaf to a late completion.
     */
    async settleVerification(
        id: string,
        from: ReleaseVerifyState,
        patch: {
            verifyState: ReleaseVerifyState;
            verifyCheckedAt: Date;
            verifyDetail: string | null;
        },
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({
                verifyState: patch.verifyState,
                verifyCheckedAt: patch.verifyCheckedAt,
                verifyDetail: patch.verifyDetail,
                verifyRetryAt: null,
                verifyJobId: null,
                verifyStreak: 0,
            })
            .where('id = :id', { id })
            .andWhere('verifyState = :from', { from })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Claim the right to file the ONE revert offer for this promotion.
     *
     * `WHERE revertTaskId IS NULL AND verifyState = 'failed'` carries two
     * separate guarantees, both load-bearing:
     *
     *   - a promotion is offered a revert AT MOST ONCE, ever, however many
     *     replicas notice the failure;
     *   - a revert can only be offered for a verification that actually
     *     reached `failed`. An `inconclusive` or `unsupported` promotion
     *     cannot be handed a revert offer even by a caller that asks for
     *     one, because the database refuses the write. That is the last
     *     line of the "an inconclusive verdict does not trigger a revert"
     *     rule, underneath the service check and the contracts predicate.
     */
    async claimRevertOffer(id: string, taskId: string, at: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(ReleasePromotion)
            .set({ revertTaskId: taskId, revertOfferedAt: at })
            .where('id = :id', { id })
            .andWhere('revertTaskId IS NULL')
            .andWhere('verifyState = :failed', { failed: 'failed' })
            .execute();
        return (result.affected ?? 0) > 0;
    }
}

/**
 * The verification states the sweep must keep looking at.
 *
 * Computed from the contract rather than typed out, so the sweep's query
 * and `isReleaseVerifyTerminal` cannot disagree about what "finished"
 * means.
 */
const LIVE_VERIFY_STATES = RELEASE_VERIFY_STATES.filter((state) => !isReleaseVerifyTerminal(state));

/**
 * An open lane nobody can ever free: no pull request bound, and older
 * than {@link PROMOTION_LANE_ABANDON_MS}.
 *
 * Reads `createdAt` rather than `updatedAt`: nothing touches such a row
 * after the claim, so the two are the same value — and `createdAt` cannot
 * be pushed forward by an unrelated write.
 */
function isAbandonedLane(promotion: ReleasePromotion): boolean {
    if (promotion.prNumber !== null && promotion.prNumber !== undefined) return false;
    const created = promotion.createdAt ? new Date(promotion.createdAt).getTime() : Number.NaN;
    // No usable creation time is NOT a licence to retire the row: an
    // unreadable clock must not become a way to steal a live lane.
    if (Number.isNaN(created)) return false;
    return Date.now() - created >= PROMOTION_LANE_ABANDON_MS;
}
