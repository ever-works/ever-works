'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { useTranslations } from 'next-intl';
import { Package, Tag, Clock } from 'lucide-react';

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

function getGenerationStatusStat(
    directory: Directory,
    t: ReturnType<typeof useTranslations>,
    tStatus: ReturnType<typeof useTranslations>,
) {
    const hasWarnings = !!directory.generateStatus?.warnings?.length;
    const config = getGenerationStatusConfig(directory.generateStatus?.status, { hasWarnings });
    const Icon = config.icon;

    return {
        title: t('generationStatus'),
        value: tStatus(config.labelKey),
        icon: (
            <Icon
                className={cn('w-5 h-5', config.stat.iconColor, config.animate && 'animate-spin')}
            />
        ),
        color: config.stat.bgColor,
    };
}

export function DirectoryStats({ categoriesCount, itemsCount, directory }: DirectoryStatsProps) {
    const t = useTranslations('dashboard.directoryDetail.stats');
    const tStatus = useTranslations('dashboard.directoryDetail.status');

    const stats = [
        {
            title: t('totalItems'),
            value: itemsCount,
            icon: <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />,
            color: 'bg-blue-100 dark:bg-blue-900',
        },
        {
            title: t('categories'),
            value: categoriesCount,
            icon: <Tag className="w-5 h-5 text-purple-600 dark:text-purple-400" />,
            color: 'bg-purple-100 dark:bg-purple-900',
        },
        getGenerationStatusStat(directory, t, tStatus),
        {
            title: t('daysActive'),
            value: Math.floor(
                (new Date().getTime() - new Date(directory.createdAt).getTime()) /
                    (1000 * 60 * 60 * 24),
            ),
            icon: <Clock className="w-5 h-5 text-orange-600 dark:text-orange-400" />,
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
