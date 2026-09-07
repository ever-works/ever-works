import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_BROWSER_CAPABILITY,
    RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
    RELEASE_VERIFY_BUDGET_MS,
    RELEASE_VERIFY_FAILURE_CONFIRMATIONS,
    RELEASE_VERIFY_PROBE_TIMEOUT_SEC,
    RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS,
    isFleetJobTerminal,
    isReleaseVerifyCheckPass,
    isReleaseVerifyExhausted,
    isReleaseVerifyRevertOffered,
    isReleaseVerifyTerminal,
    normalizeCommitSha,
    releaseEnvironmentForRung,
    releaseRevertTaskLabels,
    releaseVerificationProbe,
    releaseVerifyAppProof,
    releaseVerifyIdempotencyKey,
    resolveReleaseVerificationTarget,
    type FleetBrowserCheckPayload,
    type ReleaseVerificationProbe,
    type ReleaseVerifyAppProof,
    type ReleaseVerifyState,
} from '@ever-works/contracts';
import { Task, TaskPriority, TaskStatus } from '../entities/task.entity';
import type { Work } from '../entities/work.entity';
import type { ReleasePromotion } from '../entities/release-promotion.entity';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { ReleasePromotionRepository } from '../database/repositories/release-promotion.repository';
import { TaskChatMessageRepository } from '../database/repositories/task-side.repositories';
import { FleetJobService } from '../fleet/fleet-job.service';
import { FleetJobRepository } from '../fleet/fleet-job.repository';
import type { FleetJob } from '../entities/fleet-job.entity';
import { GitFacadeService, type GitFacadeOptions } from '../facades/git.facade';
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import { TasksService } from './tasks.service';

/** Longest note kept on the row. Half of what lands here is node-reported. */
const DETAIL_MAX = 512;

/** What one sweep pass did, for the cron log and for tests. */
export interface VerificationSweepSummary {
    considered: number;
    enqueued: number;
    settled: number;
    /**
     * Rows whose in-flight check had already reached a terminal fleet
     * state without its result being recorded, and which this pass read
     * back off the job row itself (slice-AJ review). Non-zero here means
     * a completion was dropped somewhere, which is worth seeing in a log.
     */
    recovered: number;
}

/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809) — the
 * half of the release lane that finds out whether the release WORKED, and
 * offers a human the undo when it did not.
 *
 * ## Why this exists
 *
 * Slice AI opens the promotion pull request, reads `promotion-gate.yml`
 * and stands aside for a human to merge. After that merge the platform
 * knew nothing. `browser-check` had existed as a fleet job kind since the
 * node shipped, with a working executor and a capability tag, and NOTHING
 * ON THE PLATFORM EVER PRODUCED ONE — searching `apps/api/src` and
 * `packages/agent/src` for the string found only type declarations and two
 * negative-control test fixtures. So on 2026-09-06 a whole batch went
 * `develop → stage → main` and nothing confirmed the result, on a build
 * lane measured at 215–243 minutes.
 *
 * ## The three things it does, and the one it refuses to
 *
 *   1. **Enqueues a browser check against the deployed URL** once a
 *      promotion is observed merged — at the environment that rung's BASE
 *      branch deploys, from platform state, never from a request.
 *   2. **Reads the verdict** onto the promotion row and into the owner's
 *      Inbox.
 *   3. **Offers a revert** — an inert Task carrying the exact coordinates
 *      — when, and only when, the deployment is confirmed broken.
 *
 * It does not revert. There is no code path in this file that merges,
 * pushes, force-pushes, deploys, rolls back, or asks anything else to. The
 * offer is a Task filed IN_REVIEW for a person to read; landing whatever
 * pull request that Task eventually produces needs the same
 * `merge_pull_request` Inbox approval, verified against the live head at
 * merge time, as every other agent merge (slice AE). Undoing a promotion
 * is the same class of act as making one, and slice AI's argument — the
 * founder performs each rung deliberately — applies at least as strongly
 * in reverse.
 *
 * ## What makes a green verdict mean something
 *
 * The first probe is not a health check. It loads the environment's
 * VERSION endpoint in a real browser and requires the promoted commit to
 * appear in the rendered document. Until that has held
 * `RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS` times in a row, this lane says
 * nothing at all about the deployment — because the deploy has not
 * happened yet and every check before it is testing the OLD build. A plain
 * `200 OK` would report green for a rollout that never started, which is
 * the exact "check that passes when nothing was checked" this slice was
 * written to prevent. See `ReleasePromotion.verifyExpectedSha` for the one
 * thing this identity argument does NOT prove.
 *
 * ## Why it cannot loop
 *
 * A probe is enqueued only by the sweep, only for a row in a live state,
 * only when no check is already in flight, and only while BOTH bounds hold
 * (`RELEASE_VERIFY_MAX_ATTEMPTS` and the eight-hour deadline). A failed
 * check never re-enqueues itself: it writes a result and a `verifyRetryAt`
 * and the sweep decides. Every terminal state clears `verifyRetryAt`, so a
 * settled promotion is invisible to the sweep for ever. And the revert
 * offer is an ordinary Task with no promotion label, so it cannot open a
 * promotion, so it cannot cause another verification.
 *
 * BEST-EFFORT BY CONTRACT throughout, like the promotion refresh beside
 * it: the callers are a merge observation and a cron sweep, and neither
 * may be turned into a failure by a provider hiccup.
 */
@Injectable()
export class ReleaseVerificationService {
    private readonly logger = new Logger(ReleaseVerificationService.name);

    constructor(
        private readonly promotions: ReleasePromotionRepository,
        private readonly works: WorkRepository,
        private readonly tasks: TaskRepository,
        private readonly tasksService: TasksService,
        private readonly chat: TaskChatMessageRepository,
        // Everything below is @Optional() and APPENDED LAST per the
        // positional-spec arity rule. Any future dependency goes after
        // these, also @Optional(). This convention has bitten six times.
        @Optional() private readonly fleet?: FleetJobService,
        @Optional() private readonly gitFacade?: GitFacadeService,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
        // Added by the slice-AJ review, and appended after the three
        // above for the same arity reason. Read-only: this reads the fleet
        // job row back to check that the job `enqueue` handed us is the one
        // this lane meant to create, and to un-wedge a row whose check
        // settled without its result reaching the state machine. It never
        // writes to the fleet.
        @Optional() private readonly fleetJobs?: FleetJobRepository,
    ) {}

    // ── Starting a verification ───────────────────────────────────────

