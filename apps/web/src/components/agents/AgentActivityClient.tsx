'use client';

import { useState, useTransition } from 'react';
import { cancelAgentRunAction, listAgentRunsAction } from '@/app/actions/agents';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';

interface AgentRunRow {
    id: string;
    status: string;
    triggerKind: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    summary: string | null;
    errorMessage: string | null;
    taskId: string | null;
    createdAt: string;
}

interface Props {
    agentId: string;
    initial: { data: AgentRunRow[]; meta: { total: number; limit: number; offset: number } };
}

const STATUS_STYLES: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 animate-pulse',
    completed: 'bg-success/15 text-success',
    failed: 'bg-danger/15 text-danger',
    cancelled: 'bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-400',
};

export function AgentActivityClient({ agentId, initial }: Props) {
    const [rows, setRows] = useState<AgentRunRow[]>(initial.data);
    const [meta, setMeta] = useState(initial.meta);
    const [pending, startTransition] = useTransition();
    const [cancellingId, setCancellingId] = useState<string | null>(null);

    const refresh = (offset: number) => {
        startTransition(() => {
            void (async () => {
                const next = await listAgentRunsAction(agentId, { limit: meta.limit, offset });
                setRows(next.data);
                setMeta(next.meta);
            })();
        });
    };

    const cancel = (runId: string) => {
        setCancellingId(runId);
        startTransition(() => {
            void (async () => {
                try {
                    await cancelAgentRunAction(agentId, runId);
                    refresh(meta.offset);
                } finally {
                    setCancellingId(null);
                }
            })();
        });
    };

    const formatDuration = (ms: number | null): string => {
        if (ms == null) return '—';
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    };

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Activity</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {meta.total} run{meta.total === 1 ? '' : 's'} total
                </p>
            </header>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark divide-y divide-border/40 dark:divide-border-dark/40">
                {rows.length === 0 ? (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        No runs yet. The Agent will record activity here once the dispatcher fires
                        its first heartbeat.
                    </div>
                ) : (
                    rows.map((r) => (
                        <article key={r.id} className="p-4 flex items-start gap-3">
                            <span
                                className={cn(
                                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                                    STATUS_STYLES[r.status] ??
                                        'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300',
                                )}
                            >
                                {r.status}
                            </span>
                            <span className="shrink-0 rounded-md border border-border/40 dark:border-border-dark/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                {r.triggerKind}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {r.summary ?? r.errorMessage ?? '(no summary)'}
                                </div>
                                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    <time dateTime={r.createdAt}>
                                        {new Date(r.createdAt).toLocaleString()}
                                    </time>
                                    <span>· {formatDuration(r.durationMs)}</span>
                                    {r.taskId ? <span>· task {r.taskId.slice(0, 8)}</span> : null}
                                </div>
                            </div>
                            {(r.status === 'queued' || r.status === 'running') && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => cancel(r.id)}
                                    disabled={pending && cancellingId === r.id}
                                >
                                    {pending && cancellingId === r.id ? '…' : 'Cancel'}
                                </Button>
                            )}
                        </article>
                    ))
                )}
            </section>
            <footer className="flex items-center justify-between text-xs text-text-muted dark:text-text-muted-dark">
                <span>
                    Showing {rows.length === 0 ? 0 : meta.offset + 1}–{meta.offset + rows.length} of{' '}
                    {meta.total}
                </span>
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={meta.offset === 0 || pending}
                        onClick={() => refresh(Math.max(0, meta.offset - meta.limit))}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={meta.offset + meta.limit >= meta.total || pending}
                        onClick={() => refresh(meta.offset + meta.limit)}
                    >
                        Next
                    </Button>
                </div>
            </footer>
        </div>
    );
}
