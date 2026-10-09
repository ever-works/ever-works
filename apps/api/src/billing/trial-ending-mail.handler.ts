import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserRepository } from '@ever-works/agent/database';
import {
    BILLING_TRIAL_ENDING_EVENT,
    type BillingTrialEndingEvent,
} from '@ever-works/agent/subscriptions';
import { MailService } from '@src/mail/mail.service';

/**
 * Turns a trial-ending reminder (emitted once per `(subscription, lead)` by the agent-side
 * `TrialReminderService`) into the reminder email, through the app's existing `MailService`.
 *
 * The dedup is upstream, so this handler sends unconditionally. It never throws back into the
 * emitter: the webhook / sweep that raised the event has already done its job, and a mail
 * failure must not turn into a provider retry storm. Never logs the address.
 */
@Injectable()
export class TrialEndingMailHandler {
    private readonly logger = new Logger(TrialEndingMailHandler.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly mailService: MailService,
    ) {}

    @OnEvent(BILLING_TRIAL_ENDING_EVENT, { async: true })
    async handle(event: BillingTrialEndingEvent): Promise<void> {
        try {
            const user = await this.userRepository.findById(event.userId);
            if (!user?.email) {
                this.logger.debug(`Trial reminder for user ${event.userId}: no email on file`);
                return;
            }
            await this.mailService.sendTrialEndingEmail(user.email, user.username ?? 'there', {
                planName: event.planName,
                trialEnd: new Date(event.trialEnd),
                lead: event.lead,
            });
        } catch (error) {
            this.logger.warn(
                `Trial reminder email for user ${event.userId} (${event.lead}) failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
