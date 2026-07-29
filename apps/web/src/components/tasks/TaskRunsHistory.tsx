'use client';

import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AgentRunSession, AgentRunSessionStatus } from '@/lib/api/agents.shared';

/**
 * Run-driven lifecycle (kanban run cockpit M7) — the Runs history on
 * Task detail.
 *
 * A Task accretes MANY runs (re-runs, gate iterations, conflict
 * resolutions), and until now the detail page showed only the latest
 * one. That made the two questions a user actually has after a red chip
 * — "did this ever work?" and "what changed between attempts?" —
 * unanswerable without the Sessions page and a filter.
 *
 * Read-only and purely presentational: the rows come from the same
 * `GET /api/agents/runs?taskId=…` projection the Sessions cockpit uses,
 * so no new endpoint and no new permission surface.
 */

const STATUS_TONES: Record<AgentRunSessionStatus, string> = {
    queued: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    completed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    cancelled: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

/** "48.2k" / "3.1M" — 3 significant figures, same rule as the board chip. */
export function formatTokens(total: number | null | undefined): string | null {
    if (total == null || !Number.isFinite(total) || total <= 0) return null;
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
    if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
    return String(total);
}

/** "1m 12s" / "820ms" — compact, never a bare millisecond count in the UI. */
export function formatDuration(ms: number | null | undefined): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

function RunRow({ run }: { run: AgentRunSession }) {
    const tokens = formatTokens(run.totalTokens);
    const duration = formatDuration(run.durationMs);
    const started = run.startedAt ?? run.createdAt;

    return (
        <li
            data-testid="task-run-history-row"
            data-run-status={run.status}
            className="flex flex-col gap-1 py-2 border-b border-border/40 dark:border-border-dark/40 last:border-b-0"
        >
            <div className="flex items-center gap-2 flex-wrap">
                <span
                    className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                        STATUS_TONES[run.status],
                    )}
                >
                    {run.status}
                </span>
                <Link
                    href={ROUTES.DASHBOARD_AGENT(run.agentId)}
                    className="text-[11px] font-mono text-text-muted hover:text-primary truncate"
                >
                    {run.agentId.slice(0, 8)}
                </Link>
                <span className="text-[10px] text-text-muted">
                    {started ? new Date(started).toLocaleString() : '—'}
                </span>
                {duration && <span className="text-[10px] text-text-muted">{duration}</span>}
                {tokens && (
                    <span className="text-[10px] font-mono text-text-muted">{tokens} tok</span>
                )}
                {run.changedFilesCount != null && (
                    <span className="text-[10px] font-mono text-text-muted">
                        ±{run.changedFilesCount}
                    </span>
                )}
                {run.gateStatus && (
                    <span className="text-[10px] font-mono text-text-muted">
                        gate: {run.gateStatus}
                    </span>
                )}
            </div>
            {/* A failed run is a dead end without somewhere to go: the
                message here is clamped to two lines and carries no stack,
                no step and no logs. The link points at the run's own row
                in the Agent's Activity feed, which expands to the full
                run detail — the place the failure is actually diagnosed
                and fixed. Shown for every failure, message or not: a
                failure with an EMPTY message is exactly the case where
                the logs are the only way to learn anything. */}
            {run.status === 'failed' && (
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    {/* Agent-authored text — rendered strictly as a text node. */}
                    {run.errorMessage && (
                        <p className="text-[11px] text-danger line-clamp-2 min-w-0 flex-1">
                            {run.errorMessage}
                        </p>
                    )}
                    <Link
                        href={`${ROUTES.DASHBOARD_AGENT_ACTIVITY(run.agentId)}?run=${run.id}`}
                        data-testid="task-run-history-logs-link"
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline shrink-0"
                    >
                        <ScrollText className="w-3 h-3" />
                        View logs
                    </Link>
                </div>
            )}
            {run.status !== 'failed' && run.summary && (
                <p className="text-[11px] text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {run.summary}
                </p>
            )}
        </li>
    );
}

/**
 * Rows per tab. Past this many, the history stops being a glance and
 * starts pushing the Attachments and Activity sections below the fold —
 * so it pages instead of growing.
 */
const RUNS_PER_PAGE = 7;

export function TaskRunsHistory({ runs }: { runs: AgentRunSession[] }) {
    const [page, setPage] = useState(0);

    const total = runs?.length ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / RUNS_PER_PAGE));
    // Clamp rather than trust: the parent re-renders this list after a
    // run finishes, and a history that shrank (or a Task re-scoped to
    // another Work) must not leave the section on an empty page.
    const current = Math.min(page, totalPages - 1);
    const start = current * RUNS_PER_PAGE;
    const visible = runs?.slice(start, start + RUNS_PER_PAGE) ?? [];
    const tabbed = total > RUNS_PER_PAGE;

    if (total === 0) return null;

    // Roving tabindex: only the selected tab is in the tab order, and the
    // arrows move between them — the WAI-ARIA tabs keyboard contract.
    const onTabKeyDown = (event: React.KeyboardEvent) => {
        const next =
            event.key === 'ArrowRight'
                ? (current + 1) % totalPages
                : event.key === 'ArrowLeft'
                  ? (current - 1 + totalPages) % totalPages
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? totalPages - 1
                      : null;
        if (next === null) return;
        event.preventDefault();
        setPage(next);
        document.getElementById(`task-runs-tab-${next}`)?.focus();
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-runs-history"
        >
            <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Runs</h2>
                <span className="text-[10px] text-text-muted" data-testid="task-runs-history-count">
                    {runs.length}
                </span>
            </div>

            <ul
                id="task-runs-history-panel"
                role={tabbed ? 'tabpanel' : undefined}
                aria-labelledby={tabbed ? `task-runs-tab-${current}` : undefined}
                className="flex flex-col"
            >
                {visible.map((run) => (
                    <RunRow key={run.id} run={run} />
                ))}
            </ul>

            {/* Below the rows, where pagination belongs: the tabs are how
                you leave the page you just read, not a filter you choose
                before reading. Surface tokens only — the accent colour is
                spoken for by the status chips inside the rows. */}
            {tabbed && (
                <div
                    role="tablist"
                    aria-label="Run history pages"
                    onKeyDown={onTabKeyDown}
                    data-testid="task-runs-history-tabs"
                    className="flex flex-wrap items-center justify-end gap-1 mt-3 pt-3 border-t border-border/40 dark:border-border-dark/40"
                >
                    {Array.from({ length: totalPages }, (_, index) => {
                        const from = index * RUNS_PER_PAGE + 1;
                        const to = Math.min(total, (index + 1) * RUNS_PER_PAGE);
                        const selected = index === current;
                        return (
                            <button
                                key={index}
                                id={`task-runs-tab-${index}`}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls="task-runs-history-panel"
                                tabIndex={selected ? 0 : -1}
                                title={`Runs ${from}–${to}`}
                                onClick={() => setPage(index)}
                                data-testid="task-runs-history-tab"
                                className={cn(
                                    'min-w-6 rounded-md border px-2 py-1 text-[10px] transition-colors',
                                    selected
                                        ? 'border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                        : 'border-transparent text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {index + 1}
                            </button>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
