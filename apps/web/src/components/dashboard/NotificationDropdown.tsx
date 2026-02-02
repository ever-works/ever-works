'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Notification, NotificationType } from '@/lib/api/notifications';
import {
    getNotifications,
    getUnreadNotificationCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    dismissNotification,
} from '@/app/actions/notifications';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface NotificationDropdownProps {
    className?: string;
}

const POLL_INTERVAL = 30000; // 30 seconds

const typeStyles: Record<NotificationType, { bg: string; icon: string; border: string }> = {
    info: {
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        icon: 'text-blue-500 dark:text-blue-400',
        border: 'border-l-blue-500',
    },
    warning: {
        bg: 'bg-yellow-50 dark:bg-yellow-900/20',
        icon: 'text-yellow-500 dark:text-yellow-400',
        border: 'border-l-yellow-500',
    },
    error: {
        bg: 'bg-red-50 dark:bg-red-900/20',
        icon: 'text-red-500 dark:text-red-400',
        border: 'border-l-red-500',
    },
    success: {
        bg: 'bg-green-50 dark:bg-green-900/20',
        icon: 'text-green-500 dark:text-green-400',
        border: 'border-l-green-500',
    },
};

function NotificationIcon({ type }: { type: NotificationType }) {
    const styles = typeStyles[type];

    if (type === 'error') {
        return (
            <svg
                className={cn('w-5 h-5', styles.icon)}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
            </svg>
        );
    }

    if (type === 'warning') {
        return (
            <svg
                className={cn('w-5 h-5', styles.icon)}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
            </svg>
        );
    }

    if (type === 'success') {
        return (
            <svg
                className={cn('w-5 h-5', styles.icon)}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
            </svg>
        );
    }

    // info
    return (
        <svg
            className={cn('w-5 h-5', styles.icon)}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
        </svg>
    );
}

function NotificationItem({
    notification,
    onMarkAsRead,
    onDismiss,
    onNavigate,
    dismissLabel,
}: {
    notification: Notification;
    onMarkAsRead: (id: string) => void;
    onDismiss: (id: string) => void;
    onNavigate: (url: string) => void;
    dismissLabel: string;
}) {
    const styles = typeStyles[notification.type];

    const handleClick = () => {
        if (!notification.isRead) {
            onMarkAsRead(notification.id);
        }
        if (notification.actionUrl) {
            onNavigate(notification.actionUrl);
        }
    };

    return (
        <div
            className={cn(
                'p-3 border-l-4 cursor-pointer transition-colors',
                styles.border,
                !notification.isRead && styles.bg,
                notification.isRead && 'bg-transparent',
                'hover:bg-gray-50 dark:hover:bg-gray-800/50',
            )}
            onClick={handleClick}
        >
            <div className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                    <NotificationIcon type={notification.type} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <p
                            className={cn(
                                'text-sm font-medium',
                                !notification.isRead
                                    ? 'text-text dark:text-text-dark'
                                    : 'text-text-secondary dark:text-text-secondary-dark',
                            )}
                        >
                            {notification.title}
                        </p>
                        {!notification.isPersistent && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDismiss(notification.id);
                                }}
                                className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                aria-label={dismissLabel}
                                title={dismissLabel}
                            >
                                <svg
                                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                            </button>
                        )}
                    </div>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 line-clamp-2">
                        {notification.message}
                    </p>
                    <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {formatDistanceToNow(new Date(notification.createdAt), {
                                addSuffix: true,
                            })}
                        </span>
                        {notification.actionUrl && notification.actionLabel && (
                            <span className="text-xs font-medium text-primary dark:text-primary-light">
                                {notification.actionLabel} &rarr;
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function NotificationDropdown({ className }: NotificationDropdownProps) {
    const t = useTranslations('dashboard.header');
    const tCommon = useTranslations('common.ui');
    const router = useRouter();
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const fetchNotifications = useCallback(async () => {
        try {
            const result = await getNotifications({ limit: 20 });
            if (result.success && result.notifications) {
                setNotifications(result.notifications);
            }
        } catch (error) {
            console.error('Failed to fetch notifications:', error);
        }
    }, []);

    const fetchUnreadCount = useCallback(async () => {
        try {
            const result = await getUnreadNotificationCount();
            if (result.success && result.count !== undefined) {
                setUnreadCount(result.count);
            }
        } catch (error) {
            console.error('Failed to fetch unread count:', error);
        }
    }, []);

    // Initial load and polling
    useEffect(() => {
        fetchUnreadCount();

        const interval = setInterval(fetchUnreadCount, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchUnreadCount]);

    // Fetch notifications when dropdown opens
    useEffect(() => {
        if (isOpen) {
            setIsLoading(true);
            fetchNotifications().finally(() => setIsLoading(false));
        }
    }, [isOpen, fetchNotifications]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleMarkAsRead = async (notificationId: string) => {
        const result = await markNotificationAsRead(notificationId);
        if (result.success) {
            setNotifications((prev) =>
                prev.map((n) => (n.id === notificationId ? { ...n, isRead: true } : n)),
            );
            setUnreadCount((prev) => Math.max(0, prev - 1));
        }
    };

    const handleMarkAllAsRead = async () => {
        const result = await markAllNotificationsAsRead();
        if (result.success) {
            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
            setUnreadCount(0);
        }
    };

    const handleDismiss = async (notificationId: string) => {
        const result = await dismissNotification(notificationId);
        if (result.success) {
            setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
            const notification = notifications.find((n) => n.id === notificationId);
            if (notification && !notification.isRead) {
                setUnreadCount((prev) => Math.max(0, prev - 1));
            }
        } else {
            toast.error(result.error || 'Failed to dismiss notification');
        }
    };

    const handleNavigate = (url: string) => {
        setIsOpen(false);
        router.push(url);
    };

    return (
        <div className={cn('relative', className)} ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    'p-2 rounded-md relative',
                    'text-text-secondary dark:text-text-secondary-dark',
                    'hover:text-text dark:hover:text-text-dark',
                    'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                )}
            >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                </svg>

                {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-danger rounded-full">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <div
                    className={cn(
                        'absolute right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg shadow-lg z-50',
                        'bg-white dark:bg-surface-dark',
                        'border border-border dark:border-border-dark',
                    )}
                >
                    <div className="flex items-center justify-between p-4 border-b border-border dark:border-border-dark">
                        <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('notifications.title')}
                            {unreadCount > 0 && (
                                <span className="ml-2 text-xs font-normal text-text-muted dark:text-text-muted-dark">
                                    ({unreadCount} unread)
                                </span>
                            )}
                        </h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={handleMarkAllAsRead}
                                className="text-xs text-primary dark:text-primary-light hover:underline"
                            >
                                Mark all as read
                            </button>
                        )}
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        {isLoading ? (
                            <div className="p-8 flex items-center justify-center">
                                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : notifications.length === 0 ? (
                            <div className="p-8 text-center">
                                <svg
                                    className="w-12 h-12 mx-auto text-text-muted dark:text-text-muted-dark mb-3"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.5}
                                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                                    />
                                </svg>
                                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                    {t('notifications.empty')}
                                </p>
                            </div>
                        ) : (
                            <div className="divide-y divide-border dark:divide-border-dark">
                                {notifications.map((notification) => (
                                    <NotificationItem
                                        key={notification.id}
                                        notification={notification}
                                        onMarkAsRead={handleMarkAsRead}
                                        onDismiss={handleDismiss}
                                        onNavigate={handleNavigate}
                                        dismissLabel={tCommon('dismiss')}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
