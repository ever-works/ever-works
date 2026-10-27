'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    fleetNodeScheduleRowId,
    type FleetNodeView,
    type FleetScheduleView,
    type FleetUsageTaskCost,
} from '@ever-works/contracts';
import { getFleetUsageTaskCostsAction } from '@/app/actions/fleet/usage';
import { pauseSchedule, resumeSchedule, runScheduleNow } from '@/app/actions/dashboard/schedules';
import { Button } from '@/components/ui/button';
import { NewNodeScheduleDialog } from './NewNodeScheduleDialog';
import { ScheduleRunHistory } from './ScheduleRunHistory';
import { ScheduleUsageCost } from './ScheduleUsageCost';
import { schedulesClient } from './schedules.client';
import {
    runStatusKey,
    SCHEDULE_GLYPHS,
    scheduleRowGlyph,
    twoZoneTime,
    viewerTimeZone,
    type AgentSessionScheduleRow,
} from './schedules.shared';

/** How often the list is read again while something runs or waits to sync; otherwise. */
const FAST_POLL_MS = 10_000;
const SLOW_POLL_MS = 30_000;

type DialogState =
    | { mode: 'create'; initial: null; prefill: { command?: string; cwd?: string } | null }
    | { mode: 'edit' | 'duplicate'; initial: FleetScheduleView; prefill: null };

/**
 * Schedules on computers (FL-13, spec §5.1, §5.3, S1 … S6, U1 … U16) — a
 * computer page's Schedules tab: the header names both time zones; each row
 * shows its glyph (● active · ◐ running · ⏸ paused · ⚠ never runs), name,
 * command, next fire on the computer's clock and the viewer's, the last
 * outcome, whether the computer holds the latest copy, and its menu (Run now,
 * Pause / Resume, Edit, Duplicate, Delete — Move is the dialog's computer
 * field). Selecting a row opens its history. `N` opens New schedule.
 */
