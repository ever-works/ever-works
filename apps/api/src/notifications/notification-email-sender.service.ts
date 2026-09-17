import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationEventTypeRepository, UserRepository } from '@ever-works/agent/database';
import type {
    NotificationEmailInput,
    NotificationEmailResult,
    NotificationEmailSender,
} from '@ever-works/agent/notifications';
import type { NotificationEmailAvailability } from '@ever-works/contracts';
import { config } from '@src/config/constants';
import { MailService } from '@src/mail/mail.service';

/** Where the "change what you hear about" link in every notification email lands. */
export const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

/**
 * Attention controls (AW-13) — sends the built-in `email` delivery target.
 *
 * Notification email to the account's own address is the product's
 * first-party transactional mail — the same path that sends password resets
 * and budget alerts — so it rides {@link MailService} and needs nothing
 * connected. The channel facade reaches it through the
 * `NOTIFICATION_EMAIL_SENDER` port.
 *
 * Refuses, without retrying, when the deployment has no mail transport, the
 * account has no address, or the address is not verified: a notification is
 * never emailed to an address the account has not proven it owns. Never logs
 * the address.
 */
@Injectable()
export class NotificationEmailSenderService implements NotificationEmailSender {
    private readonly logger = new Logger(NotificationEmailSenderService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly mail: MailService,
        @Optional() private readonly eventTypes?: NotificationEventTypeRepository,
    ) {}

    /**
     * False when mail would not leave the process: with no provider
     * configured the mailer only logs what it would have sent.
     */
    isTransportConfigured(): boolean {
        return config.mail.provider() !== 'faker';
    }

    /** Whether email can be delivered to this account right now. */
    availabilityFor(
        user: { email?: string | null; emailVerified?: boolean } | null,
    ): NotificationEmailAvailability {
        if (!this.isTransportConfigured()) return 'not-configured';
        if (!user?.email || !user.emailVerified) return 'unverified';
        return 'available';
    }

    async deliver(input: NotificationEmailInput): Promise<NotificationEmailResult> {
        if (!this.isTransportConfigured()) {
            return { status: 'not-configured', error: 'not-configured' };
        }
        const user = await this.users.findById(input.userId);
        if (!user?.email) {
            return { status: 'failed', error: 'no-address' };
        }
        if (!user.emailVerified) {
            return { status: 'failed', error: 'address-unverified' };
        }

        const eventTitle = await this.resolveEventTitle(input);
        const sent = await this.mail.sendNotificationEmail(user.email, user.username ?? 'there', {
            title: input.title,
            message: input.message,
            eventTitle,
            actionUrl: input.actionUrl ?? null,
            actionLabel: input.actionLabel ?? null,
            settingsPath: NOTIFICATION_SETTINGS_PATH,
        });
        if (!sent) {
            return { status: 'failed', error: 'no-address' };
        }
        this.logger.debug(
            `Notification email sent for user=${input.userId} event=${input.eventKey}`,
        );
        return { status: 'delivered' };
    }

    /** The registry title names the matrix row the "you get this because" line points at. */
    private async resolveEventTitle(input: NotificationEmailInput): Promise<string> {
        if (!input.eventKey || !this.eventTypes) return input.title;
        try {
            const eventType = await this.eventTypes.findByKey(input.eventKey);
            return eventType?.title ?? input.title;
        } catch {
            return input.title;
        }
    }
}
