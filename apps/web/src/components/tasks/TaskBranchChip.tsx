'use client';

import { cn } from '@/lib/utils/cn';
import type { Task, TaskBranchState } from '@/lib/api/tasks';

/**
 * Wave 2 M7 — compact branch chip for Task kanban cards.
 *
 * Rendered only when `task.branchRef` is set. Colour tracks
 * `branchState`: gray = created/pushed (and terminal
 * discarded/cleaned), blue = pr-open (links to the PR when known),
 * red = conflict, green = merged.
 */

const STATE_TONES: Record<TaskBranchState, string> = {
    created: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    pushed: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    'pr-open': 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    conflict: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    merged: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    discarded: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
    cleaned: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

const FALLBACK_TONE = 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300';

/** "task/t-42-9f3c1a2b" → "t-42-9f3c1a2b" (last path segment). */
export function branchShortName(branchRef: string): string {
    const segments = branchRef.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : branchRef;
}

export function TaskBranchChip({ task }: { task: Task }) {
    if (!task.branchRef) return null;

    const tone = (task.branchState && STATE_TONES[task.branchState]) || FALLBACK_TONE;
    const showPr = task.branchState === 'pr-open' && task.prNumber != null;

    return (
        <span
            data-testid="task-branch-chip"
            title={task.branchRef}
            className={cn(
                'inline-flex items-center gap-1 max-w-full text-[10px] font-mono px-1.5 py-0.5 rounded',
                tone,
            )}
        >
            <span className="truncate">⎇ {branchShortName(task.branchRef)}</span>
            {showPr &&
                (task.prUrl ? (
                    <a
                        href={task.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 underline hover:opacity-80"
                        data-testid="task-branch-chip-pr-link"
                    >
                        #{task.prNumber}
                    </a>
                ) : (
                    <span className="shrink-0">#{task.prNumber}</span>
                ))}
        </span>
    );
}
