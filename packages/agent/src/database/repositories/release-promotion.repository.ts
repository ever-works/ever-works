import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    PROMOTION_LANE_OPEN,
    promotionLaneKey,
    type PromotionGateVerdict,
    type PromotionRung,
    type PromotionState,
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
}

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
