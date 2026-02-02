'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Notification, NotificationType } from '@/lib/api/notifications';
import { getPersistentNotifications, dismissNotification } from '@/app/actions/notifications';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface GlobalNotificationBannerProps {
    className?: string;
}

const POLL_INTERVAL = 60000; // 60 seconds for persistent notifications

const typeStyles: Record<
    NotificationType,
    { bg: string; text: string; border: string; icon: string }
> = {
    error: {
        bg: 'bg-red-50 dark:bg-red-900/30',
        text: 'text-red-800 dark:text-red-200',
        border: 'border-red-200 dark:border-red-800',
        icon: 'text-red-500 dark:text-red-400',
    },
    warning: {
        bg: 'bg-yellow-50 dark:bg-yellow-900/30',
        text: 'text-yellow-800 dark:text-yellow-200',
        border: 'border-yellow-200 dark:border-yellow-800',
        icon: 'text-yellow-500 dark:text-yellow-400',
    },
    info: {
        bg: 'bg-blue-50 dark:bg-blue-900/30',
        text: 'text-blue-800 dark:text-blue-200',
        border: 'border-blue-200 dark:border-blue-800',
        icon: 'text-blue-500 dark:text-blue-400',
    },
    success: {
        bg: 'bg-green-50 dark:bg-green-900/30',
        text: 'text-green-800 dark:text-green-200',
        border: 'border-green-200 dark:border-green-800',
        icon: 'text-green-500 dark:text-green-400',
    },
};

function BannerIcon({ type }: { type: NotificationType }) {
    const styles = typeStyles[type];

    if (type === 'error') {
        return (
            <svg
                className={cn('w-5 h-5 flex-shrink-0', styles.icon)}
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
                className={cn('w-5 h-5 flex-shrink-0', styles.icon)}
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

    return (
        <svg
            className={cn('w-5 h-5 flex-shrink-0', styles.icon)}
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

function NotificationBanner({
    notification,
    onDismiss,
    onAction,
    dismissLabel,
}: {
    notification: Notification;
    onDismiss: (id: string) => void;
    onAction: (url: string) => void;
    dismissLabel: string;
}) {
    const styles = typeStyles[notification.type];

    return (
        <div className={cn('px-4 py-3 border-b', styles.bg, styles.border)}>
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <BannerIcon type={notification.type} />
                    <div className="min-w-0">
                        <p className={cn('text-sm font-medium', styles.text)}>
                            {notification.title}
                        </p>
                        <p className={cn('text-sm', styles.text, 'opacity-90 truncate')}>
                            {notification.message}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                    {notification.actionUrl && notification.actionLabel && (
                        <button
                            onClick={() => onAction(notification.actionUrl!)}
                            className={cn(
                                'px-3 py-1.5 text-sm font-medium rounded-md',
                                'bg-white dark:bg-gray-800',
                                styles.text,
                                'border',
                                styles.border,
                                'hover:opacity-80 transition-opacity',
                            )}
                        >
                            {notification.actionLabel}
                        </button>
                    )}
                    {!notification.isPersistent && (
                        <button
                            onClick={() => onDismiss(notification.id)}
                            className={cn(
                                'p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10',
                                styles.text,
                            )}
                            title={dismissLabel}
                        >
                            <svg
                                className="w-5 h-5"
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
            </div>
        </div>
    );
}

export function GlobalNotificationBanner({ className }: GlobalNotificationBannerProps) {
    const t = useTranslations('common.ui');
    const router = useRouter();
    const [notifications, setNotifications] = useState<Notification[]>([]);

    const fetchPersistentNotifications = useCallback(async () => {
        try {
            const result = await getPersistentNotifications();
            if (result.success && result.notifications) {
                // Only show error and warning type persistent notifications in the banner
                const criticalNotifications = result.notifications.filter(
                    (n) => n.type === 'error' || n.type === 'warning',
                );
                setNotifications(criticalNotifications);
            }
        } catch (error) {
            console.error('Failed to fetch persistent notifications:', error);
        }
    }, []);

    useEffect(() => {
        fetchPersistentNotifications();

        const interval = setInterval(fetchPersistentNotifications, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchPersistentNotifications]);

    const handleDismiss = async (notificationId: string) => {
        const result = await dismissNotification(notificationId);
        if (result.success) {
            setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
        } else {
            toast.error(result.error || 'Failed to dismiss notification');
        }
    };

    const handleAction = (url: string) => {
        router.push(url);
    };

    if (notifications.length === 0) {
        return null;
    }

    return (
        <div className={cn('w-full', className)}>
            {notifications.map((notification) => (
                <NotificationBanner
                    key={notification.id}
                    notification={notification}
                    onDismiss={handleDismiss}
                    onAction={handleAction}
                    dismissLabel={t('dismiss')}
                />
            ))}
        </div>
    );
}
