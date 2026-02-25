'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { NOTIFICATION_TYPE_STYLES } from '@/lib/utils/notification-styles';
import { Notification, NotificationType } from '@/lib/api/notifications';
import { getPersistentNotifications, dismissNotification } from '@/app/actions/notifications';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { X } from 'lucide-react';

interface GlobalNotificationBannerProps {
    className?: string;
}

const POLL_INTERVAL = 60000; // 60 seconds for persistent notifications

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
    const styles = NOTIFICATION_TYPE_STYLES[notification.type];
    const TypeIcon = styles.icon;

    return (
        <div className={cn('px-4 py-3 border-b', styles.banner.bg, styles.banner.border)}>
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                    <TypeIcon className={cn('w-5 h-5 shrink-0', styles.iconColor)} />
                    <div className="min-w-0">
                        <p className={cn('text-sm font-medium', styles.banner.text)}>
                            {notification.title}
                        </p>
                        <p className={cn('text-sm', styles.banner.text, 'opacity-90 truncate')}>
                            {notification.message}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    {notification.actionUrl && notification.actionLabel && (
                        <button
                            onClick={() => onAction(notification.actionUrl!)}
                            className={cn(
                                'px-3 py-1.5 text-sm font-medium rounded-md',
                                'bg-white dark:bg-gray-800',
                                styles.banner.text,
                                'border',
                                styles.banner.border,
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
                                styles.banner.text,
                            )}
                            title={dismissLabel}
                        >
                            <X className="w-5 h-5" />
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
