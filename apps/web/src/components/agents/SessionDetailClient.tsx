'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    AlertTriangle,
    ChevronDown,
    FileText,
    Loader2,
    MessageSquare,
    RefreshCw,
    SquareTerminal,
    Wrench,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
    AgentRunSessionDetail,
    AgentRunSessionStatus,
    AgentRunTimelineEntry,
} from '@/lib/api/agents.shared';
import { timelineEntryCursor } from '@/lib/api/agents.shared';
import {
    cancelAgentRunAction,
    getRunSessionDetailAction,
    interruptAgentRunAction,
    steerAgentRunAction,
} from '@/app/actions/agents';
import { useSessionDetailPolling } from '@/lib/hooks/use-session-detail-polling';
import { formatCompactTokens } from '@/components/tasks/TaskRunChip';
import { GateChip } from '@/components/tasks/GateChip';
import { countFailedRequired } from '@/components/tasks/TaskChecksSection';

/**
 * Session detail (Feature K) — the drill-in behind each /agents/sessions
 * row: header (status, runner, task link, duration, controls), the
 * messages / tool calls / files chips, a collapsible touched-files list
 * and the captured timeline (message bubbles + expandable tool-call rows
 * with redacted args → result previews). While the run is open the view
 * live-follows via `useSessionDetailPolling`, appending fresh timeline
 * entries after the last row it already has.
 *
 * Every preview string is rendered strictly as a TEXT NODE — the server
 * redacts secrets and caps sizes, the client must never interpret any of
 * it as markup.
 */

const STATUS_DOTS: Record<AgentRunSessionStatus, string> = {
    queued: 'bg-slate-400 animate-pulse',
    running: 'bg-blue-500 animate-pulse',
    completed: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-slate-400',
};

const STATUS_TONES: Record<AgentRunSessionStatus, string> = {
    queued: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    completed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    cancelled: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

/**
 * Tool-call scale. `formatDuration` is the RUN-scale formatter (its
 * smallest unit is a whole second), and most tool calls finish in tens of
 * milliseconds — rendering them through it collapses every fast call to
 * "0s" and throws away the entire point of capturing `durationMs`.
 */
function formatToolDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return formatDuration(ms);
}

function runDurationMs(run: AgentRunSessionDetail['run']): number | null {
    if (run.durationMs != null) return run.durationMs;
    if (!run.startedAt) return null;
    const started = new Date(run.startedAt).getTime();
    if (Number.isNaN(started)) return null;
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    return Math.max(0, end - started);
}

function isOpen(status: AgentRunSessionStatus): boolean {
    return status === 'queued' || status === 'running';
}

/** `> toolName · args → result` expandable row (monospace). */
function ToolCallRow({ entry }: { entry: AgentRunTimelineEntry }) {
    const t = useTranslations('dashboard.agentsPage.sessions.detail');
    const summaryPreview = entry.argsPreview ?? '';
    return (
        <details
            className={cn(
                'group rounded-md border border-border/60 dark:border-border-dark/60',
                'bg-surface-secondary/40 dark:bg-surface-secondary-dark/40',
            )}
            data-testid="session-timeline-tool-call"
        >
            <summary
                className={cn(
                    'flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none',
                    'font-mono text-[11px] text-text-secondary dark:text-text-secondary-dark',
                )}
            >
                <ChevronDown
                    className="w-3 h-3 shrink-0 transition-transform -rotate-90 group-open:rotate-0"
                    aria-hidden
                />
                <Wrench className="w-3 h-3 shrink-0" aria-hidden />
                <span className="font-medium text-text dark:text-text-dark shrink-0">
                    {entry.toolName ?? t('unknownTool')}
                </span>
                {entry.isError && (
                    <span className="inline-flex items-center gap-1 text-[10px] px-1 py-0 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 shrink-0">
                        <AlertTriangle className="w-2.5 h-2.5" aria-hidden />
                        {t('toolError')}
                    </span>
                )}
                <span className="truncate flex-1 min-w-0 opacity-70">{summaryPreview}</span>
                {entry.durationMs != null && (
                    <span className="shrink-0 tabular-nums text-text-muted">
                        {formatToolDuration(entry.durationMs)}
                    </span>
                )}
            </summary>
            <div className="px-3 pb-2 space-y-2 font-mono text-[11px]">
                {entry.argsPreview && (
                    <div>
                        <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">
                            {t('toolArgs')}
                        </p>
                        <pre className="whitespace-pre-wrap break-all rounded bg-surface-secondary dark:bg-surface-secondary-dark p-2 text-text-secondary dark:text-text-secondary-dark max-h-64 overflow-y-auto">
                            {entry.argsPreview}
                        </pre>
                    </div>
                )}
                {entry.resultPreview && (
                    <div>
                        <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">
                            {t('toolResult')}
                        </p>
                        <pre className="whitespace-pre-wrap break-all rounded bg-surface-secondary dark:bg-surface-secondary-dark p-2 text-text-secondary dark:text-text-secondary-dark max-h-64 overflow-y-auto">
                            {entry.resultPreview}
                        </pre>
                    </div>
                )}
                {!entry.argsPreview && !entry.resultPreview && (
                    <p className="text-text-muted">{t('noPreview')}</p>
                )}
                {entry.truncated && <p className="text-text-muted">{t('previewTruncated')}</p>}
                {entry.callId && (
                    <p className="text-[10px] text-text-muted break-all">
                        {t('callId')}: {entry.callId}
                    </p>
                )}
            </div>
        </details>
    );
}

