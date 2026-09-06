'use client';

import { ChevronRight, Gauge, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { StatusPill } from '@/components/work-agent';
import type { Goal } from '@/lib/api/goals';
import {
    COMPARATOR_GLYPH,
    GoalKindBadge,
    OutcomeBadge,
    formatMetricValue,
    formatDateTime,
} from './goal-ui';
import { DodProgressBar, DodRollup } from './goal-loop-ui';

/**
 * Goals & Metrics — PR-8. Read-only summary card for a single Goal in
 * the `/goals` list grid. Whole card links to the Goal detail page.
 *
 * A METRIC Goal surfaces the current-vs-target progress with a comparator
 * glyph (≥/≤) and its aggregation window; a DELIVERY Goal (self-build
 * slice AG) has no metric, so the same slot carries the Definition-of-Done
 * rollup instead and the window line is dropped. Both show the lifecycle
 * status pill, the kind badge, the terminal outcome badge when set, and
 * the next scheduled check for active Goals.
 */
export function GoalCard({ goal }: { goal: Goal }) {
    const t = useTranslations('dashboard.goalsPage.card');
    const isDelivery = goal.goalKind === 'delivery';
    const unit = goal.unit ?? undefined;

    return (
        <Link
            href={`/goals/${goal.id}`}
            className={cn(
                'group relative flex min-h-[12rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
                'no-underline',
            )}
        >
            <div className="flex items-start gap-3 mb-3 pr-6 min-w-0">
                <div className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-info/10 border border-info/20">
                    <Gauge strokeWidth={1.4} className="w-4 h-4 text-info" />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                        {goal.title}
                    </h3>
                    {goal.description ? (
                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark line-clamp-2">
                            {goal.description}
                        </p>
                    ) : null}
                </div>
                <ChevronRight className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>

            {isDelivery ? (
                /* Delivery: the Definition of Done IS the progress. */
                <div className="mb-3 space-y-2 rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 px-3 py-2">
                    <DodRollup summary={goal.dodSummary} />
                    <DodProgressBar summary={goal.dodSummary} />
                </div>
            ) : (
                /* Metric: current vs target with comparator glyph. */
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-border/50 dark:border-border-dark/50 bg-surface/40 dark:bg-surface-dark/30 px-3 py-2">
                    <span className="text-sm font-semibold text-text dark:text-text-dark tabular-nums truncate">
                        {formatMetricValue(goal.currentValue, unit)}
                    </span>
                    <span
                        className="text-sm font-semibold text-info shrink-0"
                        aria-label={
                            goal.comparator ? t(`comparator.${goal.comparator}`) : undefined
                        }
                        title={goal.comparator ? t(`comparator.${goal.comparator}`) : undefined}
                    >
                        {goal.comparator ? COMPARATOR_GLYPH[goal.comparator] : '—'}
                    </span>
                    <span className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark tabular-nums truncate">
                        {formatMetricValue(goal.targetValue, unit)}
                    </span>
                </div>
            )}

            <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill status={goal.status} />
                <GoalKindBadge kind={goal.goalKind} />
                {goal.outcome ? <OutcomeBadge outcome={goal.outcome} /> : null}
            </div>

            <div className="mt-auto text-xs text-text-muted dark:text-text-muted-dark space-y-0.5">
                {goal.status === 'active' && goal.nextCheckAt ? (
                    <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('nextCheckPrefix')}
                        </span>{' '}
                        <time dateTime={goal.nextCheckAt} suppressHydrationWarning>
                            {formatDateTime(goal.nextCheckAt)}
                        </time>
                    </div>
                ) : !isDelivery ? (
                    <div>
                        <span className="font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('windowPrefix')}
                        </span>{' '}
                        {t(`window.${goal.window}`)}
                    </div>
                ) : null}
            </div>
        </Link>
    );
}
