'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { GenerateStatusType } from '@/lib/api/enums';

interface DirectoryStatsProps {
    directory: Directory;
    itemsCount: number;
    categoriesCount: number;
    tagsCount: number;
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
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <div className="flex items-center justify-between mb-4">
                <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', color)}>
                    {icon}
                </div>
                {trend && (
                    <span
                        className={cn(
                            'text-xs font-medium px-2 py-1 rounded',
                            trend.isPositive
                                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
                        )}
                    >
                        {trend.isPositive ? '+' : ''}
                        {trend.value}%
                    </span>
                )}
            </div>
            <div>
                <p className="text-2xl font-bold text-text dark:text-text-dark">{value}</p>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                    {title}
                </p>
            </div>
        </div>
    );
}

const generationStatusConfigs: Record<
    string,
    { iconPath: string; iconClass: string; color: string; label: string }
> = {
    [GenerateStatusType.GENERATED]: {
        iconPath: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
        iconClass: 'w-5 h-5 text-green-600 dark:text-green-400',
        color: 'bg-green-100 dark:bg-green-900',
        label: 'generated',
    },
    [GenerateStatusType.GENERATING]: {
        iconPath:
            'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
        iconClass: 'w-5 h-5 text-blue-600 dark:text-blue-400',
        color: 'bg-blue-100 dark:bg-blue-900',
        label: 'generating',
    },
    [GenerateStatusType.ERROR]: {
        iconPath: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
        iconClass: 'w-5 h-5 text-red-600 dark:text-red-400',
        color: 'bg-red-100 dark:bg-red-900',
        label: 'error',
    },
    [GenerateStatusType.CANCELLED]: {
        iconPath: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636',
        iconClass: 'w-5 h-5 text-gray-600 dark:text-gray-400',
        color: 'bg-gray-100 dark:bg-gray-900',
        label: 'cancelled',
    },
};

const defaultStatusConfig = {
    iconPath: 'M12 6v6m0 0v6m0-6h6m-6 0H6',
    iconClass: 'w-5 h-5 text-gray-600 dark:text-gray-400',
    color: 'bg-gray-100 dark:bg-gray-900',
    label: 'not started',
};

function getGenerationStatusStat(directory: Directory, t: ReturnType<typeof useTranslations>) {
    const status = directory.generateStatus?.status;
    const config = (status && generationStatusConfigs[status]) || defaultStatusConfig;

    return {
        title: t('generationStatus'),
        value: config.label,
        icon: (
            <svg className={config.iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={config.iconPath}
                />
            </svg>
        ),
        color: config.color,
    };
}

export function DirectoryStats({ categoriesCount, itemsCount, directory }: DirectoryStatsProps) {
    const t = useTranslations('dashboard.directoryDetail.stats');

    const stats = [
        {
            title: t('totalItems'),
            value: itemsCount,
            icon: (
                <svg
                    className="w-5 h-5 text-blue-600 dark:text-blue-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                </svg>
            ),
            color: 'bg-blue-100 dark:bg-blue-900',
        },
        {
            title: t('categories'),
            value: categoriesCount,
            icon: (
                <svg
                    className="w-5 h-5 text-purple-600 dark:text-purple-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                </svg>
            ),
            color: 'bg-purple-100 dark:bg-purple-900',
        },
        getGenerationStatusStat(directory, t),
        {
            title: t('daysActive'),
            value: Math.floor(
                (new Date().getTime() - new Date(directory.createdAt).getTime()) /
                    (1000 * 60 * 60 * 24),
            ),
            icon: (
                <svg
                    className="w-5 h-5 text-orange-600 dark:text-orange-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
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