function MessageBubble({ entry }: { entry: AgentRunTimelineEntry }) {
    const t = useTranslations('dashboard.agentsPage.sessions.detail');
    const isUser = entry.kind === 'user-message';
    return (
        <div
            className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
            data-testid={`session-timeline-${entry.kind}`}
        >
            <div
                className={cn(
                    'max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words',
                    isUser
                        ? 'bg-primary/10 dark:bg-primary/20 text-text dark:text-text-dark'
                        : 'bg-card dark:bg-card-primary-dark border border-border/60 dark:border-border-dark/60 text-text dark:text-text-dark',
                )}
            >
                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-1">
                    {isUser ? t('roleUser') : t('roleAgent')}
                    <span className="ml-2 normal-case tracking-normal tabular-nums">
                        {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                        })}
                    </span>
                </p>
                {entry.text}
                {entry.truncated && (
                    <p className="mt-1 text-[10px] text-text-muted">{t('previewTruncated')}</p>
                )}
            </div>
        </div>
    );
}

export function SessionDetailClient({
    initialDetail,
    agentName,
    taskTitle,
}: {
    initialDetail: AgentRunSessionDetail;
    agentName: string;
    /** Resolved server-side when the run is task-attached; null otherwise. */
    taskTitle: string | null;
}) {
    const t = useTranslations('dashboard.agentsPage.sessions');
    const td = useTranslations('dashboard.agentsPage.sessions.detail');

    const [run, setRun] = useState(initialDetail.run);
    const [counts, setCounts] = useState(initialDetail.counts);
    const [filesTouched, setFilesTouched] = useState(initialDetail.filesTouched);
    const [entries, setEntries] = useState(initialDetail.timeline.entries);
    const [nextCursor, setNextCursor] = useState(initialDetail.timeline.nextCursor);
    const [refreshing, startRefresh] = useTransition();
    const [loadingMore, startLoadMore] = useTransition();
    const [steerMessage, setSteerMessage] = useState('');
    const [steerBusy, setSteerBusy] = useState(false);
    const [steerNotice, setSteerNotice] = useState<string | null>(null);
    const [controlError, setControlError] = useState<string | null>(null);

    const live = isOpen(run.status);
    // The poll may only APPEND when every older page has been walked —
    // otherwise fresh tail rows would visually skip the unloaded middle.
    const atTail = nextCursor === null;

    /** Header/chips/files always track the freshest read. */
    const applyRunState = useCallback((detail: AgentRunSessionDetail) => {
        setRun(detail.run);
        setCounts(detail.counts);
        setFilesTouched(detail.filesTouched);
    }, []);

    /**
     * Live-follow sink. The poll asks for everything after the last row
     * on screen, so its page is APPENDED (deduped on id — the cursor edge
     * can legitimately re-return its own row).
     *
     * `afterCursor` is undefined for TWO different reasons, and they need
     * opposite handling:
     *
     *  - mid-pagination (older pages still unwalked) — leave the timeline
     *    ALONE; replacing it with page one would throw away every "Load
     *    more" the reader just clicked through, every 5 seconds;
     *  - the timeline is EMPTY, so there is no row to follow from — there
     *    is nothing to preserve, and page one IS the tail. A run opened
     *    before its first capture row landed (a queued run, or one
     *    dispatched a second ago — the most likely moment to drill in)
     *    would otherwise sit on "no entries captured" forever while the
     *    poll happily fetched the rows and dropped them.
     */
    const timelineIsEmpty = entries.length === 0;
    const applyPolled = useCallback(
        (detail: AgentRunSessionDetail, afterCursor: string | undefined) => {
            applyRunState(detail);
            if (afterCursor === undefined) {
                if (!timelineIsEmpty) return;
                setEntries(detail.timeline.entries);
                setNextCursor(detail.timeline.nextCursor);
                return;
            }
            setEntries((prev) => {
                const known = new Set(prev.map((e) => e.id));
                const fresh = detail.timeline.entries.filter((e) => !known.has(e.id));
                return fresh.length > 0 ? [...prev, ...fresh] : prev;
            });
            if (detail.timeline.nextCursor) setNextCursor(detail.timeline.nextCursor);
        },
        [applyRunState, timelineIsEmpty],
    );

    // 5s live-follow while the run is open (terminal runs cost zero requests).
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const getPollCursor = useCallback(() => {
        if (!atTail || !lastEntry) return undefined;
        return timelineEntryCursor(lastEntry);
    }, [atTail, lastEntry]);
    useSessionDetailPolling(run.id, live || run.awaitingInput, getPollCursor, applyPolled);

    /** Explicit user action — a full reset back to the first page. */
    const refresh = useCallback(() => {
        startRefresh(async () => {
            try {
                const detail = await getRunSessionDetailAction(run.id);
                applyRunState(detail);
                setEntries(detail.timeline.entries);
                setNextCursor(detail.timeline.nextCursor);
            } catch {
                // Keep last-known state; the poll (if live) retries.
            }
        });
    }, [run.id, applyRunState]);

    const loadMore = useCallback(() => {
        if (!nextCursor) return;
        const cursor = nextCursor;
        startLoadMore(async () => {
            try {
                const detail = await getRunSessionDetailAction(run.id, { cursor });
                setEntries((prev) => {
                    const known = new Set(prev.map((e) => e.id));
                    return [...prev, ...detail.timeline.entries.filter((e) => !known.has(e.id))];
                });
                setNextCursor(detail.timeline.nextCursor);
            } catch {
                // Leave the button in place — retry is a second click.
            }
        });
    }, [run.id, nextCursor]);

    const submitSteer = useCallback(async () => {
        const message = steerMessage.trim();
        if (message.length === 0 || steerBusy) return;
        setSteerBusy(true);
        setControlError(null);
        try {
            const res = await steerAgentRunAction(run.agentId, run.id, message);
            setSteerMessage('');
            setSteerNotice(res.dispatched === 'injected' ? td('steerQueued') : td('steerNewRun'));
        } catch (err) {
            setControlError(err instanceof Error ? err.message : String(err));
        } finally {
            setSteerBusy(false);
        }
    }, [run.agentId, run.id, steerMessage, steerBusy, td]);

    const interrupt = useCallback(async () => {
        setControlError(null);
        try {
            await interruptAgentRunAction(run.agentId, run.id);
            refresh();
        } catch (err) {
            setControlError(err instanceof Error ? err.message : String(err));
        }
    }, [run.agentId, run.id, refresh]);

    const cancel = useCallback(async () => {
        setControlError(null);
        try {
            await cancelAgentRunAction(run.agentId, run.id);
            refresh();
        } catch (err) {
            setControlError(err instanceof Error ? err.message : String(err));
        }
    }, [run.agentId, run.id, refresh]);

    const durationMs = runDurationMs(run);
    const tone = STATUS_TONES[run.status] ?? STATUS_TONES.cancelled;
    const dot = STATUS_DOTS[run.status] ?? STATUS_DOTS.cancelled;
    const statusLabel = STATUS_TONES[run.status] ? t(`status.${run.status}`) : run.status;
    const showFallbackFileCount = filesTouched.length === 0 && counts.filesTouched > 0;

    const timeline = useMemo(() => entries, [entries]);

    return (
        <div className="w-full space-y-4" data-testid="session-detail">
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3">
                <span
                    className={cn(
                        'inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded shrink-0',
                        tone,
                    )}
                    data-testid="session-detail-status"
                >
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden />
                    <span className="font-medium uppercase tracking-wide">{statusLabel}</span>
                </span>
                {run.awaitingInput && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 shrink-0">
                        {t('awaitingInput')}
                    </span>
                )}
                {run.attentionReason && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 shrink-0">
                        {run.attentionReason}
                    </span>
                )}
                {/* Runner chip — which pipeline plugin hosts the session. */}
                {run.runnerKind && (
                    <span
                        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark font-mono shrink-0"
                        data-testid="session-detail-runner"
                    >
                        {run.runnerKind}
                    </span>
                )}
                {run.gateStatus && (
                    <GateChip
                        status={run.gateStatus}
                        failedCount={countFailedRequired(run.resolvedChecks, run.checkResults)}
                        className="shrink-0"
                    />
                )}
                <span className="text-[11px] text-text-muted tabular-nums">
                    {run.startedAt
                        ? new Date(run.startedAt).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                          })
                        : t('notStarted')}
                    {durationMs != null && ` · ${formatDuration(durationMs)}`}
                </span>
                <span className="flex-1" />
                {run.taskId && (
                    <Link
                        href={ROUTES.DASHBOARD_TASK(run.taskId)}
                        className="text-[11px] text-primary hover:underline shrink-0"
                        data-testid="session-detail-task-link"
                    >
                        {taskTitle ? td('viewTaskNamed', { title: taskTitle }) : td('viewTask')}
                    </Link>
                )}
                {run.sessionAttachable && (
                    <Link
                        href={`${ROUTES.DASHBOARD_AGENT_TERMINAL(run.agentId)}?run=${run.id}`}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline shrink-0"
                        data-testid="session-detail-terminal-link"
                    >
                        <SquareTerminal className="w-3.5 h-3.5" />
                        {td('openTerminal')}
                    </Link>
                )}
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={refresh}
                    disabled={refreshing}
                    data-testid="session-detail-refresh"
                >
                    {refreshing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                    ) : (
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden />
                    )}
                    <span className="ml-1">{td('refresh')}</span>
                </Button>
            </div>

            {/* Live current-activity line — plain text by contract. */}
            {(run.currentActivity || run.summary || run.errorMessage) && (
                <p
                    className={cn(
                        'text-xs',
                        run.errorMessage
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-text-secondary dark:text-text-secondary-dark',
                    )}
                    data-testid="session-detail-activity"
                >
                    {run.errorMessage ?? run.currentActivity ?? run.summary}
                </p>
            )}

            {/* ── Chips row ──────────────────────────────────────────── */}
            <div
                className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary dark:text-text-secondary-dark"
                data-testid="session-detail-chips"
            >
                <span className="inline-flex items-center gap-1 rounded border border-border/60 dark:border-border-dark/60 px-2 py-0.5">
                    <MessageSquare className="w-3 h-3" aria-hidden />
                    {td('messagesChip', { count: counts.messages })}
                </span>
                <span className="inline-flex items-center gap-1 rounded border border-border/60 dark:border-border-dark/60 px-2 py-0.5">
                    <Wrench className="w-3 h-3" aria-hidden />
                    {td('toolCallsChip', { count: counts.toolCalls })}
                </span>
                <span className="inline-flex items-center gap-1 rounded border border-border/60 dark:border-border-dark/60 px-2 py-0.5">
                    <FileText className="w-3 h-3" aria-hidden />
                    {td('filesChip', { count: counts.filesTouched })}
                </span>
                {run.totalTokens != null && (
                    <span
                        className="inline-flex items-center gap-1 rounded border border-border/60 dark:border-border-dark/60 px-2 py-0.5 font-mono"
                        title={t('tokens', { count: run.totalTokens })}
                    >
                        {formatCompactTokens(run.totalTokens)}
                    </span>
                )}
                {run.costCents != null && (
                    <span className="inline-flex items-center gap-1 rounded border border-border/60 dark:border-border-dark/60 px-2 py-0.5 font-mono">
                        ${(run.costCents / 100).toFixed(2)}
                    </span>
                )}
            </div>

            {/* ── Files touched ──────────────────────────────────────── */}
            {(filesTouched.length > 0 || showFallbackFileCount) && (
                <details
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 group"
                    data-testid="session-detail-files"
                >
                    <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-xs font-medium text-text dark:text-text-dark">
                        <ChevronDown
                            className="w-3 h-3 transition-transform -rotate-90 group-open:rotate-0"
                            aria-hidden
                        />
                        {td('filesTouched')}
                        <span className="font-mono text-text-muted">({counts.filesTouched})</span>
                    </summary>
                    <div className="px-3 pb-2">
                        {filesTouched.length > 0 ? (
                            <ul className="space-y-0.5 font-mono text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                {filesTouched.map((path) => (
                                    <li key={path} className="truncate" title={path}>
                                        {path}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-[11px] text-text-muted">
                                {td('filesCountOnly', { count: counts.filesTouched })}
                            </p>
                        )}
                    </div>
                </details>
            )}

            {/* ── Timeline ───────────────────────────────────────────── */}
            <section data-testid="session-detail-timeline">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                    {td('timeline')}
                </h2>
                {timeline.length === 0 ? (
                    <p className="text-xs text-text-muted" data-testid="session-timeline-empty">
                        {td('emptyTimeline')}
                    </p>
                ) : (
                    <div className="space-y-2">
                        {timeline.map((entry) =>
                            entry.kind === 'tool-call' ? (
                                <ToolCallRow key={entry.id} entry={entry} />
                            ) : entry.kind === 'marker' ? (
                                <p
                                    key={entry.id}
                                    className="text-[11px] text-text-muted text-center"
                                    data-testid="session-timeline-marker"
                                >
                                    {td('captureTruncated')}
                                </p>
                            ) : (
                                <MessageBubble key={entry.id} entry={entry} />
                            ),
                        )}
                    </div>
                )}
                {nextCursor && (
                    <div className="mt-3 flex justify-center">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={loadMore}
                            disabled={loadingMore}
                            data-testid="session-timeline-load-more"
                        >
                            {loadingMore && (
                                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" aria-hidden />
                            )}
                            {td('loadMore')}
                        </Button>
                    </div>
                )}
            </section>

            {/* ── Steering controls ──────────────────────────────────── */}
            {(live || run.awaitingInput) && (
                <div
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 p-3 space-y-2"
                    data-testid="session-detail-controls"
                >
                    <div className="flex items-center gap-2">
                        <Input
                            value={steerMessage}
                            onChange={(e) => setSteerMessage(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void submitSteer();
                                }
                            }}
                            placeholder={td('steerPlaceholder')}
                            className="flex-1"
                            data-testid="session-detail-steer-input"
                        />
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void submitSteer()}
                            disabled={steerBusy || steerMessage.trim().length === 0}
                            data-testid="session-detail-steer-send"
                        >
                            {steerBusy && (
                                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" aria-hidden />
                            )}
                            {td('steerSend')}
                        </Button>
                        {run.status === 'running' && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void interrupt()}
                                data-testid="session-detail-interrupt"
                            >
                                {td('interrupt')}
                            </Button>
                        )}
                        {live && (
                            <Button
                                variant="danger"
                                size="sm"
                                onClick={() => void cancel()}
                                data-testid="session-detail-cancel"
                            >
                                {td('cancel')}
                            </Button>
                        )}
                    </div>
                    {steerNotice && (
                        <p
                            className="text-[11px] text-text-muted"
                            data-testid="session-detail-steer-notice"
                        >
                            {steerNotice}
                        </p>
                    )}
                    {controlError && (
                        <p
                            className="text-[11px] text-red-600 dark:text-red-400"
                            data-testid="session-detail-control-error"
                        >
                            {controlError}
                        </p>
                    )}
                </div>
            )}

            {/* Metadata footer — the ids support needs to correlate this
                session with a chat thread or a memory session. Same
                projection the Agent activity rail already shows. */}
            <p className="text-[11px] text-text-muted break-all" data-testid="session-detail-meta">
                {td('runBy', { agent: agentName })} · {run.id}
                {run.chatMessageId && ` · ${td('chatMessage')}: ${run.chatMessageId}`}
                {run.memorySessionId && ` · ${td('memorySession')}: ${run.memorySessionId}`}
            </p>
        </div>
    );
}
