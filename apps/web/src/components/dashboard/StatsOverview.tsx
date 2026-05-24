'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { FolderClosed, ListTodo, Globe, Target, Lightbulb, type LucideIcon } from 'lucide-react';

interface StatsOverviewProps {
    totalWorks?: number;
    totalItems?: number;
    activeWebsites?: number;
    /**
     * Phase 2 PR F — Missions/Ideas/Works v6 spec §5.1.
     * New Dashboard tiles, rendered in this order (LEFT to RIGHT):
     *   [Missions] [Ideas] [Works] [Items] [Sites]
     * Each defaults to 0 so existing call sites that haven't been
     * updated still render (showing 0 instead of crashing).
     */
    totalMissions?: number;
    totalIdeas?: number;
}

export function StatsOverview({
    totalWorks = 0,
    totalItems = 0,
    activeWebsites = 0,
    totalMissions = 0,
    totalIdeas = 0,
}: StatsOverviewProps) {
    const t = useTranslations('dashboard.stats');

    const statCards: Array<{
        title: string;
        value: string | number;
        icon: LucideIcon;
        change: string;
        changeType: 'positive' | 'negative' | 'neutral';
        iconColor?: string;
        dotColor?: string;
    }> = [
        // Phase 2 PR F — new tiles FIRST, in spec §5.1 order.
        {
            title: t('totalMissions'),
            value: totalMissions,
            icon: Target,
            iconColor: 'text-amber-500',
            dotColor: 'bg-amber-500',
            change: '+0%',
            changeType: 'neutral',
        },
        {
            title: t('totalIdeas'),
            value: totalIdeas,
            icon: Lightbulb,
            iconColor: 'text-yellow-500',
            dotColor: 'bg-yellow-500',
            change: '+0%',
            changeType: 'neutral',
        },
        {
            title: t('totalWorks'),
            value: totalWorks,
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
        // Phase 2 PR F — grid now sized for 5 tiles. The @5xl breakpoint
        // shows all 5 in a row on wide screens; smaller breakpoints
        // wrap gracefully (3 then 2 then 1 per row).
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 @5xl/main:grid-cols-5 gap-6">
            {statCards.map((stat) => (
                <div
                    key={stat.title}
                    className={cn(
                        'group relative rounded-md p-1 transition-shadow duration-200 overflow-hidden',
                        'border border-card-border dark:border-border-dark',
                    )}
                >
                    <div
                        className={cn(
                            'group relative rounded-sm p-5 transition-shadow duration-200 overflow-hidden',
                            'bg-card dark:bg-surface-secondary-dark',
                            'border border-card-border dark:border-border-dark',
                        )}
                    >
                        {/* Decorative short top border accent with fading edges */}
                        <div className="card-top-accent pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 w-1/2 h-px z-20 opacity-40 rounded-full" />

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
                            <p className="text-3xl text-text dark:text-text-dark truncate">
                                {stat.value}
                            </p>
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
                </div>
            ))}
        </div>
    );
}
