import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { NotificationService } from './notification.service';
import { UserNotificationSubscriptionService } from './user-notification-subscription.service';

@Module({
    imports: [DatabaseModule],
    providers: [NotificationService, UserNotificationSubscriptionService],
    exports: [NotificationService, UserNotificationSubscriptionService],
})
export class NotificationsModule {}
