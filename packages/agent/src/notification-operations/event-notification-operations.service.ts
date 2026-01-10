import { Injectable } from '@nestjs/common';
import {
    NotificationOperations,
    CreateNotificationInput,
} from './notification-operations.interface';
import { NotificationService } from '@src/notifications/notification.service';
import { NotificationType, NotificationCategory } from '@src/entities/notification.types';

/**
 * Implementation of NotificationOperations for API process.
 * Creates notifications directly in the database.
 */
@Injectable()
export class EventNotificationOperationsService implements NotificationOperations {
    constructor(private readonly notificationService: NotificationService) {}

    async notifyAiCreditsDepleted(
        userId: string,
        provider: string,
        errorMessage?: string,
    ): Promise<void> {
        await this.notificationService.create({
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
        await this.notificationService.create({
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
        directoryId: string,
        directoryName: string,
        errorMessage: string,
    ): Promise<void> {
        await this.notificationService.create({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.GENERATION,
            title: 'Generation Failed',
            message: `Generation for "${directoryName}" failed: ${errorMessage}`,
            actionUrl: `/directories/${directoryId}`,
            actionLabel: 'View Directory',
            metadata: { directoryId, directoryName },
            deduplicationKey: `generation_error_${directoryId}`,
        });
    }

    async notifySchedulePaused(
        userId: string,
        directoryId: string,
        directoryName: string,
        reason: string,
    ): Promise<void> {
        await this.notificationService.create({
            userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.GENERATION,
            title: 'Schedule Paused',
            message: `Scheduled updates for "${directoryName}" paused: ${reason}`,
            actionUrl: `/directories/${directoryId}/schedule`,
            actionLabel: 'View Schedule',
            metadata: { directoryId, directoryName },
            deduplicationKey: `schedule_paused_${directoryId}`,
        });
    }

    async notifyGitAuthExpired(userId: string, provider: string): Promise<void> {
        await this.notificationService.create({
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

    async createNotification(input: CreateNotificationInput): Promise<void> {
        await this.notificationService.create(input);
    }
}
