import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { NotificationsController } from './notifications.controller';
import { NotificationCleanupService } from './notification-cleanup.service';

@Module({
    imports: [AgentNotificationsModule, DatabaseModule, AuthModule],
    controllers: [NotificationsController],
    providers: [NotificationCleanupService, DistributedTaskLockService],
    exports: [AgentNotificationsModule],
})
export class NotificationsModule {}