    /**
     * Called by `ReleasePromotionService` the once, when a promotion pull
     * request is observed merged.
     *
     * Never throws: the caller is a PR-status refresh whose job is to keep
     * a cache honest for every Task behind this one, and a verification
     * that threw would turn a provider hiccup into a failed sweep.
     */
    async onPromotionMerged(promotion: ReleasePromotion, task: Task | null): Promise<void> {
        try {
            await this.begin(promotion, task);
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not start post-deploy verification: ${describe(error)}`,
            );
        }
    }

    private async begin(promotion: ReleasePromotion, task: Task | null): Promise<void> {
        // Already started (or already finished). The compare-and-set below
        // is the real guard; this saves the provider round trip.
        if (promotion.verifyState) return;

        const environment = releaseEnvironmentForRung(promotion.rung);
        const work = await this.works.findById(promotion.workId);

        // Every refusal below lands as a TERMINAL state with a reason, not
        // as silence. "Nobody configured a URL" and "the deployment is
        // healthy" must never look the same to the person reading the row.
        if (!work) {
            await this.settleAtStart(
                promotion,
                task,
                'inconclusive',
                `The Work ${promotion.workId} could not be read, so no deployment could be checked.`,
            );
            return;
        }
        if (work.userId !== promotion.userId) {
            // The Work changed hands under a live promotion. Everything
            // downstream — the URL to load, the credentials to read the
            // branch with, the owner whose fleet runs the browser — would
            // otherwise be taken from one party for a promotion belonging
            // to another. Refuse; a verification is not worth crossing a
            // tenancy boundary for.
            await this.settleAtStart(
                promotion,
                task,
                'inconclusive',
                `The Work ${promotion.workId} no longer belongs to this promotion's owner, so the ` +
                    'deployment was not checked.',
            );
            return;
        }
        if (!this.fleet) {
            await this.settleAtStart(
                promotion,
                task,
                'inconclusive',
                'No fleet job runtime is wired in this deployment, so no browser check could be run.',
            );
            return;
        }

        const target = resolveReleaseVerificationTarget(work.releaseVerification, promotion.rung);
        if (!target || !environment) {
            await this.settleAtStart(
                promotion,
                task,
                'unsupported',
                `This Work has no verification target for its ${environment ?? 'unknown'} environment, ` +
                    'so the deployment was NOT checked. Set one on the Work to have future releases verified.',
            );
            return;
        }

        // THE artefact identity. The BASE branch's tip, read now, because
        // the merge produced a new commit and nothing on the pull-request
        // status carries it — `promotion.headSha` is the branch that was
        // merged FROM and will never equal what gets deployed.
        const expectedSha = await this.readBaseTip(work, promotion);
        if (!expectedSha) {
            await this.settleAtStart(
                promotion,
                task,
                'inconclusive',
                `Could not read the tip of ${promotion.baseBranch} after the merge, so there is no commit ` +
                    'to hold the deployment to. Nothing about this deployment has been verified.',
            );
            return;
        }

        const now = new Date();
        const started = await this.promotions.beginVerification(promotion.id, {
            verifyState: 'awaiting-rollout',
            verifyExpectedSha: expectedSha,
            verifyTargetUrl: target.versionUrl,
            verifyStartedAt: now,
            verifyDeadlineAt: new Date(now.getTime() + RELEASE_VERIFY_BUDGET_MS),
            // Due immediately. The first probe will almost certainly find
            // the OLD commit — the build lane has not even started — and
            // that is a baseline, not a failure.
            verifyRetryAt: now,
            verifyDetail: null,
        });
        if (!started) return;
        Object.assign(promotion, {
            verifyState: 'awaiting-rollout' as ReleaseVerifyState,
            verifyExpectedSha: expectedSha,
        });

