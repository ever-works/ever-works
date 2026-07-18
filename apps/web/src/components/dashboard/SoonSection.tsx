'use client';

import { CalendarClock } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { SoonRunItem } from './dashboard-signals.types';

/**
 * Dashboard blocks (spec §4.4, change 4) — the Soon block. The next 3
 * upcoming scheduled runs (soonest `nextRunAt`), sitting just below
 * Attention and above the Missions list.
 *
 * Data comes from the Schedules front's `GET /api/schedules`
 * aggregation (server-fetched in the page, reused here as a prop).
 * That endpoint does not exist on this branch yet, so `items` arrives
 * empty and the block self-suppresses (`null`) — no "no upcoming runs"
 * empty state on a healthy home page (spec §9 Q6).
 */

const PREVIEW_LIMIT = 3;
// The Schedules view lives under Activity; owned by the Schedules front.
const SCHEDULES_ACTIVITY_HREF = '/activity?view=schedules';

export function SoonSection({ items, total }: { items: SoonRunItem[]; total: number }) {
    const t = useTranslations('dashboard.soon');
    const format = useFormatter();

    // Non-empty guard — including the "endpoint absent" case, which
    // resolves to an empty `items` upstream.
    if (items.length === 0) {
        return null;
    }

    const preview = items.slice(0, PREVIEW_LIMIT);
    const remaining = total - preview.length;

    return (
        <section aria-labelledby="dashboard-soon-heading" data-testid="dashboard-soon">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <CalendarClock className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h2
                        id="dashboard-soon-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('title')}
                    </h2>
                </div>
                {remaining > 0 && (
                    <Link
                        href={SCHEDULES_ACTIVITY_HREF}
                        className="text-xs font-medium text-primary hover:underline whitespace-nowrap shrink-0"
                    >
                        {t('more', { n: remaining })}
                    </Link>
                )}
            </div>

            <ul className="rounded-xl overflow-hidden border border-card-border dark:border-white/8 divide-y divide-border/40 dark:divide-white/6">
                {preview.map((run) => {
                    // A malformed `nextRunAt` (upstream aggregation) yields an
                    // Invalid Date, which throws a RangeError inside
                    // `format.dateTime`. Guard it so one bad row can't crash
                    // the whole block — fall back to an em dash.
                    const nextRun = new Date(run.nextRunAt);
                    const nextRunLabel = Number.isNaN(nextRun.getTime())
                        ? '—'
                        : format.dateTime(nextRun, {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                          });
                    return (
                        <li
                            key={run.id}
                            className="bg-card dark:bg-card-primary-dark/60 first:rounded-t-xl last:rounded-b-xl"
                        >
                            <Link
                                href={run.href}
                                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-card-hover dark:hover:bg-white/3 transition-colors no-underline"
                            >
                                <div className="min-w-0 flex-1 flex items-center gap-2.5">
                                    <span className="text-xs text-text dark:text-text-dark truncate">
                                        {run.title}
                                    </span>
                                    <span
                                        className={cn(
                                            'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                            'bg-surface-secondary text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark',
                                        )}
                                    >
                                        {run.sourceKind === 'mission'
                                            ? t('source.mission')
                                            : t('source.work')}
                                    </span>
                                </div>
                                <span className="shrink-0 text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
                                    {nextRunLabel}
                                </span>
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
