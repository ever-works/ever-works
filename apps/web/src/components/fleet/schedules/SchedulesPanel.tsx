'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { fleetNodeScheduleRowId, type FleetNodeView, type FleetScheduleView } from '@ever-works/contracts';
import { pauseSchedule, resumeSchedule, runScheduleNow } from '@/app/actions/dashboard/schedules';
import { Button } from '@/components/ui/button';
import { NewNodeScheduleDialog } from './NewNodeScheduleDialog';
import { ScheduleRunHistory } from './ScheduleRunHistory';
import { schedulesClient } from './schedules.client';
import { runStatusKey, SCHEDULE_GLYPHS, scheduleRowGlyph, twoZoneTime, viewerTimeZone } from './schedules.shared';

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
export function SchedulesPanel({ node, nodes }: { node: FleetNodeView; nodes: FleetNodeView[] }) {
    const t = useTranslations('fleet.schedules');
    const search = useSearchParams();
    const [rows, setRows] = useState<FleetScheduleView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const prefillCommand = search?.get('command') ?? null;
    const [dialog, setDialog] = useState<DialogState | null>(
        prefillCommand
            ? { mode: 'create', initial: null, prefill: { command: prefillCommand, cwd: search?.get('cwd') ?? undefined } }
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
        const result = await schedulesClient.list(node.id);
        if (result.ok) {
            setRows(result.data);
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

    const act = async (schedule: FleetScheduleView, action: 'run' | 'pause' | 'resume' | 'delete') => {
        setBusyId(schedule.id);
        setNotice(null);
        const rowId = fleetNodeScheduleRowId(schedule.id);
        try {
            if (action === 'run') {
                if (!window.confirm(t('confirmRun', { name: schedule.name, computer: node.name }))) return;
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
                    if (!window.confirm(t('confirmDelete', { name: schedule.name, computer: node.name, runs: runCount }))) {
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

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if ((event.key === 'n' || event.key === 'N') && !dialog && supported) {
            event.preventDefault();
            setDialog({ mode: 'create', initial: null, prefill: null });
        }
    };

    if (!supported) {
        return (
            <p className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-schedules-unsupported">
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
                <Button size="sm" onClick={() => setDialog({ mode: 'create', initial: null, prefill: null })} data-testid="fleet-schedules-new">
                    {t('tab.new')}
                </Button>
            </div>
            {!managed ? (
                <p className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs" role="status">
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
                        <div key={index} className="h-9 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <div className="rounded border border-dashed border-border p-4 text-sm dark:border-border-dark" data-testid="fleet-schedules-empty">
                    <p className="font-medium">{t('tab.emptyTitle', { computer: node.name })}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('tab.emptyExample')}</p>
                </div>
            ) : (
                <ul className="divide-y divide-border rounded border border-border dark:divide-border-dark dark:border-border-dark">
                    {rows.map((schedule) => {
                        const glyph = scheduleRowGlyph(schedule);
                        const next = twoZoneTime(schedule.nextRunAt, schedule.nodeTimeZone, viewerZone);
                        const disabled = busyId === schedule.id;
                        return (
                            <li key={schedule.id} data-testid="fleet-schedule-row">
                                <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                        aria-expanded={expanded === schedule.id}
                                        onClick={() => setExpanded(expanded === schedule.id ? null : schedule.id)}
                                    >
                                        <span aria-label={t(`glyphs.${glyph}`)} title={t(`glyphs.${glyph}`)}>
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
                                                      ? t('row.nextTwoZones', { computer: next.computer, viewer: next.viewer })
                                                      : t('row.next', { computer: next.computer })
                                                  : t('row.noNext')}
                                    </span>
                                    {schedule.lastRun ? (
                                        <span className="text-xs">
                                            {t('row.last', { status: t(`statuses.${runStatusKey(schedule.lastRun.status)}`) })}
                                        </span>
                                    ) : null}
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-schedule-sync">
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
                                            variant="outline"
                                            size="sm"
                                            disabled={disabled || !schedule.linkUp || schedule.neverRuns !== null}
                                            title={!schedule.linkUp ? t('reasons.offline', { computer: node.name }) : undefined}
                                            onClick={() => void act(schedule, 'run')}
                                        >
                                            {t('actions.runNow')}
                                        </Button>
                                        {schedule.enabled ? (
                                            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act(schedule, 'pause')}>
                                                {t('actions.pause')}
                                            </Button>
                                        ) : (
                                            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act(schedule, 'resume')}>
                                                {t('actions.resume')}
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => setDialog({ mode: 'edit', initial: schedule, prefill: null })}
                                        >
                                            {t('actions.edit')}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={disabled}
                                            onClick={() => setDialog({ mode: 'duplicate', initial: schedule, prefill: null })}
                                        >
                                            {t('actions.duplicate')}
                                        </Button>
                                        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void act(schedule, 'delete')}>
                                            {t('actions.delete')}
                                        </Button>
                                    </div>
                                </div>
                                {expanded === schedule.id ? (
                                    <ScheduleRunHistory schedule={schedule} viewerZone={viewerZone} />
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('tab.noCredits')}</p>
        </div>
    );
}
