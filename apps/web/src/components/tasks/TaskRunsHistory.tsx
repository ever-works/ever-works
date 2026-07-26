'use client';

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
            {/* Agent-authored text — rendered strictly as a text node. */}
            {run.status === 'failed' && run.errorMessage && (
                <p className="text-[11px] text-danger line-clamp-2">{run.errorMessage}</p>
            )}
            {run.status !== 'failed' && run.summary && (
                <p className="text-[11px] text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                    {run.summary}
                </p>
            )}
        </li>
    );
}

export function TaskRunsHistory({ runs }: { runs: AgentRunSession[] }) {
    if (!runs || runs.length === 0) return null;

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
            <ul className="flex flex-col">
                {runs.map((run) => (
                    <RunRow key={run.id} run={run} />
                ))}
            </ul>
        </section>
    );
}
