import { Module } from '@nestjs/common';
import { NotificationsModule } from '@src/notifications/notifications.module';
import { EventNotificationOperationsService } from './event-notification-operations.service';
import { NOTIFICATION_OPERATIONS } from './notification-operations.interface';

@Module({
    imports: [NotificationsModule],
    providers: [
        EventNotificationOperationsService,
        {
            provide: NOTIFICATION_OPERATIONS,
            useExisting: EventNotificationOperationsService,
        },
    ],
    exports: [NOTIFICATION_OPERATIONS, EventNotificationOperationsService],
})
export class NotificationOperationsModule {}
