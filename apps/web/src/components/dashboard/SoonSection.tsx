'use client';

import { CalendarClock, Check, CircleAlert, PauseCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { HomeScheduleKind, HomeScheduleRow, HomeToday } from '@ever-works/contracts';
import { HomeBlockShell } from '@/components/home/HomeBlockShell';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import type { SoonRunItem } from './dashboard-signals.types';

/**
 * Dashboard blocks (spec §4.4, change 4) — the Soon block. The next 3
 * upcoming scheduled runs (soonest `nextRunAt`), sitting just below
 * Attention and above the Missions list.
 *
 * Data comes from the Schedules front's `GET /api/schedules`
 * aggregation (server-fetched in the page via `getSoonRuns`, reused here
 * as a prop). When the account genuinely has no upcoming Work-schedule or
 * Mission run — or the fetch failed — `items` arrives empty and the block
 * self-suppresses (`null`): no "no upcoming runs" empty state on a healthy
 * home page (spec §9 Q6).
 *
 * That self-suppression is why a broken fetch upstream is invisible on the
 * page; `getSoonRuns` logs the failure instead of relying on this block to
 * show it.
 */

const PREVIEW_LIMIT = 3;
// The Schedules view lives under Activity; owned by the Schedules front.
const SCHEDULES_ACTIVITY_HREF = '/activity?view=schedules';

interface SoonSectionProps {
    /** Upcoming runs (the original Soon block). */
    items?: SoonRunItem[];
    total?: number;
    /**
     * Home (AW-19) — the Today panel. When given (or when `failed`), the block
     * covers the user's local day instead: what already ran and what is still
     * due before midnight, for every schedule kind.
     */
    today?: HomeToday | null;
    /** The Today panel's schedule read failed; renders its error card. */
    failed?: boolean;
    /** The timezone the day was computed in; times render on that wall clock. */
    timeZone?: string;
    onRetry?: () => void;
}

export function SoonSection({
    items = [],
    total = 0,
    today,
    failed = false,
    timeZone,
    onRetry,
}: SoonSectionProps) {
    if (today !== undefined || failed) {
        return (
            <SoonToday
                today={today ?? null}
                failed={failed}
                timeZone={timeZone}
                onRetry={onRetry}
            />
        );
    }
    return <SoonUpcoming items={items} total={total} />;
}

function SoonUpcoming({ items, total }: { items: SoonRunItem[]; total: number }) {
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

/** Label key under `dashboard.soon.source` for every schedule kind — none is left unlabelled. */
const TODAY_KIND_KEY: Record<HomeScheduleKind, string> = {
    recurring_task: 'recurringTask',
    agent_heartbeat: 'agentHeartbeat',
    work_schedule: 'workSchedule',
    mission_tick: 'missionTick',
    source_validation: 'sourceValidation',
    data_sync: 'dataSync',
    inbound_trigger: 'inboundTrigger',
};

/**
 * Home (AW-19) — the Today panel: the rows that already fired today, dimmed
 * with a tick, above a rule; then the rows still due before the end of the
 * local day, soonest first, with a link to the full schedules view when more
 * are due than the panel previews.
 */
function SoonToday({
    today,
    failed,
    timeZone,
    onRetry,
}: {
    today: HomeToday | null;
    failed: boolean;
    timeZone?: string;
    onRetry?: () => void;
}) {
    const t = useTranslations('dashboard.soon');
    const tBlock = useTranslations('dashboard.home.block');
    const remaining = today ? Math.max(0, today.dueTotal - today.due.length) : 0;
    const state =
        failed || !today
            ? 'failed'
            : today.ran.length === 0 && today.dueTotal === 0
              ? 'empty'
              : 'ready';

    return (
        <HomeBlockShell
            blockId="today"
            title={t('todayTitle')}
            icon={CalendarClock}
            state={state}
            failedLabel={tBlock('names.today')}
            onRetry={onRetry}
            headerAction={
                remaining > 0 ? (
                    <Link
                        href={SCHEDULES_ACTIVITY_HREF}
                        className="font-medium text-primary hover:underline"
                        data-testid="dashboard-soon-today-more"
                    >
                        {t('more', { n: remaining })} →
                    </Link>
                ) : null
            }
            empty={
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('emptyTitle')}{' '}
                    <Link
                        href={SCHEDULES_ACTIVITY_HREF}
                        className="font-medium text-primary hover:underline"
                    >
                        {t('emptyAction')} →
                    </Link>
                </p>
            }
        >
            {today ? (
                <div data-testid="dashboard-soon-today">
                    {today.ran.length > 0 ? (
                        <>
                            <ul aria-label={t('ranLabel')} className="space-y-1 opacity-70">
                                {today.ran.map((row) => (
                                    <TodayRow key={`ran-${row.id}`} row={row} timeZone={timeZone} />
                                ))}
                            </ul>
                            <hr className="my-2 border-border/40 dark:border-white/8" />
                        </>
                    ) : null}
                    {today.due.length > 0 ? (
                        <ul className="space-y-1">
                            {today.due.map((row) => (
                                <TodayRow key={`due-${row.id}`} row={row} timeZone={timeZone} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('nothingElse')}
                        </p>
                    )}
                </div>
            ) : null}
        </HomeBlockShell>
    );
}

function TodayRow({ row, timeZone }: { row: HomeScheduleRow; timeZone?: string }) {
    const t = useTranslations('dashboard.soon');
    // The kind key is chosen at runtime from a closed map, so relax the
    // literal-key typing for that one lookup.
    const tx = t as unknown as (key: string) => string;
    const format = useFormatter();
    const at = new Date(row.at);
    let time = '—';
    if (!Number.isNaN(at.getTime())) {
        try {
            time = format.dateTime(at, {
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
                timeZone,
            });
        } catch {
            time = format.dateTime(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        }
    }
    const ran = row.state === 'ran';

    return (
        <li data-testid="dashboard-soon-today-row" data-state={row.state} data-kind={row.kind}>
            <Link
                href={row.href}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-sm no-underline hover:bg-card-hover dark:hover:bg-white/3"
            >
                <span className="flex w-4 shrink-0 justify-center">
                    {ran ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" /> : null}
                </span>
                <span className="w-12 shrink-0 tabular-nums text-text-secondary dark:text-text-secondary-dark">
                    {ran ? (
                        <>
                            <span className="sr-only">{t('ranAt', { time })}</span>
                            <span aria-hidden="true">{time}</span>
                        </>
                    ) : (
                        time
                    )}
                </span>
                <span className="min-w-0 flex-1 truncate text-text dark:text-text-dark">
                    {row.name}
                </span>
                {row.status !== 'active' ? (
                    <span
                        className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                            row.status === 'error'
                                ? 'bg-danger/10 text-danger'
                                : 'bg-warning/10 text-warning',
                        )}
                    >
                        {row.status === 'error' ? (
                            <CircleAlert aria-hidden="true" className="h-3 w-3" />
                        ) : (
                            <PauseCircle aria-hidden="true" className="h-3 w-3" />
                        )}
                        {row.status === 'error' ? t('statusError') : t('statusPaused')}
                    </span>
                ) : null}
                <span className="shrink-0 rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark">
                    {tx(`source.${TODAY_KIND_KEY[row.kind]}`)}
                </span>
            </Link>
        </li>
    );
}
