'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    listTaskRunCandidatesAction,
    runTaskAction,
    type RunTaskActionResult,
} from '@/app/actions/tasks';
import {
    RUN_AGENT_AMBIGUOUS,
    RUN_ALREADY_IN_FLIGHT,
    RUN_NO_AGENT,
    type RunCandidateAgent,
} from '@/lib/api/tasks';

/**
 * Board dispatch (kanban M3) — the "Run" affordance and its agent picker.
 *
 * One component serves three entry points so they can never disagree
 * about what running a Task means:
 *
 *   - the Run button on a kanban card,
 *   - the Run button on Task detail,
 *   - the board opening the picker on its own (`open` / `onOpenChange`),
 *     which is how a drag into In Progress with no Agent assigned stops
 *     being a silent no-op.
 *
 * It never branches on an error MESSAGE — production redacts thrown
 * Server-Action messages — only on the stable `code` the action returns.
 */

const SOURCE_LABELS: Record<RunCandidateAgent['source'], string> = {
    assignee: 'Assigned',
    task: 'Task agent',
    'work-default': 'Work default',
};

export interface RunWithAgentMenuProps {
    taskId: string;
    /** `compact` renders the card-sized icon button; default is the detail button. */
    compact?: boolean;
    /** Controlled picker state — the board uses this for the drag case. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Fired after a run is accepted (dispatched or parked). */
    onRunStarted?: (result: Extract<RunTaskActionResult, { ok: true }>) => void;
    className?: string;
}

export function RunWithAgentMenu({
    taskId,
    compact = false,
    open,
    onOpenChange,
    onRunStarted,
    className,
}: RunWithAgentMenuProps) {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = open !== undefined;
    const pickerOpen = isControlled ? open : uncontrolledOpen;

    const [candidates, setCandidates] = useState<RunCandidateAgent[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [tone, setTone] = useState<'ok' | 'error'>('ok');
    const containerRef = useRef<HTMLDivElement | null>(null);

    const setOpen = useCallback(
        (next: boolean) => {
            if (!isControlled) setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        [isControlled, onOpenChange],
    );

    // Load the picker's options the first time it opens. Best-effort:
    // a failed lookup still shows the panel, just with an empty list and
    // the reason, rather than leaving the user with a dead button.
    useEffect(() => {
        if (!pickerOpen || candidates !== null) return;
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listTaskRunCandidatesAction(taskId);
                if (!cancelled) setCandidates(rows);
            } catch {
                if (!cancelled) setCandidates([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pickerOpen, candidates, taskId]);

    // Close on outside click / Escape — the picker is a popover, not a
    // modal, so it must never trap the board's own `r` shortcut.
    useEffect(() => {
        if (!pickerOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [pickerOpen, setOpen]);

    const dispatch = useCallback(
        async (agentId?: string | null) => {
            setBusy(true);
            setMessage(null);
            try {
                const result = await runTaskAction(taskId, agentId ?? null);
                if (result.ok) {
                    setOpen(false);
                    setTone('ok');
                    setMessage(
                        result.run.parked
                            ? `Queued — waiting for capacity (${result.run.queuedReason ?? 'queued'}).`
                            : 'Run started.',
                    );
                    onRunStarted?.(result);
                    return;
                }
                setTone('error');
                if (result.code === RUN_AGENT_AMBIGUOUS || result.code === RUN_NO_AGENT) {
                    // The server already told us who the options are —
                    // trust that list over a second round trip.
                    setCandidates(result.candidates ?? []);
                    setOpen(true);
                    setMessage(
                        result.code === RUN_NO_AGENT
                            ? 'No Agent is assigned to this Task and its Work has no default Agent.'
                            : 'Pick which Agent should run this Task.',
                    );
                    return;
                }
                if (result.code === RUN_ALREADY_IN_FLIGHT) {
                    setMessage('A run is already in flight for this Agent.');
                    return;
                }
                setMessage(result.message || 'Run failed.');
            } finally {
                setBusy(false);
            }
        },
        [taskId, setOpen, onRunStarted],
    );

    return (
        <div ref={containerRef} className={cn('relative inline-flex flex-col', className)}>
            <button
                type="button"
                disabled={busy}
                onClick={() => void dispatch(null)}
                aria-label="Run this Task"
                title="Run this Task (r)"
                data-testid="task-run-button"
                className={cn(
                    'inline-flex items-center gap-1 rounded font-medium transition-colors disabled:opacity-50',
                    compact
                        ? 'text-[10px] px-1.5 py-0.5 text-text-muted hover:text-primary'
                        : 'text-xs px-2.5 py-1.5 border border-border dark:border-border-dark hover:border-primary hover:text-primary',
                )}
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                Run
            </button>

            {pickerOpen && (
                <div
                    role="dialog"
                    aria-label="Choose an Agent to run this Task"
                    data-testid="task-run-agent-picker"
                    className={cn(
                        'absolute top-full right-0 mt-1 z-20 min-w-[200px] max-w-[280px]',
                        'rounded-md border border-border/60 dark:border-border-dark/60',
                        'bg-card dark:bg-card-primary-dark p-1.5 shadow-md',
                    )}
                >
                    <p className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-text-muted">
                        Run with
                    </p>
                    {candidates === null ? (
                        <p className="px-1.5 py-1 text-[11px] text-text-muted">Loading…</p>
                    ) : candidates.length === 0 ? (
                        <p className="px-1.5 py-1 text-[11px] text-text-muted">
                            No Agent available. Assign one to this Task (or to its Work) first.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-0.5">
                            {candidates.map((agent) => (
                                <li key={agent.id}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void dispatch(agent.id)}
                                        data-testid="task-run-agent-option"
                                        className="w-full flex items-center justify-between gap-2 text-left text-[11px] px-2 py-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary disabled:opacity-50"
                                    >
                                        <span className="truncate">{agent.name}</span>
                                        <span className="text-[9px] text-text-muted shrink-0">
                                            {SOURCE_LABELS[agent.source]}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {message && (
                <p
                    className={cn(
                        'mt-1 text-[10px]',
                        tone === 'error' ? 'text-danger' : 'text-text-muted',
                    )}
                    role={tone === 'error' ? 'alert' : 'status'}
                >
                    {message}
                </p>
            )}
        </div>
    );
}
