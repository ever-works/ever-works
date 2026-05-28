import { Module } from '@nestjs/common';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '@src/auth';
import { NotificationsController } from './notifications.controller';
import { NotificationCleanupService } from './notification-cleanup.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationFanoutListener } from './notification-fanout.listener';

@Module({
    imports: [AgentNotificationsModule, DatabaseModule, FacadesModule, AuthModule],
    controllers: [NotificationsController, NotificationPreferencesController],
    providers: [
        NotificationCleanupService,
        DistributedTaskLockService,
        // EW-664 / EW-678 — user notification preferences (subscriptions, quiet
        // hours, category mutes). Additive: v1 NotificationsController + cleanup
        // job keep working unchanged.
        NotificationPreferencesService,
        // EW-664 / EW-678 / T20 — listens to NOTIFICATION_FANOUT_EVENT from v1
        // producers and routes to NotificationChannelFacadeService. Failures
        // never propagate back into the v1 in-app create path.
        NotificationFanoutListener,
    ],
    exports: [AgentNotificationsModule, NotificationPreferencesService],
})
export class NotificationsModule {}
