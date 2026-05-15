import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { NotificationRepository } from '@src/database/repositories/notification.repository';
import {
    Notification,
    CreateNotificationDto,
    NotificationQueryOptions,
    NotificationType,
    NotificationCategory,
} from '@src/entities';

@Injectable()
export class NotificationService {
    private readonly logger = new Logger(NotificationService.name);

    constructor(private readonly repository: NotificationRepository) {}

    /**
     * Create a new notification for a user.
     * Supports deduplication to prevent duplicate notifications.
     */
    async create(dto: CreateNotificationDto): Promise<Notification> {
        // Check deduplication - if a notification with this key already exists and isn't dismissed, return it
        if (dto.deduplicationKey) {
            const existing = await this.repository.findByDeduplicationKey(
                dto.userId,
                dto.deduplicationKey,
            );
            if (existing && !existing.isDismissed) {
                this.logger.debug(
                    `Notification with deduplication key ${dto.deduplicationKey} already exists`,
                );
                return existing;
            }
        }

        try {
            const notification = await this.repository.create(dto);

            this.logger.log(
                `Created notification ${notification.id} for user ${dto.userId}: ${dto.title}`,
            );

            return notification;
        } catch (error) {
            // Handle race condition: another request created the notification between our check and insert
            if (dto.deduplicationKey && this.isUniqueConstraintError(error)) {
                this.logger.debug(
                    `Race condition detected for deduplication key ${dto.deduplicationKey}, fetching existing`,
                );
                const existing = await this.repository.findByDeduplicationKey(
                    dto.userId,
                    dto.deduplicationKey,
                );
                if (existing) {
                    return existing;
                }
            }
            throw error;
        }
    }

