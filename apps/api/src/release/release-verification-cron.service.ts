import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { ReleaseVerificationService } from '@ever-works/agent/tasks-domain';

const VERIFICATION_SWEEP_LOCK_KEY = 'release:post-deploy-verification';

/**
 * Post-deploy verification (self-build slice AJ, EW-809) — the clock.
 *
 * ## Why a sweep exists at all
 *
 * The fleet job queue has NO delay primitive. `FleetJobRepository.create`
 * writes a row that is lease-able the instant it exists; there is no
 * `runAfter`, no `notBefore`, and no scheduled-at column anywhere on the
 * path. The production build lane is measured at 215–243 minutes and
 * ArgoCD's rollout follows it, so a check enqueued at merge time answers
 * "the old build is still serving" for hours. Something has to space the
 * probes out, and this is it.
 *
 * A sweep is also the only thing that CAN end a verification whose browser
 * check never came back. The completion listener advances a row when a job
 * settles; if a job never settles, only a clock can notice.
 *
 * ## Why the promotion lane could not do this itself
 *
 * `ReleasePromotionService`'s refresh is driven by the two-minute
 * PR-status sweep, and it stops dead at the merge: `closeLane` rewrites
 * `laneKey` to `merged:<id>`, `findOpenByTaskId` stops matching, and no
 * existing sweep in the platform ever visits the row again. Verification
 * begins exactly where the promotion lane ends, so it needs its own clock.
 *
 * ## Five minutes, not one
 *
 * The probe spacing is `RELEASE_VERIFY_ATTEMPT_INTERVAL_MS` (ten minutes)
 * and lives in contracts beside the bounds it has to agree with; this cron
 * only decides how promptly a due row is noticed. Five minutes keeps the
 * worst-case latency on a state transition to half an interval while
 * running twelve times an hour against an indexed query over a table that
 * gains two rows a week.
 *
 * Distributed-locked, like every other multi-replica sweep in this
 * codebase: without it every API replica would claim attempts for the same
 * rows. The per-row compare-and-set (`WHERE verifyJobId IS NULL`) is the
 * real guarantee and this is the cheap one in front of it.
 */
@Injectable()
export class ReleaseVerificationCronService {
    private readonly logger = new Logger(ReleaseVerificationCronService.name);

    constructor(
        private readonly verification: ReleaseVerificationService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_5_MINUTES)
    async sweep(): Promise<void> {
        await this.taskLockService.runExclusive(
            VERIFICATION_SWEEP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.verification.enqueueDueChecks();
                    if (summary.enqueued > 0 || summary.settled > 0 || summary.recovered > 0) {
                        this.logger.log(
                            `Post-deploy verification sweep: ${summary.enqueued} check(s) enqueued, ` +
                                `${summary.settled} verification(s) settled, ${summary.recovered} ` +
                                `result(s) recovered, ${summary.considered} considered.`,
                        );
                    }
                    if (summary.recovered > 0) {
                        // A non-zero recovery count means a browser check
                        // reached a terminal fleet state without its result
                        // reaching the state machine — a dropped
                        // `fleet.job.completed`, or a replica that restarted
                        // mid-handler. The sweep repaired it, but it is a
                        // fact about this deployment worth seeing.
                        this.logger.warn(
                            `Post-deploy verification recovered ${summary.recovered} check result(s) ` +
                                'that the completion listener never recorded.',
                        );
                    }
                } catch (error) {
                    // The service already swallows per-row failures; this is
                    // the belt for a failure of the sweep itself. A throw out
                    // of a @Cron handler is an unhandled rejection.
                    this.logger.error(
                        'Post-deploy verification sweep failed',
                        error instanceof Error ? error.stack : String(error),
                    );
                }
            },
            {
                ttlMs: 5 * 60_000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping post-deploy verification sweep — another instance holds the lock',
                    ),
            },
        );
    }
}
