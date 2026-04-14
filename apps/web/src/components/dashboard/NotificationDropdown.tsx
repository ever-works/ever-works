'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { NOTIFICATION_TYPE_STYLES } from '@/lib/utils/notification-styles';
import { Notification } from '@/lib/api/notifications';
import {
    getNotifications,
    getUnreadNotificationCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    dismissNotification,
} from '@/app/actions/notifications';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Bell, X } from 'lucide-react';

interface NotificationDropdownProps {
    className?: string;
}

const POLL_INTERVAL = 30000; // 30 seconds

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
    const styles = NOTIFICATION_TYPE_STYLES[notification.type];
    const TypeIcon = styles.icon;

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
                styles.dropdown.border,
                !notification.isRead && styles.dropdown.bg,
                notification.isRead && 'bg-transparent',
                'hover:bg-gray-50 dark:hover:bg-gray-800/50',
            )}
            onClick={handleClick}
        >
            <div className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                    <TypeIcon className={cn('w-5 h-5', styles.iconColor)} />
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
                                <X className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
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
            toast.error(t('notifications.fetchFailed'));
        }
    }, [t]);

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
        const updateUnreadCount = async () => {
            await fetchUnreadCount();
        };

        void updateUnreadCount();
        const interval = setInterval(() => {
            void updateUnreadCount();
        }, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchUnreadCount]);

    // Fetch notifications when dropdown opens
    useEffect(() => {
        if (isOpen) {
            const loadNotifications = async () => {
                setIsLoading(true);
                try {
                    await fetchNotifications();
                } finally {
                    setIsLoading(false);
                }
            };

            void loadNotifications();
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
                    'p-1 rounded-md relative cursor-pointer',
                    'text-text-secondary dark:text-text-secondary-dark',
                    'hover:text-text dark:hover:text-text-dark',
                    'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                )}
            >
                <Bell className="w-3.5 h-3.5" />

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
                                <Bell
                                    className="w-12 h-12 mx-auto text-text-muted dark:text-text-muted-dark mb-3"
                                    strokeWidth={1.5}
                                />
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
