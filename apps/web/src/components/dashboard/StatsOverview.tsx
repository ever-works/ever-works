'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { FolderClosed, ListTodo, Globe } from 'lucide-react';

interface StatsOverviewProps {
    totalDirectories?: number;
    totalItems?: number;
    activeWebsites?: number;
}

export function StatsOverview({
    totalDirectories = 0,
    totalItems = 0,
    activeWebsites = 0,
}: StatsOverviewProps) {
    const t = useTranslations('dashboard.stats');

    const statCards: Array<{
        title: string;
        value: string | number;
        icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
        change: string;
        changeType: 'positive' | 'negative' | 'neutral';
        iconColor: string;
        dotColor: string;
    }> = [
        {
            title: t('totalDirectories'),
            value: totalDirectories,
            icon: FolderClosed,
            iconColor: 'text-blue-500',
            dotColor: 'bg-blue-500',
            change: '+12%',
            changeType: 'positive',
        },
        {
            title: t('totalItems'),
            value: totalItems,
            icon: ListTodo,
            iconColor: 'text-violet-500',
            dotColor: 'bg-violet-500',
            change: '+23%',
            changeType: 'positive',
        },
        {
            title: t('activeWebsites'),
            value: activeWebsites,
            icon: Globe,
            iconColor: 'text-emerald-500',
            dotColor: 'bg-emerald-500',
            change: '0%',
            changeType: 'neutral',
        },
    ];

    return (
        <div className="grid grid-cols-1 dark:bg-white/2 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-6 border border-card-border dark:border-border-dark rounded-lg p-5">
            {statCards.map((stat) => (
                <div
                    key={stat.title}
                    className={cn(
                        'group relative transition-shadow duration-200 overflow-hidden',
                        '',
                    )}
                >
                    <div className="flex items-end space-x-2">
                        <div
                            className={cn(
                                'rounded-md w-8 h-8 flex items-center justify-center',
                                'bg-surface dark:bg-white/6',
                            )}
                        >
                            <stat.icon
                                className={cn('w-4.5 h-4.5', stat.iconColor)}
                                strokeWidth={1.3}
                            />
                        </div>
                        <p className="text-3xl text-text dark:text-text-dark">{stat.value}</p>
                    </div>
                    <div className="mt-1 flex items-center space-x-2">
                        <div className={cn('w-1 h-1 rounded-full mt-0.5', stat.dotColor)} />
                        <p className="text-xs text-gray-500 dark:text-text-muted-dark">
                            {stat.title}
                        </p>
                    </div>
                    <div className="mt-4 items-center hidden">
                        <span
                            className={cn(
                                'text-sm font-medium',
                                stat.changeType === 'positive' && 'text-success',
                                stat.changeType === 'negative' && 'text-danger',
                                stat.changeType === 'neutral' &&
                                    'text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {stat.change}
                        </span>
                        <span className="text-sm text-text-muted dark:text-text-muted-dark ml-2">
                            {t('fromLastMonth')}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}