        await this.report(
            task,
            `Post-deploy verification started for the ${environment} environment. Watching ` +
                `${target.versionUrl} until it serves ${expectedSha.slice(0, 12)} (the new tip of ` +
                `${promotion.baseBranch}), then checking that ${target.appUrl} renders. ` +
                'Nothing will be reverted automatically whatever this finds.',
        );
    }

    /** A verification that is over before it began, recorded rather than skipped. */
    private async settleAtStart(
        promotion: ReleasePromotion,
        task: Task | null,
        state: Extract<ReleaseVerifyState, 'inconclusive' | 'unsupported'>,
        detail: string,
    ): Promise<void> {
        const now = new Date();
        const claimed = await this.promotions.beginVerification(promotion.id, {
            verifyState: state,
            verifyExpectedSha: null,
            verifyTargetUrl: null,
            verifyStartedAt: now,
            verifyDeadlineAt: null,
            // No retry: a terminal row is invisible to the sweep.
            verifyRetryAt: null,
            verifyDetail: trim(detail),
        });
        if (!claimed) return;
        Object.assign(promotion, { verifyState: state, verifyDetail: trim(detail) });
        await this.report(task, `Deployment NOT verified — ${detail}`);
        await this.fileVerdictNotice(promotion, task, state, detail);
    }

    // ── The sweep ─────────────────────────────────────────────────────

    /**
     * Enqueue the probes that are due, and expire the verifications that
     * have run out of road.
     *
     * The ONLY place a `browser-check` is produced. Everything else in
     * this file records results.
     */
    async enqueueDueChecks(now = new Date()): Promise<VerificationSweepSummary> {
        const summary: VerificationSweepSummary = {
            considered: 0,
            enqueued: 0,
            settled: 0,
            recovered: 0,
        };
        let due: ReleasePromotion[];
        try {
            due = await this.promotions.findVerificationsDue(now);
        } catch (error) {
            this.logger.warn(`Verification sweep could not read its queue: ${describe(error)}`);
            return summary;
        }

        for (const promotion of due) {
            summary.considered += 1;
            try {
                const acted = await this.sweepOne(promotion, now);
                if (acted === 'enqueued') summary.enqueued += 1;
                if (acted === 'settled') summary.settled += 1;
                if (acted === 'recovered') summary.recovered += 1;
            } catch (error) {
                // One bad row must not stop the sweep for the rest. The row
                // stays due and is retried on the next pass, and its own
                // deadline still ends it.
                this.logger.warn(
                    `Promotion ${promotion.id}: verification sweep step failed: ${describe(error)}`,
                );
            }
        }
        return summary;
    }

    private async sweepOne(
        promotion: ReleasePromotion,
        now: Date,
    ): Promise<'enqueued' | 'settled' | 'skipped' | 'recovered'> {
        const state = promotion.verifyState;
        if (!state || isReleaseVerifyTerminal(state)) return 'skipped';

        // THE BOUND, checked before anything else and regardless of whether
        // a check is still in flight. A browser job that never comes back
        // must not be able to hold a promotion open for ever.
        if (isReleaseVerifyExhausted(promotion.verifyAttempts, promotion.verifyDeadlineAt, now)) {
            await this.settle(
                promotion,
                state,
                'inconclusive',
                `Gave up after ${promotion.verifyAttempts} checks: ` +
                    (state === 'awaiting-rollout'
                        ? `${promotion.baseBranch} never appeared as the served commit within the budget. ` +
                          'That is NOT a failed release — it is an unverified one.'
                        : 'the deployment never reached a decisive answer within the budget.'),
                now,
            );
            return 'settled';
        }

        // A check is bound to this row. It is NOT simply "nothing to do":
        // see `reconcileInFlight`.
        if (promotion.verifyJobId) {
            return this.reconcileInFlight(promotion, state, promotion.verifyJobId, now);
        }

        const work = await this.works.findById(promotion.workId);
        // Same owner re-check as at start, on every probe: a Work that
        // changes hands mid-verification must not have its URLs read for
        // somebody else's promotion.
        const target =
            work && work.userId === promotion.userId
                ? resolveReleaseVerificationTarget(work.releaseVerification, promotion.rung)
                : null;
        const probe = releaseVerificationProbe(state, target, promotion.verifyExpectedSha);
        if (!probe) {
            // The target was removed or made unusable underneath a running
            // verification, or the recorded commit is not one. Fail closed:
            // the answer is "we do not know", never "it is fine".
            await this.settle(
                promotion,
                state,
                'inconclusive',
                'The verification target for this environment is no longer readable on the Work, so the ' +
                    'deployment could not be checked.',
                now,
            );
            return 'settled';
        }

        const enqueued = await this.enqueueProbe(promotion, probe, now);
        return enqueued ? 'enqueued' : 'skipped';
    }

    /**
     * A check is already bound to this row. Decide what that means.
     *
     * Added by the slice-AJ review, replacing an unconditional `skipped`.
     * The old behaviour rested on an assumption that is not true: that a
     * bound job will always come back through
     * {@link onBrowserCheckCompleted}. It will not.
     *
     *   - `ReleaseVerificationListener` and this service both swallow their
     *     own failures by contract, so ONE transient database error inside
     *     `findByVerifyJobId` / `recordVerifyResult` / `settleVerification`
     *     drops the result permanently — and so does an API replica
     *     restarting between the fleet's own write and the `@OnEvent`
     *     handler running.
     *   - The enqueue/claim ordering leaks the same way: a crash between
     *     `enqueue` and `claimVerifyAttempt` leaves a job nobody is bound
     *     to, and the completion fires against no row.
     *
     * In every one of those the job is TERMINAL and nothing will ever emit
     * a second completion for it, while `verifyJobId` stays set — so the
     * sweep used to return `skipped` every five minutes for eight hours and
     * the promotion settled `inconclusive` having checked nothing. Which is
     * the exact outcome this slice exists to prevent: a production deploy
     * that is broken and a founder who is not told for eight hours.
     *
     * So: read the job. If it has settled, record its verdict here (through
     * the SAME pass rule the listener uses, so the two cannot disagree). If
     * it has not, push the row down the sweep queue — which is also what
     * stops one owner's stuck fleet from head-of-line blocking every other
     * tenant out of {@link ReleasePromotionRepository.findVerificationsDue}.
     */
    private async reconcileInFlight(
        promotion: ReleasePromotion,
        state: ReleaseVerifyState,
        jobId: string,
        now: Date,
    ): Promise<'skipped' | 'recovered'> {
        const later = new Date(now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS);
        const defer = async (): Promise<'skipped'> => {
            await this.promotions.deferVerification(promotion.id, state, jobId, later);
            return 'skipped';
        };
        // Without the reader this degrades to exactly the old behaviour
        // plus the rescheduling, which is the safe direction: it can only
        // fail to notice a dropped completion, never invent one.
        if (!this.fleetJobs) return defer();

        let job: FleetJob | null;
        try {
            job = await this.fleetJobs.findById(jobId);
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not re-read browser check ${jobId}: ${describe(error)}`,
            );
            return defer();
        }

        if (!job) {
            // The row points at a job that does not exist — nothing can
            // ever complete it. Let the binding go and burn the attempt so
            // the next sweep enqueues under a FRESH idempotency key.
            const released = await this.promotions.releaseVerifyJob(promotion.id, state, jobId, {
                attempts: (promotion.verifyAttempts ?? 0) + 1,
                reconsiderAt: now,
                detail: trim(
                    `The browser check recorded for this attempt (${jobId}) no longer exists; ` +
                        'starting a new one.',
                ),
            });
            if (released) {
                Object.assign(promotion, {
                    verifyJobId: null,
                    verifyAttempts: (promotion.verifyAttempts ?? 0) + 1,
                });
            }
            return 'recovered';
        }

        if (!isFleetJobTerminal(job.status)) return defer();

        // It settled and nobody recorded it. Read it back through the ONE
        // pass rule — `done` plus an explicit `ok: true`, node-reported data
        // narrowed the same way the listener narrows it.
        this.logger.warn(
            `Promotion ${promotion.id}: browser check ${jobId} settled ${job.status} without its ` +
                'result reaching the verification; recovering it from the job row.',
        );
        const ok = isReleaseVerifyCheckPass(job.status, job.result ?? null);
        await this.advance(promotion, state, jobId, ok, trim(describeSettledJob(job)), now);
        return 'recovered';
    }

    /**
     * Put ONE browser check on the owner's fleet.
     *
     * Owner and organization come from the promotion ROW. There is no
     * request anywhere in this path and never can be: the sweep is a cron.
     */
    private async enqueueProbe(
        promotion: ReleasePromotion,
        probe: ReleaseVerificationProbe,
        now: Date,
    ): Promise<boolean> {
        if (!this.fleet) return false;
        const attempt = (promotion.verifyAttempts ?? 0) + 1;

        const payload: FleetBrowserCheckPayload = {
            url: probe.url,
            expectText: probe.expectText,
            timeoutSec: RELEASE_VERIFY_PROBE_TIMEOUT_SEC,
        };
        // Reporting only, per the payload contract — nothing correlates on
        // it. The completion is routed back through `verifyJobId` on the
        // row, which is platform state rather than an echo of what we sent.
        if (promotion.taskId) payload.taskId = promotion.taskId;

        let job: { id: string; kind?: string; status?: string; payload?: unknown };
        try {
            job = await this.fleet.enqueue({
                kind: 'browser-check',
                userId: promotion.userId,
                organizationId: promotion.organizationId ?? null,
                payload: payload as unknown as Record<string, unknown>,
                // Without the tag the job would be leased by a node with no
                // browser, fail instantly with "no executor registered", and
                // burn an attempt on a machine that was never able to answer.
                requiredCapabilities: [FLEET_BROWSER_CAPABILITY],
                // ONE attempt. The fleet's own reclaim would otherwise retry
                // each probe up to three times underneath the attempt ladder
                // in this file, multiplying two independent budgets together.
                maxAttempts: 1,
                idempotencyKey: releaseVerifyIdempotencyKey(promotion.id, attempt),
            });
        } catch (error) {
            // Leave the row due. The next sweep re-derives the same attempt
            // number and the same idempotency key, and the deadline still
            // ends the verification if the fleet stays broken.
            this.logger.warn(
                `Promotion ${promotion.id}: could not enqueue browser check: ${describe(error)}`,
            );
            return false;
        }

        // THE JOB WE WERE HANDED IS NOT NECESSARILY THE JOB WE ASKED FOR.
        //
        // Added by the slice-AJ review. `FleetJobService.enqueue`
        // short-circuits on the idempotency key with
        // `FleetJobRepository.findByIdempotencyKey`, which is a bare
        // `findOne({ where: { idempotencyKey } })`: no status filter, no
        // owner scope, no kind check. So it can hand back
        //
        //   - a job for this key that has ALREADY SETTLED — whose
        //     completion fired while nothing was bound to it, and for which
        //     no second completion will ever arrive; or
        //   - a job SOMEBODY ELSE created under that key, pointed at a page
        //     they control that contains the twelve-character sha, which
        //     their own node would answer `ok: true` for.
        //
        // The unguessability of a promotion uuid was the whole defence and
        // there was nothing behind it. There is now: the job must be a
        // `browser-check`, it must still be live, it must belong to this
        // promotion's owner, and its payload must be the probe this lane
        // just composed. Anything else BURNS THE ATTEMPT instead of being
        // recorded — the next sweep derives attempt N+1 and therefore a
        // different key, so this cannot loop, and the attempt cap still
        // bounds it.
        const mismatch = await this.describeJobMismatch(job, promotion, payload);
        if (mismatch) {
            this.logger.warn(
                `Promotion ${promotion.id}: refusing browser check ${job.id} for attempt ${attempt} — ` +
                    `${mismatch}. Burning the attempt so the next sweep enqueues a fresh one.`,
            );
            await this.promotions.burnVerifyAttempt(promotion.id, promotion.verifyState!, {
                attempts: attempt,
                reconsiderAt: now,
                detail: trim(`Attempt ${attempt} could not be started: ${mismatch}.`),
            });
            Object.assign(promotion, { verifyAttempts: attempt });
            return false;
        }
        const jobId = job.id;

        const claimed = await this.promotions.claimVerifyAttempt(
            promotion.id,
            promotion.verifyState!,
            {
                jobId,
                attempts: attempt,
                targetUrl: probe.url,
                // The row stays visible to the sweep while the check is out,
                // so its DEADLINE can still be enforced if the check never
                // comes back. The sweep will not enqueue a second check —
                // that is gated on `verifyJobId` being null — it will only
                // be able to expire the row.
                reconsiderAt: new Date(now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS),
            },
        );
        if (!claimed) {
            // Another replica claimed the same attempt. Because the key is
            // deterministic in (promotion, attempt), it enqueued the SAME
            // job — so there is exactly one browser out, and the winner owns
            // it. Nothing to undo.
            return false;
        }
        Object.assign(promotion, { verifyJobId: jobId, verifyAttempts: attempt });
        this.logger.log(
            `Promotion ${promotion.id}: ${probe.phase} check ${attempt} enqueued as fleet job ${jobId} ` +
                `against ${probe.url} at ${now.toISOString()}.`,
        );
        return true;
    }

    /**
     * Why the job handed back is NOT the check this lane asked for, or
     * `null` when it is.
     *
     * Fails closed in both directions it can: a job that cannot be read is
     * refused rather than trusted, and so is a job whose owner cannot be
     * established at all. The only thing that passes is a live
     * `browser-check` owned by this promotion's owner whose payload is the
     * probe we composed one line earlier.
     */
    private async describeJobMismatch(
        job: { id: string; kind?: string; status?: string; payload?: unknown },
        promotion: ReleasePromotion,
        payload: FleetBrowserCheckPayload,
    ): Promise<string | null> {
        // Strict, in the fail-closed direction: an absent field is a
        // mismatch, not a pass. `FleetJobService.enqueue` returns a full
        // `FleetJobView` on both of its paths, so there is no legitimate
        // caller that omits one.
        if (job.kind !== 'browser-check') {
            return `it is a '${job.kind ?? 'unknown'}' job, not a browser-check`;
        }
        if (typeof job.status !== 'string') return 'it reported no status';
        if (isFleetJobTerminal(job.status as never)) {
            // The idempotency short-circuit has no status filter, so this
            // is a job that already ran and already reported. Its
            // completion has been and gone.
            return `it has already settled (${job.status}), so no completion will ever arrive for it`;
        }
        const sent = job.payload as Partial<FleetBrowserCheckPayload> | null | undefined;
        if (!sent || sent.url !== payload.url || sent.expectText !== payload.expectText) {
            return 'its payload is not the probe this verification composed';
        }
        // Owner. `FleetJobView` carries no `userId`, so this is the one
        // thing that needs the row itself.
        if (!this.fleetJobs) {
            // Without the reader the owner cannot be established. Refusing
            // would make the lane inert in a deployment that never had this
            // dependency; the payload and kind checks above already refuse
            // the substitution that matters, and the deterministic key is
            // still derived from an unguessable uuid.
            return null;
        }
        let row: FleetJob | null;
        try {
            row = await this.fleetJobs.findById(job.id);
        } catch (error) {
            return `its owner could not be read (${describe(error)})`;
        }
        if (!row) return 'the job row could not be read back';
        if (row.userId !== promotion.userId) {
            return 'it belongs to a different owner than this promotion';
        }
        return null;
    }

    // ── Reading a verdict ─────────────────────────────────────────────

    /**
     * A `browser-check` this lane enqueued reached a verdict.
     *
     * `ok` is computed by the CALLER from the job's terminal status and
     * result, and it must be `true` only for an explicit `ok: true` on a
     * `done` job. Everything else — a failed job, an exhausted lease, a
     * queue-SLA expiry, a result with no `ok`, a result whose `ok` is the
     * string `"true"` — is not a pass. The node's report is untrusted data.
     */
    async onBrowserCheckCompleted(
        jobId: string,
        ok: boolean,
        detail: string | null,
        now = new Date(),
    ): Promise<void> {
        try {
            const promotion = await this.promotions.findByVerifyJobId(jobId);
            // Not one of ours, or the row already settled and stopped
            // pointing at this job. Either way there is nothing to advance.
            if (!promotion) return;
            const state = promotion.verifyState;
            if (!state || isReleaseVerifyTerminal(state)) return;
            await this.advance(promotion, state, jobId, ok, trim(detail ?? ''), now);
        } catch (error) {
            this.logger.warn(
                `Fleet job ${jobId}: could not record a post-deploy verification result: ${describe(error)}`,
            );
        }
    }

    private async advance(
        promotion: ReleasePromotion,
        state: ReleaseVerifyState,
        jobId: string,
        ok: boolean,
        detail: string,
        now: Date,
    ): Promise<void> {
        const streak = (promotion.verifyStreak ?? 0) + 1;
        const later = new Date(now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS);

        if (state === 'awaiting-rollout') {
            if (!ok) {
                // NOT a failure. The promoted commit is not being served
                // yet, which for a production release is the expected answer
                // for the first three or four hours. Reset the streak — the
                // confirmations have to be CONSECUTIVE — and wait.
                if (
                    isReleaseVerifyExhausted(
                        promotion.verifyAttempts,
                        promotion.verifyDeadlineAt,
                        now,
                    )
                ) {
                    await this.settle(
                        promotion,
                        state,
                        'inconclusive',
                        `${promotion.baseBranch} never became the served commit within the budget. ` +
                            `Last reading: ${detail || 'the expected commit was not in the page'}.`,
                        now,
                    );
                    return;
                }
                await this.step(promotion, state, jobId, {
                    verifyState: 'awaiting-rollout',
                    verifyStreak: 0,
                    verifyCheckedAt: now,
                    verifyRetryAt: later,
                    verifyDetail: trim(
                        `Not rolled out yet (attempt ${promotion.verifyAttempts}). ${detail}`,
                    ),
                });
                return;
            }
            if (streak < RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS) {
                // One sample is a coin flip while ArgoCD is replacing pods.
                await this.step(promotion, state, jobId, {
                    verifyState: 'awaiting-rollout',
                    verifyStreak: streak,
                    verifyCheckedAt: now,
                    verifyRetryAt: later,
                    verifyDetail: trim(
                        `Served the promoted commit ${streak}/${RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS} times in a row.`,
                    ),
                });
                return;
            }
            // The rollout has landed. From here — and ONLY from here — this
            // lane is entitled to say anything about the deployment.
            const moved = await this.step(promotion, state, jobId, {
                verifyState: 'checking-app',
                verifyStreak: 0,
                verifyCheckedAt: now,
                // Immediately: the thing we were waiting for has happened.
                verifyRetryAt: now,
                verifyDetail: trim(
                    `Rollout confirmed — ${promotion.verifyExpectedSha?.slice(0, 12) ?? 'the promoted commit'} ` +
                        `served on ${RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS} consecutive checks.`,
                ),
            });
            if (moved) {
                await this.reportOnPromotionTask(
                    promotion,
                    `Rollout confirmed: ${promotion.verifyTargetUrl} is serving ` +
                        `${promotion.verifyExpectedSha?.slice(0, 12) ?? 'the promoted commit'}. Now checking that ` +
                        'the app renders.',
                );
            }
            return;
        }

        if (state === 'checking-app') {
            if (ok) {
                // A pass, even if earlier attempts failed. Reverting a
                // release that is currently serving pages on the strength of
                // an earlier blip is the flap this lane must not produce —
                // but the human is told it was not clean.
                //
                // WHAT THE PASS IS ENTITLED TO CLAIM (slice-AJ review). The
                // artefact identity was established at `versionUrl`; this
                // phase reads `appUrl` with whatever expectation the
                // operator configured, and the shipped recommendation is a
                // fixed `"status":"OK"` health string that an old bundle
                // answers identically. So the verdict now says which of the
                // two it measured instead of "the app rendered as expected"
                // for both.
                const observed = await this.observeTarget(promotion);
                // `verifyStreak` in this state IS the number of app checks
                // that failed immediately before this one, so it is the
                // precise question. Counting total attempts would call every
                // slow production rollout "not clean", since waiting hours
                // for the build is the normal case.
                const blips =
                    (promotion.verifyStreak ?? 0) > 0
                        ? ` ${promotion.verifyStreak} check(s) immediately before it did not, so this ` +
                          'deployment was not clean.'
                        : '';
                await this.settle(
                    promotion,
                    state,
                    'passed',
                    observed.proof === 'artefact'
                        ? `The app rendered the promoted commit.${blips}`
                        : `The app answered as expected at ${observed.appHost ?? 'the app URL'}, and ` +
                              `${observed.versionHost ?? 'the version URL'} served the promoted commit. ` +
                              'The app expectation is a fixed string that does not carry the commit, so ' +
                              'this does NOT prove the app deployment itself rolled out — a build that ' +
                              `never rolled out answers it identically.${blips}`,
                    now,
                    undefined,
                    observed.proof,
                );
                return;
            }
            if (streak < RELEASE_VERIFY_FAILURE_CONFIRMATIONS) {
                if (
                    isReleaseVerifyExhausted(
                        promotion.verifyAttempts,
                        promotion.verifyDeadlineAt,
                        now,
                    )
                ) {
                    // Out of road part-way through a failure streak. NOT
                    // `failed`: the streak never completed, so this was never
                    // confirmed, so no revert is offered.
                    await this.settle(
                        promotion,
                        state,
                        'inconclusive',
                        `The app check failed ${streak} time(s) but the budget ran out before that could be ` +
                            `confirmed. Last reading: ${detail || 'the page did not contain the expected text'}.`,
                        now,
                    );
                    return;
                }
                await this.step(promotion, state, jobId, {
                    verifyState: 'checking-app',
                    verifyStreak: streak,
                    verifyCheckedAt: now,
                    verifyRetryAt: later,
                    verifyDetail: trim(
                        `App check failed ${streak}/${RELEASE_VERIFY_FAILURE_CONFIRMATIONS}. ${detail}`,
                    ),
                });
                return;
            }
            // Enough consecutive failures to mean something — but "the app
            // is broken" and "this node lost the internet" produce the same
            // browser result, and only one of them is about the release. Go
            // and ask the version endpoint before saying a word.
            await this.step(promotion, state, jobId, {
                verifyState: 'confirming-failure',
                verifyStreak: 0,
                verifyCheckedAt: now,
                verifyRetryAt: now,
                verifyDetail: trim(
                    `App check failed ${RELEASE_VERIFY_FAILURE_CONFIRMATIONS} times in a row. ` +
                        'Re-checking that the environment is reachable and still serving the promoted commit ' +
                        `before concluding anything. ${detail}`,
                ),
            });
            return;
        }

        // state === 'confirming-failure'
        if (ok) {
            // The environment answers, and it is serving the commit we
            // promoted — so the failing app checks were about the RELEASE.
            const observed = await this.observeTarget(promotion);
            // Both hosts, named. The confirmation is a DIFFERENT origin
            // from the one that failed — `sanitizeReleaseVerificationTargets`
            // now requires the two to share a site, but a bot interstitial,
            // an HTTP Basic wall or a proxy rule scoped to the app host
            // alone would still fail three app probes and be "confirmed" by
            // a healthy version host. The person deciding on a revert is
            // told which origin produced which half of the evidence.
            const caveat =
                observed.appHost &&
                observed.versionHost &&
                observed.appHost !== observed.versionHost
                    ? ` The failures were at ${observed.appHost} and the confirmation at ` +
                      `${observed.versionHost}; a network condition specific to ${observed.appHost} ` +
                      'would look the same from this node.'
                    : '';
            let offer: Task | null = null;
            await this.settle(
                promotion,
                state,
                'failed',
                `The environment is serving ${promotion.verifyExpectedSha?.slice(0, 12) ?? 'the promoted commit'} ` +
                    `but the app failed ${RELEASE_VERIFY_FAILURE_CONFIRMATIONS} consecutive checks.${caveat}`,
                now,
                // Prepared BEFORE the verdict is narrated, so the sentence
                // the human reads cannot promise a revert Task that was
                // never filed (slice-AJ review: the Inbox used to say "a
                // revert Task has been prepared and is waiting in review"
                // whether or not the write had succeeded).
                async () => {
                    offer = await this.prepareRevertOffer(promotion, now);
                },
            );
            if (offer) await this.announceRevertOffer(promotion, offer);
            return;
        }
        // We cannot reach the version endpoint either. That is evidence
        // about this node's network, not about the release. Refusing to
        // conclude here is what stops a flaky fleet node from filing a
        // revert offer against a healthy production deployment.
        await this.settle(
            promotion,
            state,
            'inconclusive',
            'The app checks failed, but the environment could not be re-confirmed as serving the promoted ' +
                'commit either — so the failures are not evidence about this release. Nothing has been ' +
                `offered for revert. Last reading: ${detail || 'the version endpoint did not answer as expected'}.`,
            now,
        );
    }

    /** Record a non-terminal step. */
    private async step(
        promotion: ReleasePromotion,
        from: ReleaseVerifyState,
        jobId: string,
        patch: {
            verifyState: ReleaseVerifyState;
            verifyStreak: number;
            verifyCheckedAt: Date;
            verifyRetryAt: Date | null;
            verifyDetail: string | null;
        },
    ): Promise<boolean> {
        const applied = await this.promotions.recordVerifyResult(
            promotion.id,
            { jobId, state: from },
            patch,
        );
        if (applied) Object.assign(promotion, patch, { verifyJobId: null });
        return applied;
    }

    /**
     * Record a terminal verdict and, for the ONE caller whose write landed,
     * narrate it.
     *
     * The compare-and-set is what makes "one Inbox item per verdict" true
     * across replicas — the same shape slice AI uses for the gate notice.
     */
    private async settle(
        promotion: ReleasePromotion,
        from: ReleaseVerifyState,
        to: Extract<ReleaseVerifyState, 'passed' | 'failed' | 'inconclusive'>,
        detail: string,
        now: Date,
        /**
         * Runs after the compare-and-set lands and BEFORE anything is
         * narrated — the one caller that uses it prepares the revert offer,
         * so the narration below can report what actually exists instead of
         * what was hoped for. Best-effort like everything else here.
         */
        beforeNarration?: () => Promise<void>,
        /** What a `passed` verdict is entitled to claim; see `observeTarget`. */
        proof?: ReleaseVerifyAppProof,
    ): Promise<boolean> {
        const applied = await this.promotions.settleVerification(promotion.id, from, {
            verifyState: to,
            verifyCheckedAt: now,
            verifyDetail: trim(detail),
        });
        if (!applied) return false;
        Object.assign(promotion, {
            verifyState: to,
            verifyDetail: trim(detail),
            verifyJobId: null,
        });
        if (beforeNarration) {
            try {
                await beforeNarration();
            } catch (error) {
                this.logger.warn(
                    `Promotion ${promotion.id}: post-verdict step failed: ${describe(error)}`,
                );
            }
        }
        const task = await this.loadTask(promotion);
        await this.report(task, verdictNarrative(promotion, to, detail, proof));
        await this.fileVerdictNotice(promotion, task, to, detail);
        return true;
    }

    /**
     * Re-read this promotion's verification target, for NARRATION only.
     *
     * Never an authorization input: the probe URLs were resolved when the
     * attempt was claimed and are already on the row. This exists so a
     * verdict can name the two hosts it is talking about and say how much
     * a green app probe proved. Owner-checked like every other read of the
     * Work in this file, and it fails to the CONSERVATIVE answer —
     * `liveness`, the claim that asserts less — rather than throwing.
     */
    private async observeTarget(promotion: ReleasePromotion): Promise<{
        proof: ReleaseVerifyAppProof;
        appHost: string | null;
        versionHost: string | null;
    }> {
        try {
            const work = await this.works.findById(promotion.workId);
            const target =
                work && work.userId === promotion.userId
                    ? resolveReleaseVerificationTarget(work.releaseVerification, promotion.rung)
                    : null;
            return {
                proof: releaseVerifyAppProof(target, promotion.verifyExpectedSha),
                appHost: target ? hostOf(target.appUrl) : null,
                versionHost: target ? hostOf(target.versionUrl) : null,
            };
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not re-read the verification target: ${describe(error)}`,
            );
            return { proof: 'liveness', appHost: null, versionHost: null };
        }
    }

    // ── The revert OFFER ──────────────────────────────────────────────

    /**
     * File the prepared revert. {@link announceRevertOffer} then says so.
     *
     * The two are separate because ORDER MATTERS: the offer is written
     * before the verdict is narrated, so the verdict can only tell a human
     * a revert is waiting when one actually is. Before the slice-AJ review
     * the notice was filed first and said "a revert Task has been prepared
     * and is waiting in review" even when the Task write had failed and
     * `revertTaskId` was still null — for a terminal verdict the sweep
     * never revisits.
     *
     * THIS IS AN OFFER. It creates a Task and an Inbox item and stops. It
     * does not create a branch, does not create a commit, does not open a
     * pull request, does not merge and does not deploy. Three independent
     * things have to be true before it even gets this far:
     *
     *   1. the verification reached `failed`, which requires a confirmed
     *      rollout, a confirmed failure streak AND a re-confirmation that
     *      the environment is reachable;
     *   2. {@link isReleaseVerifyRevertOffered} agrees, checked here as
     *      well as in the caller;
     *   3. `claimRevertOffer` writes only `WHERE verifyState = 'failed' AND
     *      revertTaskId IS NULL`, so the database refuses an offer for any
     *      other verdict and refuses a second one.
     *
     * The Task is filed IN_REVIEW, not TODO, exactly as a promotion Task
     * is: `TaskGraphFanoutService` starts unblocked TODO Tasks, and a
     * revert Task that dispatched an agent run the moment it was created
     * would be a platform reverting production by itself.
     *
     * And when a human does move it to TODO, the pull request it opens
     * still cannot land unattended: `TaskMergeGateService` recognises the
     * `release:revert` label, forces the `merge_pull_request` approval path
     * whatever the scope's `requireHumanApproval` says, and resolves the
     * base branch from the Work's release LADDER so the branch the
     * protected-branch rule is evaluated against — and the branch named in
     * the sentence the approver reads — is the one the revert actually
     * lands on. Moving a Task out of review is a "start this work" act, not
     * a merge approval, and the gate now treats it as such.
     */
    private async prepareRevertOffer(promotion: ReleasePromotion, now: Date): Promise<Task | null> {
        if (!isReleaseVerifyRevertOffered(promotion.verifyState)) return null;
        if (promotion.revertTaskId) return null;

        const work = await this.works.findById(promotion.workId);
        const promotionTask = await this.loadTask(promotion);

        const task = await this.createRevertTask(promotion, work, promotionTask);
        if (!task) return null;

        const claimed = await this.promotions.claimRevertOffer(promotion.id, task.id, now);
        if (!claimed) {
            // Somebody else got there, or the verdict is not `failed` after
            // all. Retire the Task rather than leaving a second revert offer
            // lying about for a human to act on twice.
            this.logger.warn(
                `Promotion ${promotion.id}: revert offer not claimed; cancelling the duplicate Task ${task.id}.`,
            );
            try {
                await this.tasks.updateById(task.id, { status: TaskStatus.CANCELLED });
            } catch (error) {
                this.logger.warn(
                    `Could not cancel duplicate revert Task ${task.id}: ${describe(error)}`,
                );
            }
            return null;
        }
        Object.assign(promotion, { revertTaskId: task.id, revertOfferedAt: now });
        return task;
    }

    /**
     * Write the Task, once with the node's own reading in it and — if that
     * is refused — once without.
     *
     * `TasksService.create` runs `assertNoSecrets(input.description)`, and
     * the description embeds `promotion.verifyDetail`, which is derived
     * from NODE-REPORTED browser output. A node whose failure string
     * happens to contain a token-shaped substring would otherwise take the
     * whole offer down (slice-AJ review), and `failed` is terminal, so the
     * sweep never revisits the row and the offer would be lost for ever.
     * The reading is the least important part of the description — the
     * coordinates are the point — so it is what gets dropped.
     */
    private async createRevertTask(
        promotion: ReleasePromotion,
        work: Work | null,
        promotionTask: Task | null,
    ): Promise<Task | null> {
        const file = async (withReading: boolean): Promise<Task> =>
            this.tasksService.create(promotion.userId, {
                title: `Revert release: ${promotion.headBranch} → ${promotion.baseBranch}`,
                description: revertTaskDescription(promotion, work, withReading),
                // IN_REVIEW keeps it off the fanout dispatcher. A human
                // moving it to TODO is the deliberate act that starts any
                // work at all, and even then the merge stays gated: a revert
                // Task's own labels make `TaskMergeGateService` require a
                // recorded human approval whatever the scope's policy says.
                status: TaskStatus.IN_REVIEW,
                priority: TaskPriority.P0,
                labels: releaseRevertTaskLabels(promotion.rung),
                workId: promotion.workId,
                agentId: promotionTask?.agentId ?? null,
                createdByType: 'user',
                createdById: promotion.userId,
            });
        try {
            return await file(true);
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not file the revert offer Task with the node's ` +
                    `reading (${describe(error)}); retrying without it.`,
            );
        }
        try {
            return await file(false);
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not file the revert offer Task: ${describe(error)}`,
            );
            return null;
        }
    }

    /** Say that the offer exists — only ever called when it does. */
    private async announceRevertOffer(promotion: ReleasePromotion, task: Task): Promise<void> {
        await this.reportOnPromotionTask(
            promotion,
            `A revert has been PREPARED, not performed: Task ${task.slug ?? task.id}. Nothing has been ` +
                'reverted, and nothing will be until a human decides to act on it.',
        );
        await this.fileRevertNotice(promotion, task);
    }

    // ── Narration ─────────────────────────────────────────────────────

    private async fileVerdictNotice(
        promotion: ReleasePromotion,
        task: Task | null,
        state: ReleaseVerifyState,
        detail: string,
    ): Promise<void> {
        if (!this.inbox) return;
        const lane = `${promotion.headBranch} → ${promotion.baseBranch}`;
        const environment = releaseEnvironmentForRung(promotion.rung) ?? 'unknown';
        const sha = promotion.verifyExpectedSha?.slice(0, 12) ?? null;
        const title =
            state === 'passed'
                ? `Deployment VERIFIED for ${lane}${sha ? ` (@ ${sha})` : ''}`
                : state === 'failed'
                  ? `DEPLOYMENT FAILED after ${lane}${sha ? ` (@ ${sha})` : ''}` +
                    // Only when one exists. `prepareRevertOffer` runs before
                    // this line precisely so this can be true rather than
                    // hopeful.
                    (promotion.revertTaskId
                        ? ' — revert prepared'
                        : ' — NO revert could be prepared')
                  : `Deployment NOT VERIFIED for ${lane}${sha ? ` (@ ${sha})` : ''}`;

        const body = [
            `${lane} merged, and the ${environment} environment was checked from a fleet node with a real browser.`,
            `Verdict: ${state}.`,
            detail,
            promotion.verifyTargetUrl ? `Last URL checked: ${promotion.verifyTargetUrl}` : null,
            sha ? `Commit the deployment was held to: ${sha}` : null,
            whatHappensNext(promotion, state),
        ]
            .filter((line): line is string => Boolean(line))
            .join('\n')
            .slice(0, 8000);

        try {
            await this.inbox.notice(promotion.userId, {
                title: title.slice(0, 300),
                body,
                taskId: task?.id ?? promotion.taskId ?? null,
                workId: promotion.workId,
                agentId: task?.agentId ?? null,
                organizationId: promotion.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(`Promotion ${promotion.id}: inbox notice failed: ${describe(error)}`);
        }
    }

    private async fileRevertNotice(promotion: ReleasePromotion, revertTask: Task): Promise<void> {
        if (!this.inbox) return;
        const lane = `${promotion.headBranch} → ${promotion.baseBranch}`;
        try {
            await this.inbox.notice(promotion.userId, {
                title: `Revert prepared for ${lane} — your decision`.slice(0, 300),
                body: [
                    `The ${releaseEnvironmentForRung(promotion.rung) ?? 'deployed'} environment failed its ` +
                        `post-deploy checks after ${lane} landed, so a revert has been PREPARED.`,
                    '',
                    'NOTHING HAS BEEN REVERTED. This platform does not revert production, and it will not ' +
                        'start now. What exists is a Task holding the coordinates:',
                    `  · Task: ${revertTask.slug ?? revertTask.id} — "${revertTask.title}"`,
                    `  · Promotion pull request: ${promotion.prUrl ?? `#${promotion.prNumber ?? '?'}`}`,
                    `  · Branch to undo it on: ${promotion.baseBranch}`,
                    `  · Commit the failing deployment was serving: ${promotion.verifyExpectedSha ?? 'unknown'}`,
                    '',
                    'What you decide:',
                    '  1. Do nothing — the release stands. The Task sits in review and changes nothing.',
                    '  2. Roll forward — fix it on the integration branch and promote again.',
                    '  3. Revert — start the Task. It opens an ordinary pull request, and landing that pull ' +
                        'request needs the same "Merge pull request" approval in this Inbox as any other ' +
                        'merge, verified against the head commit at merge time.',
                    '',
                    'The next rung is not opened automatically, and neither is this one undone automatically.',
                ]
                    .join('\n')
                    .slice(0, 8000),
                taskId: revertTask.id,
                workId: promotion.workId,
                agentId: revertTask.agentId ?? null,
                organizationId: promotion.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: revert inbox notice failed: ${describe(error)}`,
            );
        }
    }

    // ── Internals ─────────────────────────────────────────────────────

    /**
     * The base branch's tip, from the git provider, right after the merge.
     *
     * Owner, repository and credentials come from the WORK — the same
     * resolution the promotion lane uses, so a promotion and its
     * verification cannot end up reading different repositories.
     */
    private async readBaseTip(work: Work, promotion: ReleasePromotion): Promise<string | null> {
        if (!this.gitFacade) return null;
        const target = this.resolveRepo(work, promotion.userId);
        try {
            const branches = await this.gitFacade.listBranches(
                target.owner,
                target.repo,
                target.gitOptions,
            );
            const match = branches.find((branch) => branch.name === promotion.baseBranch);
            return normalizeCommitSha(match?.commit) ?? null;
        } catch (error) {
            this.logger.warn(
                `Promotion ${promotion.id}: could not read ${promotion.baseBranch}: ${describe(error)}`,
            );
            return null;
        }
    }

    private resolveRepo(
        work: Work,
        userId: string,
    ): { owner: string; repo: string; gitOptions: GitFacadeOptions } {
        return {
            owner: work.getRepoOwner(),
            repo: work.getDataRepo(),
            gitOptions: { userId, providerId: work.gitProvider, workId: work.id },
        };
    }

    private async loadTask(promotion: ReleasePromotion): Promise<Task | null> {
        if (!promotion.taskId) return null;
        try {
            return await this.tasks.findById(promotion.taskId);
        } catch {
            return null;
        }
    }

    private async reportOnPromotionTask(promotion: ReleasePromotion, body: string): Promise<void> {
        await this.report(await this.loadTask(promotion), body);
    }

    /** One line of narrative on the promotion Task's own thread. Best-effort. */
    private async report(task: Task | null, body: string): Promise<void> {
        if (!task?.agentId) return;
        try {
            await this.chat.create({
                taskId: task.id,
                authorType: 'agent',
                authorId: task.agentId,
                body,
                tenantId: task.tenantId ?? null,
                organizationId: task.organizationId ?? null,
            });
        } catch (error) {
            this.logger.warn(`Task ${task.id}: verification report failed: ${describe(error)}`);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Host of a stored probe URL, for narration. Never throws on a bad value. */
function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/**
 * A short reading for a check this lane had to recover off the job row,
 * because nothing recorded its completion (see `reconcileInFlight`).
 *
 * Deliberately the same vocabulary the completion listener produces, and
 * everything in it is NODE-REPORTED and therefore untrusted — the caller
 * flattens and caps it before it touches a row.
 */
function describeSettledJob(job: FleetJob): string {
    if (job.error) return `Node reported: ${job.error}`;
    const result = job.result as { ok?: unknown; error?: unknown } | null | undefined;
    if (!result) return `The check settled ${job.status} with no result.`;
    if (result.ok === true) return 'Page loaded.';
    return typeof result.error === 'string' && result.error
        ? `Check failed: ${result.error}`
        : `Check settled ${job.status} without passing.`;
}

/**
 * Cap and flatten a note before it touches the row.
 *
 * Half of what reaches here is derived from a NODE-REPORTED browser
 * result, which is untrusted data that ends up in an Inbox body and a Task
 * thread. Newlines and control characters are collapsed so a node cannot
 * forge extra lines in either.
 */
function trim(value: string): string {
    return (
        value
            // Escapes, never literal control bytes in the source.
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, DETAIL_MAX)
    );
}

function verdictNarrative(
    promotion: ReleasePromotion,
    state: ReleaseVerifyState,
    detail: string,
    proof?: ReleaseVerifyAppProof,
): string {
    switch (state) {
        case 'passed':
            return (
                `Deployment VERIFIED. ${detail} ` +
                // "Nothing further is required" is a claim, and it is only
                // true when the app probe proved the promoted artefact. On
                // the shipped fixed-string health probe it did not, and
                // telling a founder to stop looking would be exactly the
                // overclaim this lane exists to prevent.
                (proof === 'liveness'
                    ? 'Confirm the app deployment itself by hand, or point the app probe at a page that ' +
                      'carries the build commit.'
                    : 'Nothing further is required.')
            );
        case 'failed':
            return (
                `Deployment FAILED its post-deploy checks. ${detail} ` +
                (promotion.revertTaskId
                    ? 'A revert has been prepared for a human to decide on.'
                    : 'A revert could NOT be prepared — decide by hand.') +
                ' NOTHING HAS BEEN REVERTED.'
            );
        default:
            return (
                `Deployment NOT VERIFIED. ${detail} ` +
                'This is not a pass and it is not a failure — it is the absence of a measurement, so no ' +
                'revert has been offered.'
            );
    }
}

function whatHappensNext(promotion: ReleasePromotion, state: ReleaseVerifyState): string {
    switch (state) {
        case 'passed':
            return 'Nothing else happens. The next rung is a separate promotion and is not opened automatically.';
        case 'failed':
            return promotion.revertTaskId
                ? 'A revert Task has been prepared and is waiting in review. NOTHING HAS BEEN REVERTED — ' +
                      'this platform does not revert production, and starting that Task still leads to an ' +
                      'ordinary pull request that needs your merge approval.'
                : 'A revert Task could NOT be filed for this failure, so there is nothing waiting in ' +
                      'review — do not go looking for one. NOTHING HAS BEEN REVERTED. Decide by hand: read ' +
                      'the environment yourself, and roll forward or revert deliberately.';
        default:
            return (
                'No revert has been offered, because nothing was measured — offering to undo a release on ' +
                'the strength of a check that did not happen is worse than saying so. Decide by hand: read ' +
                'the environment yourself, and roll forward or revert deliberately.'
            );
    }
}

function revertTaskDescription(
    promotion: ReleasePromotion,
    work: Work | null,
    withReading: boolean,
): string {
    const repo = work ? `${work.getRepoOwner()}/${work.getDataRepo()}` : 'the release repository';
    return [
        `Post-deploy verification FAILED after \`${promotion.headBranch}\` → \`${promotion.baseBranch}\` ` +
            `landed in ${repo}.`,
        '',
        '## Nothing has been reverted',
        '',
        'This Task is an OFFER. It was filed in review so that it does nothing at all until you decide it',
        'should. The platform will not revert production on its own, and starting this Task does not merge',
        'anything either: whatever pull request it opens needs the same "Merge pull request" approval in',
        'your Inbox as every other merge, verified against the head commit at merge time.',
        '',
        '## What failed',
        '',
        `- Environment: ${releaseEnvironmentForRung(promotion.rung) ?? 'unknown'}`,
        `- URL last checked: ${promotion.verifyTargetUrl ?? 'unknown'}`,
        `- Commit the environment was serving: \`${promotion.verifyExpectedSha ?? 'unknown'}\``,
        // NODE-REPORTED, and therefore the one line that can be refused by
        // the Task writer's secret scan. Dropped on the retry rather than
        // losing the whole offer.
        `- Reading: ${(withReading && promotion.verifyDetail) || 'see the promotion Task thread'}`,
        '',
        '## What to revert',
        '',
        `- Promotion pull request: ${promotion.prUrl ?? `#${promotion.prNumber ?? 'unknown'}`}`,
        `- Branch to open the revert against: \`${promotion.baseBranch}\``,
        `- The merge commit to undo is the one that landed that pull request on \`${promotion.baseBranch}\`;`,
        `  \`${promotion.verifyExpectedSha ?? 'the recorded commit'}\` is the tip that was read immediately`,
        '  afterwards and is what the failing deployment was serving.',
        '',
        '## Before you choose revert',
        '',
        'Rolling FORWARD is usually cheaper on this repository: the production build lane is measured at',
        '215–243 minutes, so a revert is not a fast undo — it is another full release, and it needs its own',
        'promotion and its own approval. Reverting is right when the fix is not obvious; rolling forward is',
        'right when it is.',
        '',
        'This Task will not open the next rung, and no further checks are queued for the failed deployment.',
    ].join('\n');
}
