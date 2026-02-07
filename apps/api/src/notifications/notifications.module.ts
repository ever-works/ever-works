import { Module } from '@nestjs/common';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { DatabaseModule } from '@ever-works/agent/database';
import { NotificationsController } from './notifications.controller';
import { NotificationCleanupService } from './notification-cleanup.service';

@Module({
    imports: [AgentNotificationsModule, DatabaseModule],
    controllers: [NotificationsController],
    providers: [NotificationCleanupService],
    exports: [AgentNotificationsModule],
})
export class NotificationsModule {}
