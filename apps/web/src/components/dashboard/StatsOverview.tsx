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
    Users,
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
    /**
     * Dashboard blocks (spec §4.1, change 1) — Teams count for the 9th
     * tile. Optional on purpose: the Teams API lands with the Teams
     * feature (PR #1647), so until it is wired this is `undefined` and
     * the tile is omitted entirely (the grid falls back to 8 tiles).
     * It lights up automatically once Teams merges.
     */
    teamsTotal?: number;
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
    teamsTotal,
}: StatsOverviewProps) {
    const t = useTranslations('dashboard.stats');

    const statCards: Array<{
        title: string;
        value: string | number;
        icon: LucideIcon;
        change: string;
        changeType: 'positive' | 'negative' | 'neutral';
        dotColor: string;
        /** When set, the tile renders as a Link. */
        href?: string;
        /**
         * Dashboard blocks (spec §4.2) — the parenthetical fact folded
         * inline onto the subtitle line (e.g. `Agents (0 active)`).
         * Optional decoration; a tile without one is still exactly two
         * lines, so qualified and unqualified tiles share a height.
         */
        qualifier?: string;
    }> = [
        {
            title: t('totalMissions'),
            value: totalMissions,
            icon: Target,
            dotColor: 'bg-amber-500',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_MISSIONS,
        },
        {
            title: t('totalIdeas'),
            value: totalIdeas,
            icon: Lightbulb,
            dotColor: 'bg-yellow-500',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_IDEAS,
        },
        {
            title: t('totalWorks'),
            value: totalWorks,
            icon: FolderClosed,
            dotColor: 'bg-blue-500',
            change: '+12%',
            changeType: 'positive',
            href: ROUTES.DASHBOARD_WORKS,
        },
        {
            title: t('totalItems'),
            value: totalItems,
            icon: ListTodo,
            dotColor: 'bg-violet-500',
            change: '+23%',
            changeType: 'positive',
        },
        {
            title: t('activeWebsites'),
            value: activeWebsites,
            icon: Globe,
            dotColor: 'bg-emerald-500',
            change: '0%',
            changeType: 'neutral',
        },
        {
            title: t('monthSpend'),
            value: formatMoney(monthSpendCents, monthSpendCurrency),
            icon: Wallet,
            dotColor: 'bg-rose-500',
            change: '+0%',
            changeType: 'neutral',
            href: '/settings/work-agent#account-budgets',
        },
        {
            title: t('agents'),
            value: agentsTotal,
            icon: Bot,
            dotColor: 'bg-primary',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_AGENTS,
            qualifier: t('agentsActive', { count: agentsActive }),
        },
        {
            title: t('tasksInFlight'),
            value: tasksInProgress,
            icon: ListChecks,
            dotColor: 'bg-info',
            change: '+0%',
            changeType: 'neutral',
            href: ROUTES.DASHBOARD_TASKS,
            // When there are blockers, keep the `(N blocked)` qualifier;
            // a healthy tile stays clean as plain "Tasks in flight" (no
            // `(no blockers)` filler — spec §4.2).
            qualifier: tasksBlocked > 0 ? t('tasksBlocked', { count: tasksBlocked }) : undefined,
        },
        // Dashboard blocks (spec §4.1, change 1) — 9th tile: Teams count
        // for the active Organization. Guarded so it only appears once
        // the Teams feature (PR #1647) wires `teamsTotal`; while it is
        // `undefined` the grid stays at 8 tiles. Route constant
        // `ROUTES.DASHBOARD_TEAMS` also lands with that PR, so the href
        // is inlined here (same pattern as the Month Spend tile).
        ...(teamsTotal !== undefined
            ? [
                  {
                      title: t('teams'),
                      value: teamsTotal,
                      icon: Users,
                      dotColor: 'bg-teal-500',
                      change: '+0%',
                      changeType: 'neutral' as const,
                      href: '/teams',
                  },
              ]
            : []),
    ];

    return (
        <div className="grid grid-cols-2 @xl/main:grid-cols-4 gap-3">
            {statCards.map((stat) => {
                const tileBody = (
                    <div
                        className={cn(
                            'group relative flex flex-col gap-1.5 rounded-xl px-3 py-3 h-full overflow-hidden',
                            'bg-card dark:bg-surface-secondary-dark',
                            'border border-card-border dark:border-border-dark',
                            'transition-all duration-200',
                            stat.href &&
                                'hover:border-primary/30 dark:hover:border-white/15 hover:shadow-sm',
                        )}
                    >
                        {/* Decorative top-center glow accent */}
                        <div className="card-top-accent pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 w-2/5 h-px z-10 opacity-30 rounded-full" />

                        {/* Line 1 — icon + value */}
                        <div className="flex items-end gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-surface-secondary dark:bg-white/6 border border-border/40 dark:border-white/8">
                                <stat.icon
                                    className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark"
                                    strokeWidth={1.4}
                                />
                            </div>
                            <p className="text-xl font-semibold tracking-tight tabular-nums text-text dark:text-text-dark leading-none truncate">
                                {stat.value}
                            </p>
                        </div>

                        {/* Line 2 — dot + subtitle (qualifier inline, never a 3rd line) */}
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span
                                className={cn('w-1.5 h-1.5 rounded-full shrink-0', stat.dotColor)}
                            />
                            <p className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                {stat.title}
                                {stat.qualifier ? (
                                    <span className="opacity-70"> ({stat.qualifier})</span>
                                ) : null}
                            </p>
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
