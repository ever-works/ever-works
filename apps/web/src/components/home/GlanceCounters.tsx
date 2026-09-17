'use client';

import { Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeBlock, HomeGlance, RunLedgerStatus } from '@ever-works/contracts';
import { buildRunsSearch } from '@/components/runs/runs.shared';
import { Link } from '@/i18n/navigation';
import { buildDecisionsHref } from '@/lib/api/inbox.shared';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { HomeBlockShell } from './HomeBlockShell';
import { formatCount } from './home.shared';

/** Today's Runs ledger narrowed to one status — the surface each run counter comes from. */
export function runsTodayHref(status: RunLedgerStatus): string {
    return `${ROUTES.DASHBOARD_RUNS}?${buildRunsSearch({
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
 */
export function GlanceCounters({ block, onRetry }: GlanceCountersProps) {
    const t = useTranslations('dashboard.home');
    const data = block?.status === 'ok' ? block.data : null;
    const state = !block ? 'loading' : block.status === 'failed' || !data ? 'failed' : 'ready';

    const counters = data
        ? [
              {
                  key: 'needsYou',
                  value: data.needsYou,
                  href: buildDecisionsHref({ tab: 'open' }),
                  danger: false,
              },
              {
                  key: 'workingNow',
                  value: data.workingNow,
                  href: runsTodayHref('running'),
                  danger: false,
              },
              {
                  key: 'doneToday',
                  value: data.doneToday,
                  href: runsTodayHref('completed'),
                  danger: false,
              },
              {
                  key: 'failedToday',
                  value: data.failedToday,
                  href: runsTodayHref('failed'),
                  danger: data.failedToday > 0,
              },
          ]
        : [];

    return (
        <HomeBlockShell
            blockId="glance"
            title={t('glance.title')}
            icon={Gauge}
            state={state}
            failedLabel={t('block.names.glance')}
            onRetry={onRetry}
            skeletonRows={1}
        >
            <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-4">
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
                                    counter.danger
                                        ? 'text-danger'
                                        : 'text-text dark:text-text-dark',
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
        </HomeBlockShell>
    );
}
