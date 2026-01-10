'use server';

import { notificationsAPI, Notification, NotificationCategory } from '@/lib/api/notifications';
import { revalidatePath } from 'next/cache';

export interface NotificationsResult {
    success: boolean;
    notifications?: Notification[];
    error?: string;
}

export interface UnreadCountResult {
    success: boolean;
    count?: number;
    error?: string;
}

export interface ActionResult {
    success: boolean;
    error?: string;
}

/**
 * Get all notifications for the current user
 */
export async function getNotifications(options?: {
    unreadOnly?: boolean;
    limit?: number;
    category?: NotificationCategory;
}): Promise<NotificationsResult> {
    try {
        const response = await notificationsAPI.getAll(options);
        return {
            success: true,
            notifications: response.notifications,
        };
    } catch (error) {
        console.error('Failed to get notifications:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get notifications',
        };
    }
}

/**
 * Get the count of unread notifications
 */
export async function getUnreadNotificationCount(): Promise<UnreadCountResult> {
    try {
        const response = await notificationsAPI.getUnreadCount();
        return {
            success: true,
            count: response.count,
        };
    } catch (error) {
        console.error('Failed to get unread count:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get unread count',
        };
    }
}

/**
 * Get persistent (critical) notifications for display in global banner
 */
export async function getPersistentNotifications(): Promise<NotificationsResult> {
    try {
        const response = await notificationsAPI.getPersistent();
        return {
            success: true,
            notifications: response.notifications,
        };
    } catch (error) {
        console.error('Failed to get persistent notifications:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to get persistent notifications',
        };
    }
}

/**
 * Mark a notification as read
 */
export async function markNotificationAsRead(notificationId: string): Promise<ActionResult> {
    try {
        await notificationsAPI.markAsRead(notificationId);
        revalidatePath('/');
        return { success: true };
    } catch (error) {
        console.error('Failed to mark notification as read:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to mark notification as read',
        };
    }
}

/**
 * Mark all notifications as read
 */
export async function markAllNotificationsAsRead(): Promise<ActionResult> {
    try {
        await notificationsAPI.markAllAsRead();
        revalidatePath('/');
        return { success: true };
    } catch (error) {
        console.error('Failed to mark all notifications as read:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to mark all notifications as read',
        };
    }
}

/**
 * Dismiss a notification
 */
export async function dismissNotification(notificationId: string): Promise<ActionResult> {
    try {
        await notificationsAPI.dismiss(notificationId);
        revalidatePath('/');
        return { success: true };
    } catch (error) {
        console.error('Failed to dismiss notification:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to dismiss notification',
        };
    }
}
