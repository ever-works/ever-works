import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { EmailDraftService } from '@ever-works/agent/email';

export const EMAIL_DRAFT_RELEASE_SWEEP_LOCK_KEY = 'email:approved-draft-release';

/**
 * Agent email (AW-05) — the clock behind "approved in the approvals queue →
 * the held draft is released".
 *
 * ## Why a sweep exists at all
 *
 * A person's decision in the queue is recorded first; the draft is released
 * by `EmailDraftApprovalListener` reacting to the in-process decision event.
 * An in-process event is not durable: a replica that stops between the two,
 * or a listener that fails before it moves the draft, leaves an approved
 * proposal over a message that never went out — and nothing would ever look
 * at it again. `EmailDraftService.releaseApprovedDrafts` finds exactly those
 * drafts (a person's approval older than the listener's grace window, never
 * attempted) and releases them; its compare-and-set on the message row is
 * the real guarantee against a double send.
 *
 * ## Why every minute
 *
 * The work is one indexed query that normally returns nothing; a person who
 * approved a message should not wait long to see it go out when the listener
 * missed it.
 *
 * Distributed-locked like every other multi-replica sweep here, so replicas
 * do not all pick up the same drafts on the same tick.
 */
@Injectable()
export class EmailDraftReleaseCronService {
    private readonly logger = new Logger(EmailDraftReleaseCronService.name);

    constructor(
        private readonly drafts: EmailDraftService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(CronExpression.EVERY_MINUTE)
    async sweep(): Promise<void> {
        await this.taskLockService.runExclusive(
            EMAIL_DRAFT_RELEASE_SWEEP_LOCK_KEY,
            async () => {
                try {
                    const summary = await this.drafts.releaseApprovedDrafts();
                    if (summary.released > 0 || summary.failed > 0) {
                        // Non-zero means the decision listener missed these —
                        // worth seeing.
                        this.logger.warn(
                            `Approved email drafts the decision listener did not release: ` +
                                `${summary.released} released now, ${summary.failed} failed, ` +
                                `${summary.considered} considered.`,
                        );
                    }
                } catch (error) {
                    // A throw out of a @Cron handler is an unhandled rejection.
                    this.logger.error(
                        'Approved email draft release sweep failed',
                        error instanceof Error ? error.stack : String(error),
                    );
                }
            },
            {
                ttlMs: 60_000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping approved email draft release sweep — another instance holds the lock',
                    ),
            },
        );
    }
}
