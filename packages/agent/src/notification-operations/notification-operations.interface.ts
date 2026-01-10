import { NotificationType, NotificationCategory } from '@src/entities/notification.types';

/**
 * Input for creating a notification through the operations interface.
 * This can be used in both API process (direct) and Trigger.dev process (remote).
 */
export interface CreateNotificationInput {
    userId: string;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    metadata?: Record<string, any>;
    isPersistent?: boolean;
    deduplicationKey?: string;
}

/**
 * Interface for notification operations that works in both API and Trigger.dev contexts.
 * In API process: Uses EventEmitter2 to emit events
 * In Trigger.dev process: Uses internal API to create notifications
 */
export interface NotificationOperations {
    /**
     * Notify when AI credits are depleted for a provider
     */
    notifyAiCreditsDepleted(userId: string, provider: string, errorMessage?: string): Promise<void>;

    /**
     * Notify when there's an AI provider error at account level
     */
    notifyAiProviderError(userId: string, provider: string, errorMessage: string): Promise<void>;

    /**
     * Notify when a generation fails due to an account-level issue
     */
    notifyGenerationAccountError(
        userId: string,
        directoryId: string,
        directoryName: string,
        errorMessage: string,
    ): Promise<void>;

    /**
     * Notify when a schedule is paused due to failures
     */
    notifySchedulePaused(
        userId: string,
        directoryId: string,
        directoryName: string,
        reason: string,
    ): Promise<void>;

    /**
     * Notify when Git authentication expires
     */
    notifyGitAuthExpired(userId: string, provider: string): Promise<void>;

    /**
     * Create a custom notification
     */
    createNotification(input: CreateNotificationInput): Promise<void>;
}

export const NOTIFICATION_OPERATIONS = Symbol('NOTIFICATION_OPERATIONS');
