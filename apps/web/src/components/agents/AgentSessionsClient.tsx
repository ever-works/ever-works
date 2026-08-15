'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, SquareTerminal } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
    AgentRunSession,
    AgentRunSessionStatus,
    ListRunSessionsQuery,
} from '@/lib/api/agents.shared';
import { listRunSessionsAction } from '@/app/actions/agents';
import { useSessionPolling } from '@/lib/hooks/use-session-polling';
import { formatCompactTokens } from '@/components/tasks/TaskRunChip';
import { GateChip } from '@/components/tasks/GateChip';
import { countFailedRequired } from '@/components/tasks/TaskChecksSection';

/**
 * Run orchestration (Wave 4 M4) — the Sessions tab body.
 *
 * A filtered, org-wide projection of `agent_runs`: one row per session
 * with status pill, agent, Work, live current-activity line (PLAIN TEXT
 * by contract — never rendered as markup), token/cost counters, gate
 * chip, started time + duration, and an Attach link into the run's
 * terminal tab when the run carries terminal state. Queued rows explain
 * *why* they wait (`queuedReason`). While anything is queued/running
 * the list re-polls every 10s (`useSessionPolling`); an idle fleet
 * costs zero requests.
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

const SESSION_STATUSES: AgentRunSessionStatus[] = [
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
];

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function sessionDurationMs(session: AgentRunSession): number | null {
    if (session.durationMs != null) return session.durationMs;
    if (!session.startedAt) return null;
    const started = new Date(session.startedAt).getTime();
    if (Number.isNaN(started)) return null;
    const end = session.finishedAt ? new Date(session.finishedAt).getTime() : Date.now();
    return Math.max(0, end - started);
}

function SessionRow({
    session,
    agentName,
    workName,
}: {
    session: AgentRunSession;
    agentName: string;
    workName: string | null;
}) {
    const t = useTranslations('dashboard.agentsPage.sessions');
    const tone = STATUS_TONES[session.status] ?? STATUS_TONES.cancelled;
    const dot = STATUS_DOTS[session.status] ?? STATUS_DOTS.cancelled;
    const statusLabel = STATUS_TONES[session.status]
        ? t(`status.${session.status}`)
        : session.status;
    const durationMs = sessionDurationMs(session);
    // "Waiting for a concurrency slot" for the gate's concurrency parks;
    // any other reason renders as plain text.
    const queuedReason =
        session.status === 'queued' && session.queuedReason
            ? session.queuedReason.startsWith('concurrency')
                ? t('queuedConcurrency')
                : session.queuedReason
            : null;

    return (
        <li
            className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-4 py-3 hover:border-border dark:hover:border-border-dark transition-colors"
            data-testid="agent-session-row"
            data-session-status={session.status}
        >
            <div className="flex items-center gap-3 min-w-0">
                {/* Session detail (Feature K) — the row body links to the
                    drill-in page. The Attach link stays a SIBLING (outside
                    this Link) so the two targets never nest. */}
                <Link
                    href={ROUTES.DASHBOARD_AGENT_SESSION(session.id)}
                    className="flex items-center gap-3 min-w-0 flex-1"
                    data-testid="agent-session-detail-link"
                >
                    {/* Status pill */}
                    <span
                        className={cn(
                            'inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded shrink-0',
                            tone,
                        )}
                        data-testid="agent-session-status"
                    >
                        <span
                            className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)}
                            aria-hidden
                        />
                        <span className="font-medium uppercase tracking-wide">{statusLabel}</span>
                    </span>
                    {session.awaitingInput && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 shrink-0">
                            {t('awaitingInput')}
                        </span>
                    )}
                    {/* State-aware sweeper (Wave 4 M6) - the PLATFORM flagged
                    this run (queued too long / parked while stale), as
                    opposed to the agent asking a question. Rendered as the
                    raw machine token, the same fallback the unknown-
                    queuedReason branch above already uses, so a token added
                    server-side surfaces immediately instead of rendering
                    blank until 20 locale files catch up. */}
                    {session.attentionReason && (
                        <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 shrink-0"
                            data-testid="agent-session-attention"
                        >
                            {session.attentionReason}
                        </span>
                    )}

                    {/* Agent + Work */}
                    <span className="text-xs font-medium text-text dark:text-text-dark truncate shrink-0 max-w-40">
                        {agentName}
                    </span>
                    {workName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark truncate shrink-0 max-w-40">
                            {workName}
                        </span>
                    )}

                    {/* Current activity — plain text by contract, never markup. */}
                    <span
                        className="text-xs text-text-secondary dark:text-text-secondary-dark truncate flex-1 min-w-0"
                        title={session.currentActivity ?? undefined}
                    >
                        {session.currentActivity ?? session.summary ?? ''}
                    </span>

                    {/* Gate chip */}
                    {session.gateStatus && (
                        <GateChip
                            status={session.gateStatus}
                            failedCount={countFailedRequired(
                                session.resolvedChecks,
                                session.checkResults,
                            )}
                            className="shrink-0"
                        />
                    )}

                    {/* Tokens + cost */}
                    {session.totalTokens != null && (
                        <span
                            className="text-[10px] font-mono text-text-muted shrink-0"
                            title={t('tokens', { count: session.totalTokens })}
                        >
                            {formatCompactTokens(session.totalTokens)}
                        </span>
                    )}
                    {session.costCents != null && (
                        <span className="text-[10px] font-mono text-text-muted shrink-0">
                            ${(session.costCents / 100).toFixed(2)}
                        </span>
                    )}

                    {/* Started + duration */}
                    <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                        {session.startedAt
                            ? new Date(session.startedAt).toLocaleString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                              })
                            : t('notStarted')}
                        {durationMs != null && ` · ${formatDuration(durationMs)}`}
                    </span>
                </Link>

                {/* Attach → the run's terminal tab (streaming-terminal M7).
                    Gated on the server-computed `sessionAttachable` (Wave 4
                    M8), NOT on `terminalState` alone: a dead run's columns can
                    keep reading `attached` for minutes until the terminal
                    sweeper corrects them, and a link into a session nobody can
                    join is worse than no link. Falls back to the old rule for
                    rows served by an API replica that predates the field. */}
                {(session.sessionAttachable ??
                    Boolean(
                        session.terminalState &&
                        (session.status === 'running' || session.status === 'queued'),
                    )) && (
                    <Link
                        href={`${ROUTES.DASHBOARD_AGENT_TERMINAL(session.agentId)}?run=${session.id}`}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline shrink-0"
                        data-testid="agent-session-attach"
                    >
                        <SquareTerminal className="w-3.5 h-3.5" />
                        {t('attach')}
                    </Link>
                )}
            </div>
            {queuedReason && (
                <p
                    className="mt-1.5 text-[11px] text-text-muted dark:text-text-muted-dark"
                    data-testid="agent-session-queued-reason"
                >
                    {queuedReason}
                </p>
            )}
        </li>
    );
}

