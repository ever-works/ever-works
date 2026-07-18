'use client';

import {
    AlertTriangle,
    Ban,
    Bot,
    CalendarClock,
    FileWarning,
    PauseCircle,
    Wallet,
    type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { AttentionItem, AttentionKind } from './dashboard-signals.types';

/**
 * Dashboard blocks (spec §4.3, change 3) — the Attention block. Red
 * signal cards sitting ABOVE the Missions list, surfacing the things
 * that need the user's action right now: errored agents, failed or
 * paused schedules, failed generations, blocked tasks, blown budgets.
 *
 * Server-composed (`composeAttentionItems`) and passed in as a prop —
 * no client fetch. The block is self-suppressing: it returns `null`
 * when there is nothing to show, and the wrapper in `dashboard-client`
 * is itself gated so no divider/gap appears for a healthy account.
 */

const KIND_ICON: Record<AttentionKind, LucideIcon> = {
    'agent-error': Bot,
    'schedule-failed': CalendarClock,
    'schedule-paused': PauseCircle,
    'generation-failed': FileWarning,
    'task-blocked': Ban,
    'budget-exceeded': Wallet,
};

const KIND_COPY: Record<AttentionKind, { titleKey: string; subtitleKey: string }> = {
    'agent-error': { titleKey: 'kinds.agentError.title', subtitleKey: 'kinds.agentError.subtitle' },
    'schedule-failed': {
        titleKey: 'kinds.scheduleFailed.title',
        subtitleKey: 'kinds.scheduleFailed.subtitle',
    },
    'schedule-paused': {
        titleKey: 'kinds.schedulePaused.title',
        subtitleKey: 'kinds.schedulePaused.subtitle',
    },
    'generation-failed': {
        titleKey: 'kinds.generationFailed.title',
        subtitleKey: 'kinds.generationFailed.subtitle',
    },
    'task-blocked': {
        titleKey: 'kinds.taskBlocked.title',
        subtitleKey: 'kinds.taskBlocked.subtitle',
    },
    'budget-exceeded': {
        titleKey: 'kinds.budgetExceeded.title',
        subtitleKey: 'kinds.budgetExceeded.subtitle',
    },
};

export function AttentionSection({ items }: { items: AttentionItem[] }) {
    const t = useTranslations('dashboard.attention');
    // The per-kind copy keys are resolved dynamically, so bypass
    // next-intl's literal-key typing with a loose translator. The runtime
    // call is unchanged; only the compile-time key check is relaxed.
    const tx = t as unknown as (key: string, values?: Record<string, string>) => string;

    // Non-empty guard — a quiet dashboard for a healthy account.
    if (items.length === 0) {
        return null;
    }

    return (
        <section aria-labelledby="dashboard-attention-heading" data-testid="dashboard-attention">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-danger/10 border border-danger/25 flex items-center justify-center">
                        <AlertTriangle className="w-4 h-4 text-danger" />
                    </div>
                    <h2
                        id="dashboard-attention-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('title')}
                    </h2>
                </div>
            </div>

            <div className="grid grid-cols-1 @lg/main:grid-cols-2 gap-3">
                {items.map((item) => {
                    const copy = KIND_COPY[item.kind];
                    // Always pass `name`; messages without the placeholder ignore it.
                    const name = item.label ?? '';
                    return (
                        <AttentionCard
                            key={item.id}
                            item={item}
                            title={tx(copy.titleKey, { name })}
                            subtitle={tx(copy.subtitleKey, { name })}
                        />
                    );
                })}
            </div>
        </section>
    );
}

function AttentionCard({
    item,
    title,
    subtitle,
}: {
    item: AttentionItem;
    title: string;
    subtitle: string;
}) {
    const Icon = KIND_ICON[item.kind];
    const isDanger = item.severity === 'danger';

    return (
        <Link
            href={item.href}
            className={cn(
                'group flex items-start gap-3 rounded-xl p-3.5 no-underline border transition-colors duration-150',
                isDanger
                    ? 'border-danger/30 bg-danger/5 hover:border-danger/50'
                    : 'border-warning/30 bg-warning/8 hover:border-warning/50',
            )}
        >
            <div
                className={cn(
                    'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
                    isDanger ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning',
                )}
            >
                <Icon className="w-4 h-4" strokeWidth={1.6} />
            </div>
            <div className="min-w-0">
                <p
                    className={cn(
                        'text-sm font-medium leading-snug truncate',
                        isDanger ? 'text-danger' : 'text-warning',
                    )}
                >
                    {title}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {subtitle}
                </p>
            </div>
        </Link>
    );
}