export function SchedulesPanel({
    node,
    nodes,
    usage = false,
}: {
    node: FleetNodeView;
    nodes: FleetNodeView[];
    /** FL-20 P2 (spec FR-16): `FLEET_USAGE_SCAN_ENABLED` — Agent-session rows show their list-price cost. */
    usage?: boolean;
}) {
    const t = useTranslations('fleet.schedules');
    const search = useSearchParams();
    const [rows, setRows] = useState<FleetScheduleView[] | null>(null);
    // FL-13 P2 — Agent-session schedules (pinned recurring Tasks) and the breaker's Undo.
    const [agentRows, setAgentRows] = useState<AgentSessionScheduleRow[]>([]);
    // FL-20 P2 — each Agent-session schedule's last-run and 30-day cost, by Task id.
    const [taskCosts, setTaskCosts] = useState<Map<string, FleetUsageTaskCost>>(new Map());
    const taskIdsKey = agentRows
        .map((row) => row.taskId)
        .filter(Boolean)
        .sort()
        .join(',');
    useEffect(() => {
        if (!usage || !taskIdsKey) return;
        let cancelled = false;
        void getFleetUsageTaskCostsAction(taskIdsKey.split(',')).then((result) => {
            if (!cancelled && result.ok)
                setTaskCosts(new Map(result.data.tasks.map((cost) => [cost.taskId, cost])));
        });
        return () => {
            cancelled = true;
        };
    }, [usage, taskIdsKey]);
    const [breaker, setBreaker] = useState<{
        breakerAt: string;
        undoUntil: number;
        count: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const prefillCommand = search?.get('command') ?? null;
    const [dialog, setDialog] = useState<DialogState | null>(
        prefillCommand
            ? {
                  mode: 'create',
                  initial: null,
                  prefill: { command: prefillCommand, cwd: search?.get('cwd') ?? undefined },
              }
            : null,
    );
    const viewerZone = useMemo(() => viewerTimeZone(), []);
    const computerZone = node.timeZone ?? null;
    const managed = node.consents?.manage === true;
    const supported = node.kind === 'node';
    const candidates = useMemo(() => {
        const list = nodes.some((candidate) => candidate.id === node.id) ? nodes : [node, ...nodes];
        return list.filter((candidate) => candidate.kind === 'node');
    }, [nodes, node]);

    const load = useCallback(async () => {
        const result = await schedulesClient.listAll(node.id);
        if (result.ok) {
            setRows(result.data.commands);
            setAgentRows(result.data.agentSessions);
            setError(null);
        } else {
            setError(result.error.hint ?? t('errors.load'));
        }
    }, [node.id, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const busy = rows?.some((row) => row.running || row.syncState === 'pending') ?? false;
    useEffect(() => {
        const timer = setInterval(() => void load(), busy ? FAST_POLL_MS : SLOW_POLL_MS);
        return () => clearInterval(timer);
    }, [busy, load]);

    const act = async (
        schedule: FleetScheduleView,
        action: 'run' | 'pause' | 'resume' | 'delete',
    ) => {
        setBusyId(schedule.id);
        setNotice(null);
        const rowId = fleetNodeScheduleRowId(schedule.id);
        try {
            if (action === 'run') {
                if (!window.confirm(t('confirmRun', { name: schedule.name, computer: node.name })))
                    return;
                const result = await runScheduleNow(rowId, { confirm: true });
                setNotice(result.ok ? t('runStarted', { name: schedule.name }) : t('errors.run'));
            } else if (action === 'pause') {
                const result = await pauseSchedule(rowId);
                if (!result.ok) setNotice(t('errors.pause'));
            } else if (action === 'resume') {
                const result = await resumeSchedule(rowId);
                if (!result.ok) setNotice(t('errors.resume'));
            } else {
                const first = await schedulesClient.remove(schedule.id, false);
                if (!first.ok && first.error.code === 'confirmation_required') {
                    const runCount = Number(first.error.details.runCount ?? 0);
                    if (
                        !window.confirm(
                            t('confirmDelete', {
                                name: schedule.name,
                                computer: node.name,
                                runs: runCount,
                            }),
                        )
                    ) {
                        return;
                    }
                    const second = await schedulesClient.remove(schedule.id, true);
                    if (!second.ok) setNotice(second.error.hint ?? t('errors.delete'));
                } else if (!first.ok) {
                    setNotice(first.error.hint ?? t('errors.delete'));
                }
            }
        } finally {
            setBusyId(null);
            await load();
        }
    };

    /** Pause all on this computer (FR-22): the count first, then 15 minutes to undo. Never deletes. */
    const pauseAll = async () => {
        setNotice(null);
        const first = await schedulesClient.pauseAll(node.id, false);
        let result = first;
        if (!first.ok && first.error.code === 'confirmation_required') {
            const count = Number(first.error.details.count ?? 0);
            const running = Number(first.error.details.running ?? 0);
            if (!window.confirm(t('breaker.confirm', { count, running, computer: node.name })))
                return;
            result = await schedulesClient.pauseAll(node.id, true);
        }
        if (result.ok) {
            setBreaker({
                breakerAt: result.data.breakerAt,
                undoUntil: Date.parse(result.data.undoUntil),
                count: result.data.paused,
            });
            setNotice(t('breaker.done', { count: result.data.paused, computer: node.name }));
        } else {
            setNotice(result.error.hint ?? t('breaker.failed'));
        }
        await load();
    };

    const undoPauseAll = async () => {
        if (!breaker) return;
        const result = await schedulesClient.undoPauseAll(node.id, breaker.breakerAt);
        setBreaker(null);
        setNotice(
            result.ok
                ? t('breaker.undone', { count: result.data.resumed })
                : (result.error.hint ?? t('breaker.failed')),
        );
        await load();
    };

    const actAgentSession = async (
        row: AgentSessionScheduleRow,
        action: 'run' | 'pause' | 'resume',
    ) => {
        setBusyId(row.id);
        try {
            if (action === 'run') {
                if (!window.confirm(t('confirmRun', { name: row.name, computer: node.name })))
                    return;
                const result = await runScheduleNow(row.id);
                setNotice(result.ok ? t('runStarted', { name: row.name }) : t('errors.run'));
            } else if (action === 'pause') {
                const result = await pauseSchedule(row.id);
                if (!result.ok) setNotice(t('errors.pause'));
            } else {
                const result = await resumeSchedule(row.id);
                if (!result.ok) setNotice(t('errors.resume'));
            }
        } finally {
            setBusyId(null);
            await load();
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT'
        )
            return;
        if ((event.key === 'n' || event.key === 'N') && !dialog && supported) {
            event.preventDefault();
            setDialog({ mode: 'create', initial: null, prefill: null });
        }
    };

    if (!supported) {
        return (
            <p
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-schedules-unsupported"
            >
                {t('tab.unsupportedKind')}
            </p>
        );
    }

    return (
        <div className="space-y-3" onKeyDown={onKeyDown} data-testid="fleet-schedules-tab">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {computerZone
                        ? t('tab.zones', { computer: node.name, zone: computerZone, viewerZone })
                        : t('tab.zonesUnknown', { computer: node.name, viewerZone })}
                </p>
                <div className="flex gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void pauseAll()}
                        disabled={!rows || rows.every((row) => !row.enabled)}
                        data-testid="fleet-schedules-pause-all"
                    >
                        {t('breaker.pauseAll')}
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => setDialog({ mode: 'create', initial: null, prefill: null })}
                        data-testid="fleet-schedules-new"
                    >
                        {t('tab.new')}
                    </Button>
                </div>
            </div>
            {breaker && Date.now() < breaker.undoUntil ? (
                <p
                    className="flex items-center gap-2 text-xs"
                    role="status"
                    data-testid="fleet-schedules-breaker"
                >
                    {t('breaker.done', { count: breaker.count, computer: node.name })}
                    <button type="button" className="underline" onClick={() => void undoPauseAll()}>
                        {t('breaker.undo')}
                    </button>
                </p>
            ) : null}
            {!managed ? (
                <p
                    className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
                    role="status"
                >
                    {t('tab.needsManage', { computer: node.name })}
                </p>
            ) : null}
            {notice ? (
                <p className="text-xs" role="status">
                    {notice}
                </p>
            ) : null}
            {dialog ? (
                <NewNodeScheduleDialog
                    node={node}
                    nodes={candidates}
                    mode={dialog.mode}
                    initial={dialog.initial}
                    prefill={dialog.prefill}
                    onSaved={() => void load()}
                    onClose={() => setDialog(null)}
                />
            ) : null}
            {error ? (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {error}
                </p>
            ) : null}
            {rows === null ? (
                <div className="space-y-2" aria-busy="true">
                    {[0, 1, 2].map((index) => (
                        <div
                            key={index}
                            className="h-9 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark"
                        />
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <div
                    className="rounded border border-dashed border-border p-4 text-sm dark:border-border-dark"
                    data-testid="fleet-schedules-empty"
                >
                    <p className="font-medium">{t('tab.emptyTitle', { computer: node.name })}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('tab.emptyExample')}
                    </p>
                </div>
            ) : (
                <ul className="divide-y divide-border rounded border border-border dark:divide-border-dark dark:border-border-dark">
                    {rows.map((schedule) => {
                        const glyph = scheduleRowGlyph(schedule);
                        const next = twoZoneTime(
                            schedule.nextRunAt,
                            schedule.nodeTimeZone,
                            viewerZone,
                        );
                        const disabled = busyId === schedule.id;
                        return (
                            <li key={schedule.id} data-testid="fleet-schedule-row">
                                <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                        aria-expanded={expanded === schedule.id}
                                        onClick={() =>
                                            setExpanded(
                                                expanded === schedule.id ? null : schedule.id,
                                            )
                                        }
                                    >
                                        <span
                                            aria-label={t(`glyphs.${glyph}`)}
                                            title={t(`glyphs.${glyph}`)}
                                        >
                                            {SCHEDULE_GLYPHS[glyph]}
                                        </span>
                                        <span className="font-medium">{schedule.name}</span>
                                        <span className="truncate font-mono text-xs text-text-muted dark:text-text-muted-dark">
                                            {schedule.command}
                                        </span>
                                    </button>
                                    <span className="text-xs">{schedule.cadenceHuman}</span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {schedule.neverRuns
                                            ? schedule.neverRuns.hint
                                            : !schedule.enabled
                                              ? schedule.pausedReason === 'failures'
                                                  ? t('row.pausedFailures')
                                                  : t('row.paused')
                                              : schedule.running
                                                ? t('row.running')
                                                : next
                                                  ? next.viewer
                                                      ? t('row.nextTwoZones', {
                                                            computer: next.computer,
                                                            viewer: next.viewer,
                                                        })
                                                      : t('row.next', { computer: next.computer })
                                                  : t('row.noNext')}
                                    </span>
                                    {schedule.lastRun ? (
                                        <span className="text-xs">
                                            {t('row.last', {
                                                status: t(
                                                    `statuses.${runStatusKey(schedule.lastRun.status)}`,
                                                ),
                                            })}
                                        </span>
                                    ) : null}
                                    <span
                                        className="text-xs text-text-muted dark:text-text-muted-dark"
                                        data-testid="fleet-schedule-sync"
                                    >
                                        {schedule.syncState === 'pending'
                                            ? t('sync.pending', { computer: node.name })
                                            : schedule.syncState === 'unsupported'
                                              ? t('sync.unsupported', { computer: node.name })
                                              : schedule.syncState === 'refused'
                                                ? (schedule.syncError?.hint ?? t('sync.refused'))
                                                : t('sync.synced', { computer: node.name })}
                                    </span>
                                    <div className="flex flex-wrap gap-1">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={
                                                disabled ||
                                                !schedule.linkUp ||
                                                schedule.neverRuns !== null
                                            }
                                            title={
                                                !schedule.linkUp
                                                    ? t('reasons.offline', { computer: node.name })
                                                    : undefined
                                            }
                                            onClick={() => void act(schedule, 'run')}
                                        >
                                            {t('actions.runNow')}
                                        </Button>
                                        {schedule.enabled ? (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={disabled}
                                                onClick={() => void act(schedule, 'pause')}
                                            >
                                                {t('actions.pause')}
                                            </Button>
                                        ) : (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={disabled}
                                                onClick={() => void act(schedule, 'resume')}
                                            >
                                                {t('actions.resume')}
                                            </Button>
                                        )}
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() =>
                                                setDialog({
                                                    mode: 'edit',
                                                    initial: schedule,
                                                    prefill: null,
                                                })
                                            }
                                        >
                                            {t('actions.edit')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() =>
                                                setDialog({
                                                    mode: 'duplicate',
                                                    initial: schedule,
                                                    prefill: null,
                                                })
                                            }
                                        >
                                            {t('actions.duplicate')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => void act(schedule, 'delete')}
                                        >
                                            {t('actions.delete')}
                                        </Button>
                                    </div>
                                </div>
                                {expanded === schedule.id ? (
                                    <ScheduleRunHistory
                                        schedule={schedule}
                                        viewerZone={viewerZone}
                                    />
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
            {agentRows.length > 0 ? (
                <section className="space-y-2" data-testid="fleet-schedules-agent-sessions">
                    <h4 className="text-sm font-medium">{t('agentSessions.title')}</h4>
                    <ul className="divide-y divide-border rounded border border-border dark:divide-border-dark dark:border-border-dark">
                        {agentRows.map((row) => {
                            const next = twoZoneTime(
                                row.nextRunAt,
                                node.timeZone ?? null,
                                viewerZone,
                            );
                            const disabled = busyId === row.id;
                            return (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                                >
                                    <span>
                                        {row.paused
                                            ? SCHEDULE_GLYPHS.paused
                                            : SCHEDULE_GLYPHS.active}
                                    </span>
                                    <span className="font-medium">{row.name}</span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('agentSessions.row', {
                                            agent: row.agentName ?? '—',
                                            cadence: row.cadenceHuman,
                                        })}
                                    </span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {row.paused
                                            ? t('agentSessions.paused')
                                            : next
                                              ? t('agentSessions.next', {
                                                    when: next.viewer
                                                        ? t('row.nextTwoZones', {
                                                              computer: next.computer,
                                                              viewer: next.viewer,
                                                          })
                                                        : next.computer,
                                                })
                                              : ''}
                                    </span>
                                    {usage && (
                                        <ScheduleUsageCost cost={taskCosts.get(row.taskId)} />
                                    )}
                                    <div className="flex flex-wrap gap-1">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => void actAgentSession(row, 'run')}
                                        >
                                            {t('actions.runNow')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() =>
                                                void actAgentSession(
                                                    row,
                                                    row.paused ? 'resume' : 'pause',
                                                )
                                            }
                                        >
                                            {row.paused ? t('actions.resume') : t('actions.pause')}
                                        </Button>
                                        <a
                                            className="self-center text-xs underline"
                                            href={`/tasks/${encodeURIComponent(row.taskId)}`}
                                        >
                                            {t('agentSessions.openTask')}
                                        </a>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('agentSessions.costNote')}
                    </p>
                </section>
            ) : null}
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('tab.noCredits')}
            </p>
        </div>
    );
}