    /**
     * Check if error is a unique constraint violation
     */
    private isUniqueConstraintError(error: unknown): boolean {
        if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as { code: string }).code;
            // PostgreSQL: 23505, MySQL: ER_DUP_ENTRY (1062), SQLite: SQLITE_CONSTRAINT (19)
            return code === '23505' || code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT';
        }
        return false;
    }

    /**
     * Get notifications for a user with optional filtering
     */
    async getNotifications(
        userId: string,
        options?: NotificationQueryOptions,
    ): Promise<Notification[]> {
        return await this.repository.findByUserId(userId, options);
    }

    /**
     * Get unread notification count for a user
     */
    async getUnreadCount(userId: string): Promise<number> {
        return await this.repository.getUnreadCount(userId);
    }

    /**
     * Mark a notification as read
     */
    async markAsRead(userId: string, notificationId: string): Promise<void> {
        const notification = await this.repository.findByIdAndUserId(notificationId, userId);
        if (!notification) {
            throw new BadRequestException('Notification not found');
        }

        await this.repository.markAsRead(notificationId);
        this.logger.debug(`Marked notification ${notificationId} as read`);
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId: string): Promise<void> {
        await this.repository.markAllAsRead(userId);
        this.logger.debug(`Marked all notifications as read for user ${userId}`);
    }

    /**
     * Dismiss a notification (hides it from view)
     * Persistent notifications cannot be dismissed
     */
    async dismiss(userId: string, notificationId: string): Promise<void> {
        const notification = await this.repository.findByIdAndUserId(notificationId, userId);
        if (!notification) {
            throw new BadRequestException('Notification not found');
        }

        if (notification.isPersistent) {
            throw new BadRequestException(
                'Persistent notifications cannot be dismissed. Please resolve the underlying issue first.',
            );
        }

        await this.repository.dismiss(notificationId);
        this.logger.debug(`Dismissed notification ${notificationId}`);
    }

    /**
     * Get persistent (critical) notifications for a user
     * These are shown prominently in the UI (e.g., global banner)
     */
    async getPersistentNotifications(userId: string): Promise<Notification[]> {
        return await this.repository.getPersistentNotifications(userId);
    }

    /**
     * Clear a notification by its deduplication key
     * Useful when the underlying issue is resolved
     */
    async clearByDeduplicationKey(userId: string, deduplicationKey: string): Promise<void> {
        await this.repository.clearDeduplicationKey(userId, deduplicationKey);
        this.logger.debug(
            `Cleared notification with deduplication key ${deduplicationKey} for user ${userId}`,
        );
    }

    async notifyAiCreditsDepleted(
        userId: string,
        provider: string,
        errorMessage?: string,
    ): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Credits Depleted',
            message:
                errorMessage ||
                `Your ${provider} credits have been exhausted. Please add more credits to continue.`,
            actionUrl: '/settings',
            actionLabel: 'Add Credits',
            isPersistent: true,
            deduplicationKey: `ai_credits_depleted_${provider.toLowerCase()}`,
        });
    }

    async notifyAiProviderError(
        userId: string,
        provider: string,
        errorMessage: string,
    ): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Provider Error',
            message: `Error with ${provider}: ${errorMessage}`,
            actionUrl: '/settings',
            actionLabel: 'Check Settings',
            deduplicationKey: `ai_provider_error_${provider.toLowerCase()}`,
        });
    }

    async notifyGenerationAccountError(
        userId: string,
        workId: string,
        workName: string,
        errorMessage: string,
    ): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.GENERATION,
            title: 'Generation Failed',
            message: `Generation for "${workName}" failed: ${errorMessage}`,
            actionUrl: `/works/${workId}`,
            actionLabel: 'View Work',
            metadata: { workId, workName },
            deduplicationKey: `generation_error_${workId}`,
        });
    }

    async notifySchedulePaused(
        userId: string,
        workId: string,
        workName: string,
        reason: string,
    ): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.GENERATION,
            title: 'Schedule Paused',
            message: `Scheduled updates for "${workName}" paused: ${reason}`,
            actionUrl: `/works/${workId}/generator/schedule`,
            actionLabel: 'View Schedule',
            metadata: { workId, workName },
            deduplicationKey: `schedule_paused_${workId}`,
        });
    }

    async notifyBudgetThresholdCrossed(args: {
        userId: string;
        workId: string;
        budgetId: string;
        threshold: '75' | '90' | '100' | 'overage';
        scope: 'global' | 'plugin';
        pluginId?: string | null;
        currentSpendCents: number;
        capCents: number;
        currency: string;
    }): Promise<void> {
        const isError = args.threshold === '100' || args.threshold === 'overage';
        const scopeLabel =
            args.scope === 'plugin' && args.pluginId ? `plugin '${args.pluginId}'` : 'this directory';
        const titleByThreshold: Record<typeof args.threshold, string> = {
            '75': 'Budget at 75%',
            '90': 'Budget at 90%',
            '100': 'Budget cap reached',
            overage: 'Budget overage in progress',
        };
        await this.create({
            userId: args.userId,
            type: isError ? NotificationType.ERROR : NotificationType.WARNING,
            category: NotificationCategory.AI_CREDITS,
            title: titleByThreshold[args.threshold],
            message: `${scopeLabel} has used ${args.currentSpendCents} / ${args.capCents} ${args.currency.toUpperCase()} cents this period.`,
            actionUrl: '/settings/budgets-usage',
            actionLabel: 'Manage budgets',
            isPersistent: isError,
            metadata: {
                workId: args.workId,
                budgetId: args.budgetId,
                threshold: args.threshold,
                scope: args.scope,
                pluginId: args.pluginId,
            },
            deduplicationKey: `budget_${args.budgetId}_${args.threshold}`,
        });
    }

    async notifyGitAuthExpired(userId: string, provider: string): Promise<void> {
        await this.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SECURITY,
            title: 'Git Authentication Expired',
            message: `Your ${provider} authentication has expired. Please reconnect.`,
            actionUrl: '/settings/oauth',
            actionLabel: 'Reconnect',
            isPersistent: true,
            deduplicationKey: `git_auth_expired_${provider.toLowerCase()}`,
        });
    }

    /**
     * Delete expired and old notifications
     * Should be called periodically by a cleanup job
     */
    async cleanup(): Promise<{ expired: number; dismissed: number; old: number }> {
        const expired = await this.repository.deleteExpired();
        const dismissed = await this.repository.deleteOlderThan({
            olderThanDays: 7,
            isDismissed: true,
        });
        const old = await this.repository.deleteOlderThan({
            olderThanDays: 30,
        });

        this.logger.log(
            `Notification cleanup: ${expired} expired, ${dismissed} dismissed (>7d), ${old} old (>30d)`,
        );

        return { expired, dismissed, old };
    }
}
