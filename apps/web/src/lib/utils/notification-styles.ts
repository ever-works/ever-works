import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import type { NotificationType } from '@/lib/api/notifications';

export interface NotificationTypeStyle {
    icon: LucideIcon;
    iconColor: string;
    dropdown: { bg: string; border: string };
    banner: { bg: string; text: string; border: string };
}

export const NOTIFICATION_TYPE_STYLES: Record<NotificationType, NotificationTypeStyle> = {
    info: {
        icon: Info,
        iconColor: 'text-blue-500 dark:text-blue-400',
        dropdown: {
            bg: 'bg-blue-50 dark:bg-blue-900/20',
            border: 'border-l-blue-500',
        },
        banner: {
            bg: 'bg-blue-50 dark:bg-blue-900/30',
            text: 'text-blue-800 dark:text-blue-200',
            border: 'border-blue-200 dark:border-blue-800',
        },
    },
    warning: {
        icon: AlertTriangle,
        iconColor: 'text-yellow-500 dark:text-yellow-400',
        dropdown: {
            bg: 'bg-yellow-50 dark:bg-yellow-900/20',
            border: 'border-l-yellow-500',
        },
        banner: {
            bg: 'bg-yellow-50 dark:bg-yellow-900/30',
            text: 'text-yellow-800 dark:text-yellow-200',
            border: 'border-yellow-200 dark:border-yellow-800',
        },
    },
    error: {
        icon: AlertCircle,
        iconColor: 'text-red-500 dark:text-red-400',
        dropdown: {
            bg: 'bg-red-50 dark:bg-red-900/20',
            border: 'border-l-red-500',
        },
        banner: {
            bg: 'bg-red-50 dark:bg-red-900/30',
            text: 'text-red-800 dark:text-red-200',
            border: 'border-red-200 dark:border-red-800',
        },
    },
    success: {
        icon: CheckCircle2,
        iconColor: 'text-green-500 dark:text-green-400',
        dropdown: {
            bg: 'bg-green-50 dark:bg-green-900/20',
            border: 'border-l-green-500',
        },
        banner: {
            bg: 'bg-green-50 dark:bg-green-900/30',
            text: 'text-green-800 dark:text-green-200',
            border: 'border-green-200 dark:border-green-800',
        },
    },
};
