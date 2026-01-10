import { Injectable } from '@nestjs/common';
import { NotificationType, NotificationCategory } from '@packages/agent/entities';
import type {
    NotificationOperations,
    CreateNotificationInput,
} from '@packages/agent/notification-operations';
import { TriggerInternalApiClient } from './trigger-internal-api.client';

/**
 * Implementation of NotificationOperations that uses the internal API.
 * Used when running in the Trigger.dev process (no database access).
 */
@Injectable()
export class RemoteNotificationOperationsService implements NotificationOperations {
    constructor(private readonly apiClient: TriggerInternalApiClient) {}

    async notifyAiCreditsDepleted(
        userId: string,
        provider: string,
        errorMessage?: string,
    ): Promise<void> {
        await this.apiClient.createNotification({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Credits Depleted',
            message:
                errorMessage ||
                `Your ${provider} credits have been exhausted. Please add more credits to continue using AI features.`,
            actionUrl: '/settings',
            actionLabel: 'Add Credits',
            isPersistent: true,
            deduplicationKey: `ai_credits_depleted_${provider}`,
        });
    }

    async notifyAiProviderError(
        userId: string,
        provider: string,
        errorMessage: string,
    ): Promise<void> {
        await this.apiClient.createNotification({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.AI_CREDITS,
            title: 'AI Provider Error',
            message: `Error with ${provider}: ${errorMessage}`,
            actionUrl: '/settings',
            actionLabel: 'Check Settings',
            deduplicationKey: `ai_provider_error_${provider}`,
        });
    }

    async notifyGenerationAccountError(
        userId: string,
        directoryId: string,
        directoryName: string,
        errorMessage: string,
    ): Promise<void> {
        await this.apiClient.createNotification({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.GENERATION,
            title: 'Generation Failed - Account Issue',
            message: `Generation for "${directoryName}" failed: ${errorMessage}`,
            actionUrl: `/directories/${directoryId}`,
            actionLabel: 'View Directory',
            metadata: { directoryId, directoryName },
            deduplicationKey: `generation_account_error_${directoryId}`,
        });
    }

    async notifySchedulePaused(
        userId: string,
        directoryId: string,
        directoryName: string,
        reason: string,
    ): Promise<void> {
        await this.apiClient.createNotification({
            userId,
            type: NotificationType.WARNING,
            category: NotificationCategory.GENERATION,
            title: 'Schedule Paused',
            message: `Scheduled updates for "${directoryName}" have been paused: ${reason}`,
            actionUrl: `/directories/${directoryId}/schedule`,
            actionLabel: 'View Schedule',
            metadata: { directoryId, directoryName },
            deduplicationKey: `schedule_paused_${directoryId}`,
        });
    }

    async notifyGitAuthExpired(userId: string, provider: string): Promise<void> {
        await this.apiClient.createNotification({
            userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SECURITY,
            title: 'Git Authentication Expired',
            message: `Your ${provider} authentication has expired. Please reconnect to continue pushing changes.`,
            actionUrl: '/settings/oauth',
            actionLabel: 'Reconnect',
            isPersistent: true,
            deduplicationKey: `git_auth_expired_${provider}`,
        });
    }

    async createNotification(input: CreateNotificationInput): Promise<void> {
        await this.apiClient.createNotification(input);
    }
}
