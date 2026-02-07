import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from '@ever-works/agent/notifications';

@Injectable()
export class NotificationCleanupService {
    private readonly logger = new Logger(NotificationCleanupService.name);

    constructor(private readonly notificationService: NotificationService) {}

    /**
     * Run cleanup daily at 3 AM
     * - Deletes expired notifications
     * - Deletes dismissed notifications older than 7 days
     * - Deletes all notifications older than 30 days
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async cleanupNotifications() {
        this.logger.log('Starting notification cleanup...');

        try {
            const result = await this.notificationService.cleanup();
            this.logger.log(
                `Notification cleanup completed: ${result.expired} expired, ${result.dismissed} dismissed (>7d), ${result.old} old (>30d)`,
            );
        } catch (error) {
            this.logger.error('Notification cleanup failed:', error);
        }
    }
}
