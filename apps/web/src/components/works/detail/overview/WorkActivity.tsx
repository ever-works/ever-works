'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface WorkActivityProps {
    workId: string;
}

interface ActivityItem {
    id: string;
    type: 'created' | 'generated' | 'updated' | 'error';
    title: string;
    description: string;
    timestamp: Date;
}

export function WorkActivity({ workId }: WorkActivityProps) {
    const t = useTranslations('dashboard.workDetail.activity');

    // Mock activity data - in real app would fetch from API
    const activities: ActivityItem[] = [
        {
            id: '1',
            type: 'created',
            title: t('created'),
            description: t('workCreated'),
            timestamp: new Date(),
        },
    ];

    const getActivityIcon = (type: ActivityItem['type']) => {
        switch (type) {
            case 'created':
                return (
                    <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                        <svg
                            className="w-4 h-4 text-green-600 dark:text-green-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 4v16m8-8H4"
                            />
                        </svg>
                    </div>
                );
            case 'generated':
                return (
                    <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                        <svg
                            className="w-4 h-4 text-blue-600 dark:text-blue-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M13 10V3L4 14h7v7l9-11h-7z"
                            />
                        </svg>
                    </div>
                );
            case 'updated':
                return (
                    <div className="w-8 h-8 rounded-full bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center">
                        <svg
                            className="w-4 h-4 text-yellow-600 dark:text-yellow-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                        </svg>
                    </div>
                );
            case 'error':
                return (
                    <div className="w-8 h-8 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                        <svg
                            className="w-4 h-4 text-red-600 dark:text-red-400"
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
                    </div>
                );
        }
    };

    const formatTimestamp = (date: Date) => {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return t('justNow');
    };

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                {t('title')}
            </h3>

            {activities.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark text-center py-8">
                    {t('noActivity')}
                </p>
            ) : (
                <div className="space-y-4">
                    {activities.map((activity) => (
                        <div key={activity.id} className="flex gap-3">
                            {getActivityIcon(activity.type)}
                            <div className="flex-1">
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {activity.title}
                                </p>
                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {activity.description}
                                </p>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                    {formatTimestamp(activity.timestamp)}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
