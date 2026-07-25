'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { Task, TaskRunStatus } from '@/lib/api/tasks';

/**
 * Kanban run cockpit (Wave 2) — compact live-run chip for Task kanban
 * cards, rendered next to the branch chip whenever the list embedded a
 * latest run (`includeRun=true`).
 *
 * Status dot: queued = gray pulse, running = blue pulse, completed =
 * green, failed = red (cancelled = static gray). `currentActivity` is
 * rendered strictly as a text node — NEVER as markup — and truncated;
 * the token counter is compacted ("12.4k").
 */

const STATUS_DOTS: Record<TaskRunStatus, string> = {
    queued: 'bg-slate-400 animate-pulse',
    running: 'bg-blue-500 animate-pulse',
    completed: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-slate-400',
};

const STATUS_TONES: Record<TaskRunStatus, string> = {
    queued: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    completed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    cancelled: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

const FALLBACK_DOT = 'bg-slate-400';
const FALLBACK_TONE = 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300';

/** 999 → "999", 12_400 → "12.4k", 3_100_000 → "3.1M". */
export function formatCompactTokens(count: number): string {
    if (!Number.isFinite(count) || count < 0) return '0';
    if (count < 1000) return String(Math.round(count));
    const compact = (value: number, suffix: string) => {
        const rounded = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '');
        return `${rounded}${suffix}`;
    };
    if (count < 1_000_000) return compact(count / 1000, 'k');
    return compact(count / 1_000_000, 'M');
}

export function TaskRunChip({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.runChip');
    const run = task.run;
    if (!run) return null;

    const dot = STATUS_DOTS[run.status] ?? FALLBACK_DOT;
    const tone = STATUS_TONES[run.status] ?? FALLBACK_TONE;
    const statusLabel = STATUS_DOTS[run.status] ? t(run.status) : run.status;

    return (
        <span
            data-testid="task-run-chip"
            // Plain-text title only — currentActivity must never be markup.
            title={run.currentActivity ?? statusLabel}
            className={cn(
                'inline-flex items-center gap-1.5 max-w-full text-[10px] px-1.5 py-0.5 rounded',
                tone,
            )}
        >
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />
            <span className="font-medium uppercase tracking-wide shrink-0">{statusLabel}</span>
            {run.currentActivity ? <span className="truncate">{run.currentActivity}</span> : null}
            {run.totalTokens != null && (
                <span
                    className="font-mono shrink-0"
                    title={t('tokens', { count: run.totalTokens })}
                >
                    {formatCompactTokens(run.totalTokens)}
                </span>
            )}
        </span>
    );
}
