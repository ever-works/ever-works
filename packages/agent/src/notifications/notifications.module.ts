import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { NotificationService } from './notification.service';
import { UserNotificationSubscriptionService } from './user-notification-subscription.service';
import { DefaultInboundEmailDispatcher } from './default-inbound-email-dispatcher.service';
import { AGENT_INBOUND_EMAIL_DISPATCHER } from './agent-inbound-email-dispatcher';

@Module({
    imports: [DatabaseModule],
    providers: [
        NotificationService,
        UserNotificationSubscriptionService,
        // EW-670 / T25 — default inbound-email dispatcher bound to the
        // AGENT_INBOUND_EMAIL_DISPATCHER token. The platform overrides the
        // INBOUND_EMAIL_TASK_SPAWNER adapter to wire real Task creation.
        DefaultInboundEmailDispatcher,
        { provide: AGENT_INBOUND_EMAIL_DISPATCHER, useExisting: DefaultInboundEmailDispatcher },
    ],
    exports: [
        NotificationService,
        UserNotificationSubscriptionService,
        DefaultInboundEmailDispatcher,
        AGENT_INBOUND_EMAIL_DISPATCHER,
    ],
})
export class NotificationsModule {}
