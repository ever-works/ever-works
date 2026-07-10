'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock,
    Loader2,
    OctagonMinus,
    XCircle,
} from 'lucide-react';
import {
    cancelAgentRunAction,
    getAgentRunDetailAction,
    listAgentEventsAction,
    listAgentRunsAction,
} from '@/app/actions/agents';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';

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

interface AgentRunLogRow {
    id: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    step: string;
    message: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
}

interface AgentRunDetail extends AgentRunRow {
    chatMessageId: string | null;
    memorySessionId: string | null;
    logs: AgentRunLogRow[];
}

interface AgentEventRow {
    id: string;
    actionType: string;
    details: Record<string, unknown> | null;
    createdAt: string;
}

interface Props {
    agentId: string;
    initial: { data: AgentRunRow[]; meta: { total: number; limit: number; offset: number } };
    initialEvents?: AgentEventRow[];
}

type FeedItem = { kind: 'run'; run: AgentRunRow } | { kind: 'event'; event: AgentEventRow };

// Mirrors ActivityStatusBadge on /activity so both feeds read the same.
const RUN_STATUS_CONFIG: Record<
    string,
    { icon: typeof Clock; color: string; bg: string; spin?: boolean }
> = {
    queued: {
        icon: Clock,
        color: 'text-text-muted dark:text-text-muted-dark',
        bg: 'bg-surface-secondary dark:bg-surface-secondary-dark',
    },
    running: {
        icon: Loader2,
        color: 'text-blue-600 dark:text-blue-400',
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        spin: true,
    },
    completed: {
        icon: CheckCircle2,
        color: 'text-green-600 dark:text-green-400',
        bg: 'bg-green-50 dark:bg-green-900/20',
    },
    failed: {
        icon: XCircle,
        color: 'text-red-600 dark:text-red-400',
        bg: 'bg-red-50 dark:bg-red-900/20',
    },
    cancelled: {
        icon: OctagonMinus,
        color: 'text-amber-700 dark:text-amber-300',
        bg: 'bg-amber-50 dark:bg-amber-900/20',
    },
};

function RunStatusBadge({ status }: { status: string }) {
    const config = RUN_STATUS_CONFIG[status] ?? RUN_STATUS_CONFIG.queued;
    const Icon = config.icon;
    return (
        <span
            className={`inline-flex whitespace-nowrap items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color} ${config.bg}`}
        >
            <Icon className={`w-3 h-3 ${config.spin ? 'animate-spin' : ''}`} />
            {status}
        </span>
    );
}

// Mirrors ActivityTypeBadge colors on /activity.
const TRIGGER_KIND_COLORS: Record<string, string> = {
    heartbeat: 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300',
    manual: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
    task: 'bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-300',
    chat: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-300',
    event: 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-300',
};

const EVENT_PRESENTATION: Record<string, { label: string; className: string }> = {
    agent_created: {
        label: 'created',
        className: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
    },
    agent_paused: {
        label: 'paused',
        className: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
    },
    agent_resumed: {
        label: 'resumed',
        className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
    },
    agent_archived: {
        label: 'archived',
        className: 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-300',
    },
    agent_exported: {
        label: 'exported',
        className: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300',
    },
    agent_imported: {
        label: 'imported',
        className: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300',
    },
    agent_budget_exceeded: {
        label: 'budget exceeded',
        className: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
    },
};

const DEFAULT_TYPE_COLOR = 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-300';

const eventPresentation = (actionType: string) =>
    EVENT_PRESENTATION[actionType] ?? {
        label: actionType.replace(/^agent_/, '').replace(/_/g, ' '),
        className: DEFAULT_TYPE_COLOR,
    };

function TypePill({ label, className }: { label: string; className: string }) {
    return (
        <span
            className={`inline-flex whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium capitalize ${className}`}
        >
            {label}
        </span>
    );
}

const LOG_LEVEL_STYLES: Record<AgentRunLogRow['level'], string> = {
    INFO: 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
    WARN: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
    ERROR: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
};

