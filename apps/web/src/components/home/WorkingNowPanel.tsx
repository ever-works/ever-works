'use client';

import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeBlock, HomeRunningRow, HomeWorkingNow } from '@ever-works/contracts';
import { buildRunsSearch } from '@/components/runs/runs.shared';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { runsTodayHref } from './GlanceCounters';
import { HomeBlockShell } from './HomeBlockShell';
import { formatCount, formatElapsed, HOME_COMPOSER_INPUT_ID, homeRunChip } from './home.shared';

/** A run's receipt in the Runs ledger — the Activity page's `Runs` view. */
export function runReceiptHref(runId: string): string {
    return `${ROUTES.DASHBOARD_ACTIVITY_RUNS}&${buildRunsSearch({
        granularity: 'day',
        date: null,
        filters: {},
        runId,
    })}`;
}

interface WorkingNowPanelProps {
    block: HomeBlock<HomeWorkingNow> | undefined;
    onRetry?: () => void;
}

function focusComposer() {
    const input = document.getElementById(HOME_COMPOSER_INPUT_ID);
    if (input instanceof HTMLElement) {
        input.scrollIntoView?.({ block: 'center' });
        input.focus();
    }
}

/**
 * Home (AW-19) — the Runs executing right now, longest-running first, each
 * naming its Agent and the one line it last reported. A Run waiting on a
 * human is not here: it is a decision, and shows under Needs you.
 */
export function WorkingNowPanel({ block, onRetry }: WorkingNowPanelProps) {
    const t = useTranslations('dashboard.home');
    const data = block?.status === 'ok' ? block.data : null;
    const state = !block
        ? 'loading'
        : block.status === 'failed' || !data
          ? 'failed'
          : data.total === 0
            ? 'empty'
            : 'ready';

    return (
        <HomeBlockShell
            blockId="workingNow"
            title={
                data && data.total > 0
                    ? t('workingNow.title', { count: formatCount(data.total) })
                    : t('workingNow.heading')
            }
            icon={Bot}
            state={state}
            failedLabel={t('block.names.workingNow')}
            onRetry={onRetry}
            headerAction={
                data && data.total > 0 ? (
                    <Link
                        href={runsTodayHref('running')}
                        className="font-medium text-primary hover:underline"
                    >
                        {data.total > data.rows.length
                            ? t('workingNow.seeAllCount', { count: formatCount(data.total) })
                            : t('workingNow.seeAll')}{' '}
                        →
                    </Link>
                ) : null
            }
            empty={
                <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('workingNow.empty')}
                    <button
                        type="button"
                        onClick={focusComposer}
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        {t('workingNow.emptyAction')} ↑
                    </button>
                </p>
            }
        >
            {data ? (
                <ul className="divide-y divide-border/40 dark:divide-white/6">
                    {data.rows.map((row) => (
                        <RunningRow key={row.runId} row={row} />
                    ))}
                </ul>
            ) : null}
        </HomeBlockShell>
    );
}

function RunningRow({ row }: { row: HomeRunningRow }) {
    const t = useTranslations('dashboard.home.workingNow');
    const elapsed = formatElapsed(row.elapsedMs);
    const chip = homeRunChip(row.elapsedMs);

    return (
        <li data-testid="home-working-now-row">
            <Link
                href={runReceiptHref(row.runId)}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-2 text-sm no-underline hover:bg-card-hover dark:hover:bg-white/3"
            >
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-success" />
                <span className="shrink-0 font-medium text-text dark:text-text-dark">
                    {row.agentName ?? t('unknownAgent')}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-secondary dark:text-text-secondary-dark">
                    {row.activity ?? t('fallback')}
                </span>
                <span className="shrink-0 tabular-nums text-text-secondary dark:text-text-secondary-dark">
                    {elapsed.hours > 0
                        ? t('elapsedHours', { hours: elapsed.hours, minutes: elapsed.minutes })
                        : t('elapsedMinutes', { minutes: elapsed.minutes })}
                </span>
                {chip ? (
                    <span
                        data-tone={chip === 'stillGoing' ? 'warning' : 'neutral'}
                        className={cn(
                            'shrink-0 rounded-md px-1.5 py-0.5 text-[11px]',
                            chip === 'stillGoing'
                                ? 'bg-warning/10 text-warning'
                                : 'bg-surface-secondary text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark',
                        )}
                    >
                        {chip === 'stillGoing' ? t('stillGoing') : t('longRun')}
                    </span>
                ) : null}
            </Link>
        </li>
    );
}