export function AgentSessionsClient({
    initialSessions,
    agentNames,
    workNames,
}: {
    initialSessions: AgentRunSession[];
    /** id → display name maps, server-resolved once. */
    agentNames: Record<string, string>;
    workNames: Record<string, string>;
}) {
    const t = useTranslations('dashboard.agentsPage.sessions');
    const [sessions, setSessions] = useState(initialSessions);
    const [statusFilter, setStatusFilter] = useState<'all' | AgentRunSessionStatus>('all');
    const [workFilter, setWorkFilter] = useState<string>('all');
    const [groupByWork, setGroupByWork] = useState(true);
    const [refreshing, startRefresh] = useTransition();

    const query = useMemo<ListRunSessionsQuery>(
        () => ({
            ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
            ...(workFilter !== 'all' ? { workId: workFilter } : {}),
            limit: 100,
        }),
        [statusFilter, workFilter],
    );

    // Re-fetch on filter change (skipping the initial render — the server
    // page already delivered the unfiltered first page).
    const firstRender = useRef(true);
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        startRefresh(async () => {
            try {
                const result = await listRunSessionsAction(query);
                setSessions(result.data);
            } catch {
                // Keep last-known rows; the poll (if active) will retry.
            }
        });
    }, [query]);

    // 10s poll while anything is queued/running (fleet-idle = zero requests).
    const onFreshRows = useCallback((rows: AgentRunSession[]) => setSessions(rows), []);
    useSessionPolling(sessions, query, onFreshRows);

    const workOptions = useMemo(() => {
        const ids = Object.keys(workNames);
        ids.sort((a, b) => (workNames[a] ?? '').localeCompare(workNames[b] ?? ''));
        return ids;
    }, [workNames]);

    const grouped = useMemo(() => {
        if (!groupByWork) return null;
        const map = new Map<string, AgentRunSession[]>();
        for (const session of sessions) {
            const key = session.workId ?? '';
            const list = map.get(key);
            if (list) list.push(session);
            else map.set(key, [session]);
        }
        // Named Works first (alphabetical), the no-Work bucket last.
        return [...map.entries()].sort(([a], [b]) => {
            if (a === '') return 1;
            if (b === '') return -1;
            return (workNames[a] ?? a).localeCompare(workNames[b] ?? b);
        });
    }, [groupByWork, sessions, workNames]);

    const agentNameOf = (session: AgentRunSession) =>
        agentNames[session.agentId] ?? `${session.agentId.slice(0, 8)}…`;
    const workNameOf = (session: AgentRunSession) =>
        session.workId ? (workNames[session.workId] ?? `${session.workId.slice(0, 8)}…`) : null;

    return (
        <div data-testid="agent-sessions">
            {/* ── Filters ─────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <Select
                    value={statusFilter}
                    onValueChange={(next) => setStatusFilter(next as 'all' | AgentRunSessionStatus)}
                    size="sm"
                    className="w-36"
                    data-testid="agent-sessions-status-filter"
                >
                    <option value="all">{t('filterStatusAll')}</option>
                    {SESSION_STATUSES.map((status) => (
                        <option key={status} value={status}>
                            {t(`status.${status}`)}
                        </option>
                    ))}
                </Select>
                <Select
                    value={workFilter}
                    onValueChange={setWorkFilter}
                    size="sm"
                    className="w-48"
                    data-testid="agent-sessions-work-filter"
                >
                    <option value="all">{t('filterWorkAll')}</option>
                    {workOptions.map((id) => (
                        <option key={id} value={id}>
                            {workNames[id]}
                        </option>
                    ))}
                </Select>
                <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('groupByWork')}
                    <Switch
                        checked={groupByWork}
                        onChange={setGroupByWork}
                        className="mt-0"
                        data-testid="agent-sessions-group-toggle"
                    />
                </label>
                {refreshing && (
                    <Loader2 className="w-4 h-4 animate-spin text-text-muted" aria-hidden />
                )}
            </div>

            {/* ── List ────────────────────────────────────────────────── */}
            {sessions.length === 0 ? (
                <div
                    className="rounded-lg border border-border/60 dark:border-border-dark/60 p-8 text-center"
                    data-testid="agent-sessions-empty"
                >
                    <p className="text-sm text-text dark:text-text-dark font-medium">
                        {t('emptyTitle')}
                    </p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2 max-w-md mx-auto">
                        {t('emptyBody')}
                    </p>
                </div>
            ) : grouped ? (
                <div className="space-y-5" data-testid="agent-sessions-list">
                    {grouped.map(([workId, rows]) => (
                        <section key={workId || 'no-work'}>
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                                {workId
                                    ? (workNames[workId] ?? `${workId.slice(0, 8)}…`)
                                    : t('noWork')}
                                <span className="ml-2 font-mono normal-case">({rows.length})</span>
                            </h3>
                            <ul className="space-y-2">
                                {rows.map((session) => (
                                    <SessionRow
                                        key={session.id}
                                        session={session}
                                        agentName={agentNameOf(session)}
                                        workName={null}
                                    />
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            ) : (
                <ul className="space-y-2" data-testid="agent-sessions-list">
                    {sessions.map((session) => (
                        <SessionRow
                            key={session.id}
                            session={session}
                            agentName={agentNameOf(session)}
                            workName={workNameOf(session)}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
