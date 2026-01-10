export enum NotificationType {
    INFO = 'info',
    WARNING = 'warning',
    ERROR = 'error',
    SUCCESS = 'success',
}

export enum NotificationCategory {
    AI_CREDITS = 'ai_credits',
    SUBSCRIPTION = 'subscription',
    GENERATION = 'generation',
    SYSTEM = 'system',
    SECURITY = 'security',
}

export interface CreateNotificationDto {
    userId: string;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    metadata?: Record<string, any>;
    isPersistent?: boolean;
    expiresAt?: Date;
    deduplicationKey?: string;
}

export interface NotificationQueryOptions {
    unreadOnly?: boolean;
    undismissedOnly?: boolean;
    limit?: number;
    offset?: number;
    category?: NotificationCategory;
}
