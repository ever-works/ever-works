'use client';

import { cn } from '@/lib/utils/cn';
import type { Task, TaskCiState, TaskPrState } from '@/lib/api/tasks';

/**
 * PR insights (kanban run cockpit M5) — the review pill.
 *
 * `#241` + a CI dot on any card whose Task has opened a pull request.
 * The data is the cached `prState` / `ciState` written by the
 * `task-pr-status-sync` cron, so rendering costs nothing and never
 * touches a provider from the browser.
 *
 * Two safety rules, both from plan 04 §7.3:
 *
 *  - **Third-party text renders as TEXT.** Check names come from the
 *    provider (ultimately from a repo's CI config, which a PR author can
 *    influence); they appear only inside `title`, never as markup.
 *  - **The link is validated before it is rendered.** `prUrl` is written
 *    server-side from the provider's own API response, but the pill is
 *    the one place a hostile URL would become a clickable board element,
 *    so it is parsed and required to be plain `https:` with no embedded
 *    credentials. Anything else renders as inert text.
 */

const CI_DOT: Record<TaskCiState, string> = {
    passing: 'bg-emerald-500',
    failing: 'bg-red-500',
    pending: 'bg-amber-500 animate-pulse',
    unknown: 'bg-slate-400',
};

const CI_LABEL: Record<TaskCiState, string> = {
    passing: 'checks passing',
    failing: 'checks failing',
    pending: 'checks running',
    unknown: 'no checks reported',
};

const PR_TONES: Record<TaskPrState, string> = {
    open: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    draft: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    merged: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
    closed: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

const FALLBACK_TONE = 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300';

/**
 * Returns the URL only when it is safe to render as a board link:
 * absolute `https:`, no userinfo (the `https://github.com@evil.test/`
 * shape), nothing else. Never throws on junk.
 */
export function safePrUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

/** Human summary for the pill's tooltip — plain text, never markup. */
export function describeChecks(task: Pick<Task, 'ciState' | 'prChecks'>): string {
    const ciState = (task.ciState ?? 'unknown') as TaskCiState;
    const checks = task.prChecks ?? [];
    if (checks.length === 0) return CI_LABEL[ciState] ?? CI_LABEL.unknown;
    const failing = checks
        .filter((check) => check.conclusion === 'failure' || check.conclusion === 'timed_out')
        .map((check) => check.name);
    if (failing.length > 0) return `Failing: ${failing.join(', ')}`;
    return `${CI_LABEL[ciState] ?? CI_LABEL.unknown} (${checks.length})`;
}

export function TaskPrPill({ task }: { task: Task }) {
    if (task.prNumber == null) return null;

    const prState = (task.prState ?? 'open') as TaskPrState;
    const ciState = (task.ciState ?? 'unknown') as TaskCiState;
    const tone = PR_TONES[prState] ?? FALLBACK_TONE;
    const href = safePrUrl(task.prUrl);
    const title = `Pull request #${task.prNumber} — ${prState} · ${describeChecks(task)}`;

    const body = (
        <>
            <span
                data-testid="task-pr-pill-ci-dot"
                data-ci-state={ciState}
                aria-hidden="true"
                className={cn('w-1.5 h-1.5 rounded-full shrink-0', CI_DOT[ciState])}
            />
            <span className="truncate">#{task.prNumber}</span>
            {prState === 'draft' && <span className="shrink-0 opacity-70">draft</span>}
            {prState === 'merged' && <span className="shrink-0 opacity-70">merged</span>}
        </>
    );

    const className = cn(
        'inline-flex items-center gap-1 max-w-full text-[10px] font-mono px-1.5 py-0.5 rounded',
        tone,
    );

    if (!href) {
        return (
            <span
                data-testid="task-pr-pill"
                data-pr-state={prState}
                title={title}
                className={className}
            >
                {body}
            </span>
        );
    }

    return (
        <a
            data-testid="task-pr-pill"
            data-pr-state={prState}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={title}
            className={cn(className, 'hover:opacity-80 underline decoration-dotted')}
        >
            {body}
        </a>
    );
}
