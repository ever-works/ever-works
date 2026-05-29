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
            iconColor: 'text-amber-500',
            dotColor: 'bg-amber-500',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_MISSIONS,
        },
        {
            title: t('totalIdeas'),
            value: totalIdeas,
            icon: Lightbulb,
            iconColor: 'text-yellow-500',
            dotColor: 'bg-yellow-500',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_IDEAS,
        },
        {
            title: t('totalWorks'),
            value: totalWorks,
            icon: FolderClosed,
            iconColor: 'text-blue-500',
            dotColor: 'bg-blue-500',
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
            iconColor: 'text-primary',
            dotColor: 'bg-primary',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_AGENTS,
            sublabel: t('agentsActive', { count: agentsActive }),
        },
        {
            title: t('tasksInFlight'),
            value: tasksInProgress,
            icon: ListChecks,
            iconColor: 'text-info',
            dotColor: 'bg-info',
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
        <div className="grid grid-cols-2 @xl/main:grid-cols-4 gap-3">
            {statCards.map((stat) => {
                const tileBody = (
                    <div
                        className={cn(
                            'group relative flex flex-col gap-4 rounded-xl px-4 py-4 h-full overflow-hidden',
                            'bg-card dark:bg-surface-secondary-dark',
                            'border border-card-border dark:border-border-dark',
                            'transition-all duration-200',
                            stat.href &&
                                'hover:border-primary/30 dark:hover:border-white/15 hover:shadow-sm',
                        )}
                    >
                        {/* Decorative top-center glow accent */}
                        <div className="card-top-accent pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 w-2/5 h-px z-10 opacity-30 rounded-full" />

                        {/* Icon + Value */}
                        <div className="flex items-end gap-2 min-w-0">
                            <div
                                className={cn(
                                    'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                                    'bg-surface dark:bg-white/6',
                                )}
                            >
                                <stat.icon
                                    className={cn('w-4 h-4', stat.iconColor)}
                                    strokeWidth={1.4}
                                />
                            </div>
                            <p className="text-2xl font-semibold tracking-tight tabular-nums text-text dark:text-text-dark leading-none truncate">
                                {stat.value}
                            </p>
                        </div>

                        {/* Label */}
                        <div className="min-w-0">
                            <div className="mt-2 flex items-center gap-1.5">
                                <span
                                    className={cn('w-1.5 h-1.5 rounded-full shrink-0', stat.dotColor)}
                                />
                                <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                    {stat.title}
                                </p>
                            </div>
                            {stat.sublabel ? (
                                <p className="mt-0.5 pl-3 text-[11px] text-text-muted dark:text-text-muted-dark truncate opacity-70">
                                    {stat.sublabel}
                                </p>
                            ) : null}
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
