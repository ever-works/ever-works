'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeBlock, HomeGlance, RunLedgerStatus } from '@ever-works/contracts';
import { buildRunsSearch } from '@/components/runs/runs.shared';
import { Link } from '@/i18n/navigation';
import { buildDecisionsHref } from '@/lib/api/inbox.shared';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatCount } from './home.shared';

/** Today's Runs ledger narrowed to one status — the surface each run counter comes from. */
export function runsTodayHref(status: RunLedgerStatus): string {
    // The ledger is the Activity page's `Runs` view now, so the counter links
    // straight at it instead of at the retired `/runs` (which would only
    // redirect here) — one less hop on the home page's most-used tile.
    return `${ROUTES.DASHBOARD_ACTIVITY_RUNS}&${buildRunsSearch({
        granularity: 'day',
        date: null,
        filters: { statuses: [status] },
        runId: null,
    })}`;
}

interface GlanceCountersProps {
    block: HomeBlock<HomeGlance> | undefined;
    onRetry?: () => void;
}

/**
 * Home (AW-19) — four time-bounded counters, each a link to the surface that
 * owns the number: My Decisions, and today's Runs ledger by status.
 *
 * Owner 2026-09-18 — these are the **Today** half of the merged `Your
 * workspace` block, so the component renders bare: the card, its heading and
 * the `All` half beside it belong to `WorkspaceStats`. It keeps its own
 * loading and failed states, because "no numbers yet" and "we could not read
 * them" must never look like a quiet day.
 */
export function GlanceCounters({ block, onRetry }: GlanceCountersProps) {
    const t = useTranslations('dashboard.home');
    const data = block?.status === 'ok' ? block.data : null;
    const state = !block ? 'loading' : block.status === 'failed' || !data ? 'failed' : 'ready';

    if (state === 'loading') {
        return (
            <div data-testid="home-glance-skeleton" className="space-y-2">
                <span className="sr-only">{t('block.loading')}</span>
                {[0, 1].map((index) => (
                    <div
                        key={index}
                        aria-hidden="true"
                        className="h-8 animate-pulse rounded-md bg-surface-secondary dark:bg-white/6"
                    />
                ))}
            </div>
        );
    }

    if (state === 'failed') {
        return (
            <div
                role="alert"
                data-testid="home-glance-error"
                className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5"
            >
                <p className="min-w-0 flex-1 text-sm text-text dark:text-text-dark">
                    {t('block.errorTitle', { block: t('block.names.glance') })}
                </p>
                {onRetry ? (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 dark:border-white/12 px-2.5 py-1 text-xs font-medium text-text dark:text-text-dark hover:border-border dark:hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                        {t('block.retry')}
                    </button>
                ) : null}
            </div>
        );
    }

    const counters = [
        {
            key: 'needsYou',
            value: data!.needsYou,
            href: buildDecisionsHref({ tab: 'open' }),
            danger: false,
        },
        {
            key: 'workingNow',
            value: data!.workingNow,
            href: runsTodayHref('running'),
            danger: false,
        },
        {
            key: 'doneToday',
            value: data!.doneToday,
            href: runsTodayHref('completed'),
            danger: false,
        },
        {
            key: 'failedToday',
            value: data!.failedToday,
            href: runsTodayHref('failed'),
            danger: data!.failedToday > 0,
        },
    ];

    return (
        <ul
            data-testid="home-glance"
            className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-4"
        >
            {counters.map((counter) => (
                <li key={counter.key}>
                    <Link
                        href={counter.href}
                        data-testid={`home-glance-${counter.key}`}
                        data-tone={counter.danger ? 'danger' : 'neutral'}
                        className="flex flex-col rounded-lg border border-border/40 px-3 py-2 no-underline hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:border-white/8"
                    >
                        <span
                            className={cn(
                                'text-2xl font-semibold tabular-nums',
                                counter.danger ? 'text-danger' : 'text-text dark:text-text-dark',
                            )}
                        >
                            {formatCount(counter.value)}
                        </span>
                        <span
                            className={cn(
                                'text-xs',
                                counter.danger
                                    ? 'text-danger'
                                    : 'text-text-secondary dark:text-text-secondary-dark',
                            )}
                        >
                            {t(`glance.${counter.key as 'needsYou'}`)}
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}
