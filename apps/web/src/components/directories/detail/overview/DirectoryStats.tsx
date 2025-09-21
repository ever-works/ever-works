'use client';

import { Directory } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';

interface DirectoryStatsProps {
    directory: Directory;
}

interface StatCardProps {
    title: string;
    value: string | number;
    icon: React.ReactNode;
    trend?: {
        value: number;
        isPositive: boolean;
    };
    color: string;
}

function StatCard({ title, value, icon, trend, color }: StatCardProps) {
    return (
        <div className={cn(
            'rounded-lg border p-6',
            'bg-card dark:bg-card-dark',
            'border-card-border dark:border-card-border-dark',
        )}>
            <div className="flex items-center justify-between mb-4">
                <div className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    color,
                )}>
                    {icon}
                </div>
                {trend && (
                    <span className={cn(
                        'text-xs font-medium px-2 py-1 rounded',
                        trend.isPositive
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
                    )}>
                        {trend.isPositive ? '+' : ''}{trend.value}%
                    </span>
                )}
            </div>
            <div>
                <p className="text-2xl font-bold text-text dark:text-text-dark">
                    {value}
                </p>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                    {title}
                </p>
            </div>
        </div>
    );
}

export function DirectoryStats({ directory }: DirectoryStatsProps) {
    const t = useTranslations('dashboard.directoryDetail.stats');
    // @ts-ignore - items_count will be added to Directory type later
    const itemsCount = directory.items_count || 0;

    const stats = [
        {
            title: t('totalItems'),
            value: itemsCount,
            icon: (
                <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
            ),
            color: 'bg-blue-100 dark:bg-blue-900',
        },
        {
            title: t('categories'),
            value: 0, // Will be calculated from items
            icon: (
                <svg className="w-5 h-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
            ),
            color: 'bg-purple-100 dark:bg-purple-900',
        },
        {
            title: t('generationStatus'),
            value: directory.generateStatus?.status || 'Not Started',
            icon: (
                <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            ),
            color: 'bg-green-100 dark:bg-green-900',
        },
        {
            title: t('daysActive'),
            value: Math.floor((new Date().getTime() - new Date(directory.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
            icon: (
                <svg className="w-5 h-5 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            ),
            color: 'bg-orange-100 dark:bg-orange-900',
        },
    ];

    return (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((stat) => (
                <StatCard
                    key={stat.title}
                    title={stat.title}
                    value={stat.value}
                    icon={stat.icon}
                    color={stat.color}
                />
            ))}
        </div>
    );
}