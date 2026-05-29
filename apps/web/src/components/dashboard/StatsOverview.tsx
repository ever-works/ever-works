'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import {
    Bot,
    FolderClosed,
    Globe,
    Lightbulb,
    ListChecks,
    ListTodo,
    Target,
    Wallet,
    type LucideIcon,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface StatsOverviewProps {
    totalWorks?: number;
    totalItems?: number;
    activeWebsites?: number;
    /**
     * Phase 2 PR F — Missions/Ideas/Works v6 spec §5.1.
     * Dashboard tiles, rendered in this order (LEFT to RIGHT):
     *   [Missions] [Ideas] [Works] [Items] [Sites] [Month Spend]
     *   [Agents] [Tasks in flight]
     * Each defaults to 0 so existing call sites that haven't been
     * updated still render (showing 0 instead of crashing).
     *
     * Phase 7 PR II added the 6th `Month Spend` tile, which is a
     * Link clicking through to `/settings/work-agent#account-budgets`
     * so the user can adjust the account-wide cap in one place.
     *
     * Dashboard polish (2026-05-27) — Agents + Tasks-in-flight folded
     * into the same grid as the other 6 so all 8 share a single row
     * when the chat panel is collapsed (`@7xl/main` and up). Replaces
     * the previous Phase 18.1 standalone tile row.
     */
    totalMissions?: number;
    totalIdeas?: number;
    /** Phase 7 PR II — current-month account-wide spend in cents. */
    monthSpendCents?: number;
    /** Phase 7 PR II — currency for monthSpendCents (default 'usd'). */
    monthSpendCurrency?: string;
    agentsTotal?: number;
    agentsActive?: number;
    tasksInProgress?: number;
    tasksBlocked?: number;
}

function formatMoney(cents: number, currency: string): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
            maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
        }).format(cents / 100);
    } catch {
        return `$${(cents / 100).toFixed(2)}`;
    }
}

export function StatsOverview({
    totalWorks = 0,
    totalItems = 0,
    activeWebsites = 0,
    totalMissions = 0,
    totalIdeas = 0,
    monthSpendCents = 0,
    monthSpendCurrency = 'usd',
    agentsTotal = 0,
    agentsActive = 0,
    tasksInProgress = 0,
    tasksBlocked = 0,
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
        /** When set, the tile renders as a Link. */
        href?: string;
        /** Optional secondary line under the title (e.g. "2 active"). */
        sublabel?: string;
    }> = [
        {
            title: t('totalMissions'),
            value: totalMissions,
            icon: Target,
            iconColor: 'text-concept-missions',
            dotColor: 'bg-concept-missions',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_MISSIONS,
        },
        {
            title: t('totalIdeas'),
            value: totalIdeas,
            icon: Lightbulb,
            iconColor: 'text-concept-ideas',
            dotColor: 'bg-concept-ideas',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_IDEAS,
        },
        {
            title: t('totalWorks'),
            value: totalWorks,
            icon: FolderClosed,
            iconColor: 'text-concept-works',
            dotColor: 'bg-concept-works',
            change: '+12%',
            changeType: 'positive',
            href: ROUTES.DASHBOARD_WORKS,
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
        {
            title: t('monthSpend'),
            value: formatMoney(monthSpendCents, monthSpendCurrency),
            icon: Wallet,
            iconColor: 'text-rose-500',
            dotColor: 'bg-rose-500',
            change: '+0%',
            changeType: 'neutral',
            href: '/settings/work-agent#account-budgets',
        },
        {
            title: t('agents'),
            value: agentsTotal,
            icon: Bot,
            iconColor: 'text-concept-agents',
            dotColor: 'bg-concept-agents',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_AGENTS,
            sublabel: t('agentsActive', { count: agentsActive }),
        },
        {
            title: t('tasksInFlight'),
            value: tasksInProgress,
            icon: ListChecks,
            iconColor: 'text-concept-tasks',
            dotColor: 'bg-concept-tasks',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_TASKS,
            sublabel:
                tasksBlocked > 0
                    ? t('tasksBlocked', { count: tasksBlocked })
                    : t('tasksNoBlockers'),
        },
    ];

    return (
        // 8 tiles. Grid shapes itself to the available width:
        //   1 col on the narrowest viewport.
        //   2 cols starting at @lg.
        //   4 cols starting at @3xl — typical width when the chat
        //     panel is open (two rows of four).
        //   8 cols starting at @7xl — the chat panel is collapsed
        //     and the main column has room for a single row of eight.
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-4 @7xl/main:grid-cols-8 gap-4">
            {statCards.map((stat) => {
                const tileBody = (
                    <div
                        className={cn(
                            'group relative rounded-md p-1 transition-shadow duration-200 overflow-hidden h-full',
                            'border border-card-border dark:border-border-dark',
                            stat.href && 'hover:border-primary-500/50 dark:hover:border-white/20',
                        )}
                    >
                        <div
                            className={cn(
                                'group relative rounded-sm p-5 transition-shadow duration-200 overflow-hidden h-full',
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
                                <p className="text-xs text-gray-500 dark:text-text-muted-dark truncate">
                                    {stat.title}
                                </p>
                            </div>
                            {stat.sublabel ? (
                                <p className="mt-1 ml-3 text-[11px] text-text-muted dark:text-text-muted-dark truncate">
                                    {stat.sublabel}
                                </p>
                            ) : null}
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
                );
                if (stat.href) {
                    return (
                        <Link key={stat.title} href={stat.href} className="block no-underline">
                            {tileBody}
                        </Link>
                    );
                }
                return <div key={stat.title}>{tileBody}</div>;
            })}
        </div>
    );
}
