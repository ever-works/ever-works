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
                'p-1 rounded-lg min-w-[200px]',
                'bg-card/10 dark:bg-card-primary-dark/30',
                'border border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div
                className={cn(
                    'relative rounded-sm px-5 py-2 overflow-hidden h-full',
                    'bg-card dark:bg-card-primary-dark',
                    'border border-card-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{title}</p>
                <p className="text-2xl font-bold text-text dark:text-text-dark mt-2 truncate">
                    {value}
                </p>

                <div className="absolute top-3 right-3">
                    <span className={iconColor}>{icon}</span>
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
        icon: <Icon className={cn('w-4 h-4', config.animate && 'animate-spin')} />,
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
            icon: <Package className="w-4 h-4" />,
            iconColor: 'text-blue-500',
        },
        {
            title: t('categories'),
            value: categoriesCount,
            icon: <Tag className="w-4 h-4" />,
            iconColor: 'text-violet-500',
        },
        {
            title: t('comparisons'),
            value: comparisonsCount,
            icon: <Scale className="w-4 h-4" />,
            iconColor: 'text-emerald-500',
        },
        getGenerationStatusStat(directory, t, tStatus),
        {
            title: t('daysActive'),
            value: Math.floor(
                (new Date().getTime() - new Date(directory.createdAt).getTime()) /
                    (1000 * 60 * 60 * 24),
            ),
            icon: <Clock className="w-4 h-4" />,
            iconColor: 'text-orange-500',
        },
    ];

    return (
        <div className="flex flex-wrap gap-4">
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