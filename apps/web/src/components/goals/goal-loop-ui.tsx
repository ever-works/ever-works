'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { GoalDoDSummary, GoalEventKind, GoalLoopStatus } from '@/lib/api/goals';

/**
 * Autonomy layer — shared presentational helpers for the Goal execution
 * loop, so the loop badge, the money formatting and the DoD rollup line
 * render identically on the card, the header and every tab.
 */

const LOOP_STYLES: Record<GoalLoopStatus, string> = {
    running: 'bg-info/10 text-info border-info/20',
    paused: 'bg-warning/10 text-warning border-warning/20',
    done: 'bg-success/10 text-success border-success/20',
    cancelled:
        'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted border-border/70 dark:border-border-dark/70',
    stuck: 'bg-danger/10 text-danger border-danger/20',
};

const EVENT_STYLES: Record<GoalEventKind, string> = {
    route: 'bg-info/10 text-info border-info/20',
    dispatch: 'bg-info/10 text-info border-info/20',
    complete: 'bg-success/10 text-success border-success/20',
    limit: 'bg-warning/10 text-warning border-warning/20',
    nudge: 'bg-primary/10 text-primary border-primary/20',
    control:
        'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted border-border/70 dark:border-border-dark/70',
    dod: 'bg-success/10 text-success border-success/20',
};

/**
 * Cents → `$12.34`. The API speaks cents end to end (agent run costs are
 * cents), so this is the ONLY place dollars are produced — a second
 * conversion site is how a spend figure ends up off by a factor of 100.
 */
export function formatCents(cents: number | null | undefined): string {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
    return `$${(cents / 100).toFixed(2)}`;
}

/** Milliseconds → `4m 12s`, or `—` when the run never started. */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function LoopStatusBadge({
    status,
    className,
}: {
    status: GoalLoopStatus;
    className?: string;
}) {
    const t = useTranslations('dashboard.goalDetail.loop');
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                LOOP_STYLES[status],
                className,
            )}
        >
            {t(`statuses.${status}`)}
        </span>
    );
}

export function EventKindBadge({ kind }: { kind: GoalEventKind }) {
    const t = useTranslations('dashboard.goalDetail.orchestrator');
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                EVENT_STYLES[kind],
            )}
        >
            {t(`kinds.${kind}`)}
        </span>
    );
}

/**
 * "3 done · 1 waived · 2 open" — the rollup the brief asks for, rendered
 * from the SERVER-computed summary rather than recounted here, so the
 * checklist and the orchestrator can never disagree about completion.
 */
export function DodRollup({ summary, className }: { summary: GoalDoDSummary; className?: string }) {
    const t = useTranslations('dashboard.goalDetail.dod');
    return (
        <span className={cn('text-xs text-text-muted dark:text-text-muted-dark', className)}>
            {t('rollup', {
                done: summary.done,
                waived: summary.waived,
                open: summary.open,
            })}
            {summary.proposed > 0 ? ` · ${t('rollupProposed', { count: summary.proposed })}` : ''}
        </span>
    );
}

/** Thin progress bar for the closed share of the checklist. */
export function DodProgressBar({ summary }: { summary: GoalDoDSummary }) {
    const pct = summary.total === 0 ? 0 : Math.round((summary.closed / summary.total) * 100);
    return (
        <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary dark:bg-surface-secondary-dark"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
        >
            <div
                className={cn('h-full rounded-full', pct === 100 ? 'bg-success' : 'bg-info')}
                style={{ width: `${pct}%` }}
            />
        </div>
    );
}