const formatDuration = (ms: number | null): string => {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * Hydration-safe timestamp, mirroring ActivityTimestamp on /activity:
 * renders an empty <time> until mounted, then the locale-formatted
 * value (`stacked` = date over time, `relative` = "5 minutes ago").
 */
function Timestamp({
    value,
    variant = 'absolute',
    className,
}: {
    value: string | null;
    variant?: 'absolute' | 'relative' | 'stacked';
    className?: string;
}) {
    const mounted = useMounted();
    if (!value) return <span className={className}>—</span>;
    if (!mounted) return <time dateTime={value} className={className} />;

    const date = new Date(value);
    const absolute = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

    return (
        <time
            dateTime={value}
            title={variant === 'relative' ? absolute : undefined}
            className={className}
        >
            {variant === 'relative' ? (
                formatDistanceToNow(date, { addSuffix: true })
            ) : variant === 'stacked' ? (
                <span className="inline-flex flex-col leading-4 whitespace-nowrap">
                    <span>{date.toLocaleDateString()}</span>
                    <span>{date.toLocaleTimeString()}</span>
                </span>
            ) : (
                absolute
            )}
        </time>
    );
}

const TH_CLASS =
    'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark';

export function AgentActivityClient({ agentId, initial, initialEvents = [] }: Props) {
    const [rows, setRows] = useState<AgentRunRow[]>(initial.data);
    const [meta, setMeta] = useState(initial.meta);
    const [events, setEvents] = useState<AgentEventRow[]>(initialEvents);
    const [pending, startTransition] = useTransition();
    const [cancellingId, setCancellingId] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    // runId → detail; null = fetch failed (rendered as retryable error state).
    const [details, setDetails] = useState<Record<string, AgentRunDetail | null>>({});

    const refresh = (offset: number) => {
        startTransition(() => {
            void (async () => {
                const [next, nextEvents] = await Promise.all([
                    listAgentRunsAction(agentId, { limit: meta.limit, offset }),
                    listAgentEventsAction(agentId, { limit: 100 }).catch(() => null),
                ]);
                setRows(next.data);
                setMeta(next.meta);
                if (nextEvents) setEvents(nextEvents.data);
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

    const loadDetail = async (runId: string) => {
        try {
            const detail = await getAgentRunDetailAction(agentId, runId);
            setDetails((prev) => ({ ...prev, [runId]: detail as AgentRunDetail }));
        } catch {
            setDetails((prev) => ({ ...prev, [runId]: null }));
        }
    };

    const toggle = (runId: string) => {
        if (!expandedIds.has(runId) && details[runId] === undefined) void loadDetail(runId);
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(runId)) {
                next.delete(runId);
            } else {
                next.add(runId);
            }
            return next;
        });
    };

    const retryDetail = (runId: string) => {
        setDetails((prev) => {
            const next = { ...prev };
            delete next[runId];
            return next;
        });
        void loadDetail(runId);
    };

    const handleRowKeyDown = (e: React.KeyboardEvent, runId: string) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(runId);
        }
    };

    // Interleave lifecycle events into the run pagination: events are
    // fetched once (they're rare) and clipped to the time window covered
    // by the current page of runs, with the first/last page absorbing
    // everything newer/older respectively. ISO timestamps sort
    // lexicographically, so plain string comparison is safe here.
    const feed = useMemo<FeedItem[]>(() => {
        const isFirst = meta.offset === 0;
        const isLast = meta.offset + meta.limit >= meta.total;
        let visible: AgentEventRow[];
        if (rows.length === 0) {
            visible = isFirst ? events : [];
        } else {
            const newest = rows[0].createdAt;
            const oldest = rows[rows.length - 1].createdAt;
            visible = events.filter(
                (e) => (isFirst || e.createdAt <= newest) && (isLast || e.createdAt >= oldest),
            );
        }
        return [
            ...rows.map<FeedItem>((run) => ({ kind: 'run', run })),
            ...visible.map<FeedItem>((event) => ({ kind: 'event', event })),
        ].sort((a, b) => {
            const ta = a.kind === 'run' ? a.run.createdAt : a.event.createdAt;
            const tb = b.kind === 'run' ? b.run.createdAt : b.event.createdAt;
            return tb.localeCompare(ta);
        });
    }, [rows, events, meta]);

    const page = Math.floor(meta.offset / meta.limit) + 1;
    const totalPages = Math.max(1, Math.ceil(meta.total / meta.limit));

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Activity</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {meta.total} run{meta.total === 1 ? '' : 's'} total
                </p>
            </header>

            <div className="relative overflow-hidden rounded-lg border border-border dark:border-border-dark">
                {pending && feed.length > 0 && (
                    <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-border dark:border-border-dark bg-card/95 dark:bg-card-primary-dark/95 px-2.5 py-1 text-xs text-text-muted dark:text-text-muted-dark shadow-sm backdrop-blur-sm">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading…
                    </div>
                )}
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-border dark:divide-border-dark">
                        <thead className="bg-muted/50 dark:bg-muted/20">
                            <tr>
                                <th scope="col" className="w-8 px-3 py-3">
                                    <span className="sr-only">Expand</span>
                                </th>
                                <th scope="col" className={TH_CLASS}>
                                    Date / Time
                                </th>
                                <th scope="col" className={TH_CLASS}>
                                    Type
                                </th>
                                <th scope="col" className={TH_CLASS}>
                                    Summary
                                </th>
                                <th scope="col" className={`whitespace-nowrap ${TH_CLASS}`}>
                                    Duration
                                </th>
                                <th
                                    scope="col"
                                    className={`w-[9rem] whitespace-nowrap ${TH_CLASS}`}
                                >
                                    Status
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border dark:divide-border-dark">
                            {feed.length === 0 && (
                                <tr className="bg-card dark:bg-transparent">
                                    <td
                                        colSpan={6}
                                        className="px-4 py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                                    >
                                        No activity yet. The Agent will record runs and status
                                        changes here once the dispatcher fires its first heartbeat.
                                    </td>
                                </tr>
                            )}
                            {feed.map((item) => {
                                if (item.kind === 'event') {
                                    const e = item.event;
                                    const p = eventPresentation(e.actionType);
                                    return (
                                        <tr
                                            key={`evt-${e.id}`}
                                            className="bg-card dark:bg-transparent"
                                        >
                                            <td className="px-3 py-3" />
                                            <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                                <Timestamp value={e.createdAt} variant="stacked" />
                                            </td>
                                            <td className="px-4 py-3">
                                                <TypePill label={p.label} className={p.className} />
                                            </td>
                                            <td
                                                className="px-4 py-3 text-xs text-text dark:text-text-dark"
                                                colSpan={2}
                                            >
                                                Agent {p.label}{' '}
                                                <Timestamp
                                                    value={e.createdAt}
                                                    variant="relative"
                                                    className="text-text-muted dark:text-text-muted-dark"
                                                />
                                            </td>
                                            <td className="w-[9rem] whitespace-nowrap px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark">
                                                —
                                            </td>
                                        </tr>
                                    );
                                }

                                const r = item.run;
                                const isExpanded = expandedIds.has(r.id);
                                const detail = details[r.id];
                                return (
                                    <Fragment key={r.id}>
                                        <tr
                                            className="bg-card dark:bg-transparent hover:bg-muted/30 dark:hover:bg-muted/10 transition-colors cursor-pointer"
                                            onClick={() => toggle(r.id)}
                                            onKeyDown={(e) => handleRowKeyDown(e, r.id)}
                                            tabIndex={0}
                                            role="button"
                                            aria-expanded={isExpanded}
                                        >
                                            <td className="px-3 py-3 text-center">
                                                {isExpanded ? (
                                                    <ChevronDown
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                ) : (
                                                    <ChevronRight
                                                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                                                        aria-hidden="true"
                                                    />
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                                <Timestamp value={r.createdAt} variant="stacked" />
                                            </td>
                                            <td className="px-4 py-3">
                                                <TypePill
                                                    label={r.triggerKind}
                                                    className={
                                                        TRIGGER_KIND_COLORS[r.triggerKind] ??
                                                        DEFAULT_TYPE_COLOR
                                                    }
                                                />
                                            </td>
                                            <td className="px-4 py-3 text-xs text-text dark:text-text-dark max-w-md">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="line-clamp-2 break-words">
                                                            {r.summary ??
                                                                r.errorMessage ??
                                                                '(no summary)'}
                                                        </div>
                                                        {r.errorMessage && r.summary ? (
                                                            <div className="mt-0.5 line-clamp-1 break-words text-red-600 dark:text-red-400">
                                                                {r.errorMessage}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                    {(r.status === 'queued' ||
                                                        r.status === 'running') && (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                cancel(r.id);
                                                            }}
                                                            disabled={
                                                                pending && cancellingId === r.id
                                                            }
                                                            className="shrink-0 px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark text-text dark:text-text-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                                                        >
                                                            {pending && cancellingId === r.id
                                                                ? '…'
                                                                : 'Cancel'}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap tabular-nums">
                                                {formatDuration(r.durationMs)}
                                            </td>
                                            <td className="w-[9rem] whitespace-nowrap px-4 py-3 align-top">
                                                <RunStatusBadge status={r.status} />
                                            </td>
                                        </tr>
                                        <tr
                                            className={
                                                isExpanded ? 'bg-muted/20 dark:bg-muted/10' : ''
                                            }
                                        >
                                            <td colSpan={6} style={{ padding: 0 }}>
                                                <div
                                                    style={{
                                                        display: 'grid',
                                                        gridTemplateRows: isExpanded
                                                            ? '1fr'
                                                            : '0fr',
                                                        transition: 'grid-template-rows 300ms ease',
                                                    }}
                                                >
                                                    <div className="overflow-hidden">
                                                        <div className="px-6 py-4 space-y-3">
                                                            {detail === undefined ? (
                                                                <p className="inline-flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                    Loading run details…
                                                                </p>
                                                            ) : detail === null ? (
                                                                <p className="text-xs text-red-600 dark:text-red-400">
                                                                    Could not load run details.{' '}
                                                                    <button
                                                                        type="button"
                                                                        className="underline cursor-pointer"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            retryDetail(r.id);
                                                                        }}
                                                                    >
                                                                        Retry
                                                                    </button>
                                                                </p>
                                                            ) : (
                                                                <>
                                                                    <div className="rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark/30 p-3">
                                                                        <p className="text-xs mb-3 font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                                            Run
                                                                        </p>
                                                                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                                                                            <div>
                                                                                <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                    Created
                                                                                </dt>
                                                                                <dd className="text-text dark:text-text-dark">
                                                                                    <Timestamp
                                                                                        value={
                                                                                            detail.createdAt
                                                                                        }
                                                                                    />
                                                                                </dd>
                                                                            </div>
                                                                            <div>
                                                                                <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                    Started
                                                                                </dt>
                                                                                <dd className="text-text dark:text-text-dark">
                                                                                    <Timestamp
                                                                                        value={
                                                                                            detail.startedAt
                                                                                        }
                                                                                    />
                                                                                </dd>
                                                                            </div>
                                                                            <div>
                                                                                <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                    Finished
                                                                                </dt>
                                                                                <dd className="text-text dark:text-text-dark">
                                                                                    <Timestamp
                                                                                        value={
                                                                                            detail.finishedAt
                                                                                        }
                                                                                    />
                                                                                </dd>
                                                                            </div>
                                                                            <div>
                                                                                <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                    Duration
                                                                                </dt>
                                                                                <dd className="text-text dark:text-text-dark tabular-nums">
                                                                                    {formatDuration(
                                                                                        detail.durationMs,
                                                                                    )}
                                                                                </dd>
                                                                            </div>
                                                                            {detail.taskId ? (
                                                                                <div>
                                                                                    <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                        Task
                                                                                    </dt>
                                                                                    <dd className="text-text dark:text-text-dark break-all font-mono text-[11px]">
                                                                                        {
                                                                                            detail.taskId
                                                                                        }
                                                                                    </dd>
                                                                                </div>
                                                                            ) : null}
                                                                            {detail.chatMessageId ? (
                                                                                <div>
                                                                                    <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                        Chat message
                                                                                    </dt>
                                                                                    <dd className="text-text dark:text-text-dark break-all font-mono text-[11px]">
                                                                                        {
                                                                                            detail.chatMessageId
                                                                                        }
                                                                                    </dd>
                                                                                </div>
                                                                            ) : null}
                                                                            {detail.memorySessionId ? (
                                                                                <div>
                                                                                    <dt className="text-text-muted dark:text-text-muted-dark">
                                                                                        Memory
                                                                                        session
                                                                                    </dt>
                                                                                    <dd className="text-text dark:text-text-dark break-all font-mono text-[11px]">
                                                                                        {
                                                                                            detail.memorySessionId
                                                                                        }
                                                                                    </dd>
                                                                                </div>
                                                                            ) : null}
                                                                        </dl>
                                                                    </div>
                                                                    {detail.summary ? (
                                                                        <section className="space-y-2">
                                                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                                                Summary
                                                                            </h5>
                                                                            <p className="text-xs text-text dark:text-text-dark whitespace-pre-wrap">
                                                                                {detail.summary}
                                                                            </p>
                                                                        </section>
                                                                    ) : null}
                                                                    {detail.errorMessage ? (
                                                                        <section className="space-y-2">
                                                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                                                                                Error
                                                                            </h5>
                                                                            <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-all">
                                                                                {
                                                                                    detail.errorMessage
                                                                                }
                                                                            </p>
                                                                        </section>
                                                                    ) : null}
                                                                    <section className="space-y-2">
                                                                        <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                                                                            Steps (
                                                                            {detail.logs.length})
                                                                        </h5>
                                                                        {detail.logs.length ===
                                                                        0 ? (
                                                                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                                                                No step logs were
                                                                                recorded for this
                                                                                run.
                                                                            </p>
                                                                        ) : (
                                                                            <ol className="divide-y divide-border dark:divide-border-dark rounded-md border border-border dark:border-border-dark overflow-hidden">
                                                                                {detail.logs.map(
                                                                                    (log) => (
                                                                                        <li
                                                                                            key={
                                                                                                log.id
                                                                                            }
                                                                                            className="flex items-start gap-2 bg-card dark:bg-transparent px-3 py-2 text-xs"
                                                                                        >
                                                                                            <span
                                                                                                className={cn(
                                                                                                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                                                                                                    LOG_LEVEL_STYLES[
                                                                                                        log
                                                                                                            .level
                                                                                                    ],
                                                                                                )}
                                                                                            >
                                                                                                {
                                                                                                    log.level
                                                                                                }
                                                                                            </span>
                                                                                            <span className="shrink-0 rounded-md border border-border dark:border-border-dark px-1.5 py-0.5 text-[10px] font-mono text-text-muted dark:text-text-muted-dark">
                                                                                                {
                                                                                                    log.step
                                                                                                }
                                                                                            </span>
                                                                                            <div className="min-w-0 flex-1">
                                                                                                <p className="text-text dark:text-text-dark whitespace-pre-wrap break-words">
                                                                                                    {
                                                                                                        log.message
                                                                                                    }
                                                                                                </p>
                                                                                                {log.metadata &&
                                                                                                Object.keys(
                                                                                                    log.metadata,
                                                                                                )
                                                                                                    .length >
                                                                                                    0 ? (
                                                                                                    <details className="mt-1">
                                                                                                        <summary className="cursor-pointer text-[10px] text-text-muted dark:text-text-muted-dark">
                                                                                                            metadata
                                                                                                        </summary>
                                                                                                        <pre className="mt-1 overflow-x-auto rounded-md border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark p-2.5 text-[11px] font-mono text-text-secondary dark:text-text-secondary-dark">
                                                                                                            {JSON.stringify(
                                                                                                                log.metadata,
                                                                                                                null,
                                                                                                                2,
                                                                                                            )}
                                                                                                        </pre>
                                                                                                    </details>
                                                                                                ) : null}
                                                                                            </div>
                                                                                            <Timestamp
                                                                                                value={
                                                                                                    log.createdAt
                                                                                                }
                                                                                                variant="relative"
                                                                                                className="shrink-0 text-[10px] text-text-muted dark:text-text-muted-dark"
                                                                                            />
                                                                                        </li>
                                                                                    ),
                                                                                )}
                                                                            </ol>
                                                                        )}
                                                                    </section>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        Showing {rows.length === 0 ? 0 : meta.offset + 1} to{' '}
                        {meta.offset + rows.length} of {meta.total} runs
                    </p>
                    <div className="flex items-center gap-3">
                        <span className="text-sm text-text-muted dark:text-text-muted-dark">
                            Page {page} of {totalPages}
                        </span>
                        <div className="flex gap-1.5">
                            <button
                                onClick={() => refresh(Math.max(0, meta.offset - meta.limit))}
                                disabled={meta.offset === 0 || pending}
                                className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                            >
                                Previous
                            </button>
                            <button
                                onClick={() => refresh(meta.offset + meta.limit)}
                                disabled={meta.offset + meta.limit >= meta.total || pending}
                                className="px-2.5 py-1 text-xs rounded-md border border-border dark:border-border-dark disabled:opacity-40 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
