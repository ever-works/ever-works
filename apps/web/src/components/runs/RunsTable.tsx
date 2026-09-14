'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import type { RunLedgerRow } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { RunOutcomeBadge, useRunTriggerLabel } from './RunOutcomeBadge';
import { formatCents, formatRunDuration, runElapsedMs } from './runs.shared';

/**
 * Runs ledger (AW-09) — the list of runs for the window, as a real table
 * with a caption naming the window and filters. A row opens its receipt on
 * click, Enter or `o`; `j` / `k` move the focused row. A value the platform
 * does not have renders as "—" with a tooltip saying why, never as zero.
 * Running rows tick a live elapsed timer and show what the agent is doing.
 */
export function RunsTable({
    rows,
    caption,
    timeZone,
    focusedIndex,
    onFocusRow,
    onOpen,
}: {
    rows: RunLedgerRow[];
    caption: string;
    timeZone: string;
    focusedIndex: number;
    onFocusRow: (index: number) => void;
    onOpen: (runId: string, index: number) => void;
}) {
    const t = useTranslations('dashboard.runsPage');
    const locale = useLocale();
    const triggerLabel = useRunTriggerLabel();
    const now = useLiveNow(rows.some((row) => row.status === 'running'));

    return (
        <div className="overflow-x-auto rounded-lg border border-border/60 dark:border-border-dark/60">
            <table className="w-full text-xs" data-testid="runs-table">
                <caption className="sr-only">{caption}</caption>
                <thead className="bg-surface-secondary/60 dark:bg-surface-secondary-dark/40 text-[11px] uppercase tracking-wide text-text-muted">
                    <tr>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                            {t('columns.time')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                            {t('columns.agent')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                            {t('columns.trigger')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                            {t('columns.duration')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                            {t('columns.cost')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-left font-medium">
                            {t('columns.outcome')}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => {
                        const started = row.startedAt ?? row.createdAt;
                        const duration = formatRunDuration(
                            runElapsedMs(row, row.status === 'running' ? now : undefined),
                        );
                        const cost = formatCents(row.costCents, locale);
                        const focused = index === focusedIndex;
                        return (
                            <tr
                                key={row.id}
                                tabIndex={focused ? 0 : -1}
                                title={t('table.openReceipt')}
                                onClick={() => onOpen(row.id, index)}
                                onFocus={() => onFocusRow(index)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        onOpen(row.id, index);
                                    }
                                }}
                                className={cn(
                                    'cursor-pointer border-t border-border/60 dark:border-border-dark/60 outline-none',
                                    'hover:bg-surface-secondary/40 dark:hover:bg-surface-secondary-dark/30',
                                    focused && 'bg-primary/5 ring-1 ring-inset ring-primary/40',
                                )}
                                data-testid="runs-row"
                                data-run-id={row.id}
                                data-row-index={index}
                            >
                                <td className="px-3 py-2 align-top tabular-nums whitespace-nowrap">
                                    <time dateTime={started}>
                                        {new Date(started).toLocaleString(locale, {
                                            timeZone,
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </time>
                                </td>
                                <td className="px-3 py-2 align-top">
                                    <span className="font-medium text-text dark:text-text-dark">
                                        {row.agentName ?? t('table.unknownAgent')}
                                    </span>
                                    {row.agentArchived && (
                                        <span className="ml-1 text-[10px] text-text-muted">
                                            ({t('table.archived')})
                                        </span>
                                    )}
                                    {row.status === 'running' && row.currentActivity && (
                                        <p
                                            className="mt-0.5 max-w-md truncate text-[11px] text-text-muted"
                                            title={row.currentActivity}
                                        >
                                            {row.currentActivity}
                                        </p>
                                    )}
                                </td>
                                <td className="px-3 py-2 align-top whitespace-nowrap">
                                    {triggerLabel(row.triggerKind)}
                                    {row.scheduleKey && (
                                        <CalendarClock
                                            className="inline ml-1 w-3 h-3 text-text-muted"
                                            aria-label={t('table.scheduled')}
                                        />
                                    )}
                                </td>
                                <td className="px-3 py-2 align-top text-right tabular-nums whitespace-nowrap">
                                    {duration ?? (
                                        <span
                                            title={t('table.notStarted')}
                                            className="text-text-muted"
                                        >
                                            —
                                        </span>
                                    )}
                                </td>
                                <td className="px-3 py-2 align-top text-right tabular-nums whitespace-nowrap">
                                    {cost ?? (
                                        <span
                                            title={
                                                row.status === 'queued' || row.status === 'running'
                                                    ? t('table.notSettled')
                                                    : t('table.notMeasured')
                                            }
                                            className="text-text-muted"
                                        >
                                            —
                                        </span>
                                    )}
                                </td>
                                <td className="px-3 py-2 align-top">
                                    <RunOutcomeBadge status={row.status} />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/**
 * A once-a-second clock for live elapsed timers, running only while a listed
 * run is in flight and the tab is visible.
 */
function useLiveNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const tick = () => {
            if (typeof document === 'undefined' || !document.hidden) setNow(Date.now());
        };
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}
