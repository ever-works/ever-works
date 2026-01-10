import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export type NotificationType = 'info' | 'warning' | 'error' | 'success';

export type NotificationCategory =
    | 'ai_credits'
    | 'subscription'
    | 'generation'
    | 'system'
    | 'security';

export interface Notification {
    id: string;
    userId: string;
    type: NotificationType;
    category: NotificationCategory;
    title: string;
    message: string;
    actionUrl?: string;
    actionLabel?: string;
    metadata?: Record<string, any>;
    isRead: boolean;
    isDismissed: boolean;
    isPersistent: boolean;
    createdAt: string;
    expiresAt?: string;
}

export interface NotificationsResponse {
    notifications: Notification[];
}

export interface UnreadCountResponse {
    count: number;
}

export interface SuccessResponse {
    success: boolean;
}

export interface GetNotificationsParams {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
    category?: NotificationCategory;
}

export const notificationsAPI = {
    /**
     * Get all notifications for the current user
     */
    getAll: async (params?: GetNotificationsParams): Promise<NotificationsResponse> => {
        const searchParams = new URLSearchParams();

        if (params?.unreadOnly !== undefined) {
            searchParams.set('unreadOnly', String(params.unreadOnly));
        }
        if (params?.limit !== undefined) {
            searchParams.set('limit', String(params.limit));
        }
        if (params?.offset !== undefined) {
            searchParams.set('offset', String(params.offset));
        }
        if (params?.category) {
            searchParams.set('category', params.category);
        }

        const query = searchParams.toString();
        return serverFetch<NotificationsResponse>(`/notifications${query ? `?${query}` : ''}`);
    },

    /**
     * Get the count of unread notifications
     */
    getUnreadCount: async (): Promise<UnreadCountResponse> => {
        return serverFetch<UnreadCountResponse>('/notifications/unread-count');
    },

    /**
     * Get persistent (critical) notifications
     */
    getPersistent: async (): Promise<NotificationsResponse> => {
        return serverFetch<NotificationsResponse>('/notifications/persistent');
    },

    /**
     * Mark a notification as read
     */
    markAsRead: async (notificationId: string): Promise<SuccessResponse> => {
        return serverMutation<SuccessResponse>({
            endpoint: `/notifications/${notificationId}/read`,
            method: 'POST',
            data: {},
            wrapInData: false,
        });
    },

    /**
     * Mark all notifications as read
     */
    markAllAsRead: async (): Promise<SuccessResponse> => {
        return serverMutation<SuccessResponse>({
            endpoint: '/notifications/read-all',
            method: 'POST',
            data: {},
            wrapInData: false,
        });
    },

    /**
     * Dismiss a notification
     */
    dismiss: async (notificationId: string): Promise<SuccessResponse> => {
        return serverMutation<SuccessResponse>({
            endpoint: `/notifications/${notificationId}/dismiss`,
            method: 'POST',
            data: {},
            wrapInData: false,
        });
    },
};
