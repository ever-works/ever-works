import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { NOTIFICATION_EMAIL_SENDER } from '@ever-works/agent/notifications';
import { MailModule } from '@src/mail/mail.module';
import { NotificationEmailSenderService } from './notification-email-sender.service';

/**
 * Attention controls (AW-13) — binds the built-in `email` delivery target.
 *
 * `@Global()` for the same reason the other port-binding modules in this app
 * are: the port is consumed through an `@Optional() @Inject()` in the agent
 * package's channel facade, whose module must not import this one. Only
 * exported providers are published, so the token is exported.
 *
 * `MailModule` exports `MailService` and imports nothing from the
 * notifications tree, so there is no module cycle.
 */
@Global()
@Module({
    imports: [MailModule, DatabaseModule],
    providers: [
        NotificationEmailSenderService,
        { provide: NOTIFICATION_EMAIL_SENDER, useExisting: NotificationEmailSenderService },
    ],
    exports: [NOTIFICATION_EMAIL_SENDER, NotificationEmailSenderService],
})
export class NotificationEmailModule {}
