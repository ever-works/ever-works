'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { useTranslations } from 'next-intl';
import { Package, Tag, Clock, Scale } from 'lucide-react';

interface DirectoryStatsProps {
    directory: Directory;
    itemsCount: number;
    categoriesCount: number;
    tagsCount: number;
    comparisonsCount: number;
}

interface StatCardProps {
    title: string;
    value: string | number;
    icon: React.ReactNode;
    iconColor: string;
}

function StatCard({ title, value, icon, iconColor }: StatCardProps) {
    return (
        <div
            className={cn(
                'rounded-lg',
                'bg-card/10 dark:bg-card-primary-dark/30',
                'border border-card-border dark:border-border-secondary-dark',
                'w-full',
                'min-w-0',
            )}
        >
            <div
                className={cn(
                    'relative rounded-sm overflow-hidden h-full',
                    'min-w-0',
                    'bg-card dark:bg-card-primary-dark',
                    'border border-card-border dark:border-border-dark',
                    'px-3 py-2 sm:px-5 sm:py-2',
                )}
            >
                <p className="text-xs sm:text-sm text-text-muted dark:text-text-muted-dark">
                    {title}
                </p>
                <p className="text-xl sm:text-2xl font-bold text-text dark:text-text-dark mt-2 break-words whitespace-normal">
                    {value}
                </p>

                <div className="absolute top-2 sm:top-3 right-2 sm:right-3">
                    <span className={cn(iconColor, 'block')}>{icon}</span>
                </div>
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
        icon: <Icon className={cn('w-3 h-3 sm:w-4 sm:h-4', config.animate && 'animate-spin')} />,
        iconColor: config.stat.iconColor,
    };
}

export function DirectoryStats({
    categoriesCount,
    itemsCount,
    comparisonsCount,
    directory,
}: DirectoryStatsProps) {
    const t = useTranslations('dashboard.directoryDetail.stats');
    const tStatus = useTranslations('dashboard.directoryDetail.status');

    const stats = [
        {
            title: t('totalItems'),
            value: itemsCount,
            icon: <Package className="w-3 h-3 sm:w-4 sm:h-4" />,
            iconColor: 'text-blue-500',
        },
        {
            title: t('categories'),
            value: categoriesCount,
            icon: <Tag className="w-3 h-3 sm:w-4 sm:h-4" />,
            iconColor: 'text-violet-500',
        },
        {
            title: t('comparisons'),
            value: comparisonsCount,
            icon: <Scale className="w-3 h-3 sm:w-4 sm:h-4" />,
            iconColor: 'text-emerald-500',
        },
        getGenerationStatusStat(directory, t, tStatus),
        {
            title: t('daysActive'),
            value: Math.floor(
                (new Date().getTime() - new Date(directory.createdAt).getTime()) /
                    (1000 * 60 * 60 * 24),
            ),
            icon: <Clock className="w-3 h-3 sm:w-4 sm:h-4" />,
            iconColor: 'text-orange-500',
        },
    ];

    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4 w-full h-auto">
            {stats.map((stat) => (
                <StatCard
                    key={stat.title}
                    title={stat.title}
                    value={stat.value}
                    icon={stat.icon}
                    iconColor={stat.iconColor}
                />
            ))}
        </div>
    );
}
