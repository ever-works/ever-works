'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Cpu } from 'lucide-react';
import type {
    FleetLinkError,
    FleetOperationRef,
    FleetProcessSignal,
    FleetProcessSignalResult,
    FleetProcessSort,
    FleetProcessView,
} from '@ever-works/contracts';
import { listFleetProcessesAction, signalFleetProcessAction } from '@/app/actions/fleet/machine';
import { Button } from '@/components/ui/button';
import { computerActionAllowed, type FleetComputerTabProps } from '../registry';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { MachineTabNotice } from '../machine/MachineTabNotice';
import { RootRequiredDialog } from '../machine/RootRequiredDialog';
import { formatBytes, formatPercent, formatRuntime } from '../machine/machine-actions.shared';
import { useMachineAction } from '../machine/use-machine-action';
import { useMachineList } from '../machine/use-machine-list';
import { gpuParts, isProtected, shouldOfferKill, STILL_RUNNING_AFTER_MS, visibleProcesses } from './processes.shared';

/** The list refreshes every 5 s while the tab is visible (FR-9). */
const REFRESH_MS = 5_000;

/**
 * Processes on computers (FL-09 P1, spec §5.4) — the GPUs above the busiest
 * 300 processes by CPU (or memory), with Stop (SIGTERM) and Kill (SIGKILL)
 * behind a confirmation naming the process and its pid. The node's own
 * process tree, its session daemon and PID 1 carry a marker and no buttons.
 * After Stop, a process still there 5 s later offers "still running — Kill?".
 */
export default function ProcessesTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.processes');
    const tActions = useTranslations('fleet.actions');
    const [find, setFind] = useState('');
    const [sort, setSort] = useState<FleetProcessSort>('cpu');
    const [stopped, setStopped] = useState<Record<number, number>>({});
    const [now, setNow] = useState(() => Date.now());
    const allowed = computerActionAllowed(node, 'processes');
    const load = useCallback(() => listFleetProcessesAction(node.id, { sort }), [node.id, sort]);
    const list = useMachineList(load, REFRESH_MS);
    const machineAction = useMachineAction<FleetProcessSignalResult | FleetOperationRef>();

    useEffect(() => {
        if (Object.keys(stopped).length === 0) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [stopped]);

    const rows = useMemo(() => visibleProcesses(list.data?.processes ?? [], find), [list.data, find]);
    const listed = useMemo(() => new Set((list.data?.processes ?? []).map((row) => row.pid)), [list.data]);

    const onError = (error: FleetLinkError) => {
        toast.error(error.hint ? t('signalFailedWith', { hint: error.hint }) : t('signalFailed'));
    };

    const signal = (process: FleetProcessView, which: FleetProcessSignal) => {
        const title =
            which === 'KILL'
                ? t('dialog.killTitle', { name: process.name, pid: process.pid, machine: node.name })
                : t('dialog.stopTitle', { name: process.name, pid: process.pid, machine: node.name });
        machineAction.request({
            key: `pid:${process.pid}`,
            dialog: {
                class: 'confirm',
                title,
                ...(which === 'KILL' ? { body: t('dialog.killBody') } : {}),
            },
            actionLabel: which === 'KILL' ? t('kill') : t('stop'),
            run: (fields) => signalFleetProcessAction(node.id, { pid: process.pid, signal: which, fields }),
            onDone: (result) => {
                if (which === 'TERM') {
                    setStopped((previous) => ({ ...previous, [process.pid]: Date.now() }));
                    setNow(Date.now());
                } else {
                    setStopped((previous) => {
                        const next = { ...previous };
                        delete next[process.pid];
                        return next;
                    });
                }
                if (!('operationId' in result) && result.stillRunningAfterMs === null) {
                    toast.success(t('gone', { name: process.name, pid: process.pid }));
                }
                void list.refresh();
            },
            onError,
        });
    };

    if (!list.data && list.loading) {
        return (
            <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-processes-loading">
                {list.slow ? tActions('states.slow', { name: node.name }) : tActions('states.asking', { name: node.name })}
            </p>
        );
    }
    if (!list.data && list.error) {
        return (
            <MachineTabNotice
                error={list.error}
                machine={node.name}
                family={t('family')}
                onRetry={() => void list.refresh()}
                testId="fleet-processes-notice"
            />
        );
    }
    const data = list.data;
    if (!data) return null;

    return (
        <section className="space-y-3" data-testid="fleet-processes-tab" aria-label={t('title')}>
            {list.error ? (
                <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm" data-testid="fleet-processes-stale">
                    {list.error.code === 'kill_switch' ? tActions('states.killSwitchLastKnown') : tActions('states.lastKnown', { name: node.name })}
                </p>
            ) : null}
            {data.gpus.length > 0 ? (
                <ul className="flex flex-wrap gap-3" aria-label={t('gpu.title')} data-testid="fleet-processes-gpus">
                    {data.gpus.map((gpu, index) => {
                        const parts = gpuParts(gpu);
                        return (
                            <li
                                key={`${gpu.model ?? gpu.vendor}-${index}`}
                                className="flex items-center gap-2 rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-sm"
                                data-testid="fleet-processes-gpu"
                            >
                                <Cpu className="h-4 w-4 text-text-muted dark:text-text-muted-dark" aria-hidden />
                                <span className="font-medium">
                                    {data.gpus.length > 1 ? t('gpu.numbered', { index: index + 1 }) : t('gpu.label')}
                                </span>
                                <span>{parts.model}</span>
                                {parts.memory ? (
                                    <span>· {parts.shared ? t('gpu.shared', { memory: parts.memory }) : parts.memory}</span>
                                ) : null}
                                <span>
                                    ·{' '}
                                    {parts.utilization === null
                                        ? t('gpu.utilizationUnavailable')
                                        : formatPercent(parts.utilization)}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-text dark:text-text-dark">
                    {sort === 'mem' ? t('largest', { count: data.total }) : t('busiest', { count: data.total })}
                </h2>
                <input
                    type="search"
                    value={find}
                    onChange={(event) => setFind(event.target.value)}
                    placeholder={t('find')}
                    aria-label={t('find')}
                    className="h-8 w-56 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm"
                    data-testid="fleet-processes-find"
                />
                <label className="flex items-center gap-1 text-xs">
                    <span>{t('sortBy')}</span>
                    <select
                        value={sort}
                        onChange={(event) => setSort(event.target.value === 'mem' ? 'mem' : 'cpu')}
                        className="h-8 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-1"
                    >
                        <option value="cpu">{t('columns.cpu')}</option>
                        <option value="mem">{t('columns.memory')}</option>
                    </select>
                </label>
                <span className="ml-auto text-xs text-text-muted dark:text-text-muted-dark">{t('every5s')}</span>
            </div>
            {!allowed ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-processes-read-only">
                    {t('ownerOnly', { name: node.name })}
                </p>
            ) : null}
            <div className="overflow-x-auto rounded-xl border border-border dark:border-border-dark">
                <table className="w-full text-sm" data-testid="fleet-processes-table">
                    <thead className="text-left text-xs uppercase text-text-muted dark:text-text-muted-dark">
                        <tr>
                            <th className="px-3 py-2">{t('columns.pid')}</th>
                            <th className="px-3 py-2">{t('columns.name')}</th>
                            <th className="px-3 py-2 text-right">{t('columns.cpu')}</th>
                            <th className="px-3 py-2 text-right">{t('columns.memory')}</th>
                            <th className="px-3 py-2">{t('columns.owner')}</th>
                            <th className="px-3 py-2">{t('columns.runtime')}</th>
                            <th className="px-3 py-2">{t('columns.command')}</th>
                            <th className="px-3 py-2">
                                <span className="sr-only">{t('columns.actions')}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((process) => {
                            const busy = machineAction.busyKey === `pid:${process.pid}`;
                            const offerKill = shouldOfferKill(stopped[process.pid], listed.has(process.pid), now);
                            const stopping = stopped[process.pid] !== undefined && !offerKill;
                            return (
                                <tr
                                    key={process.pid}
                                    className="border-t border-border dark:border-border-dark align-top"
                                    data-testid="fleet-process-row"
                                    data-pid={process.pid}
                                >
                                    <td className="px-3 py-1.5 tabular-nums">{process.pid}</td>
                                    <td className="px-3 py-1.5 font-medium">{process.name}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{formatPercent(process.cpuPercent)}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{formatBytes(process.memBytes)}</td>
                                    <td className="px-3 py-1.5">{process.owner ?? '—'}</td>
                                    <td className="px-3 py-1.5 tabular-nums">{formatRuntime(process.runtimeSec)}</td>
                                    <td className="px-3 py-1.5 max-w-md truncate font-mono text-xs" title={process.command}>
                                        {process.command}
                                    </td>
                                    <td className="px-3 py-1.5">
                                        {isProtected(process) ? (
                                            <span
                                                className="inline-flex items-center gap-1 text-xs text-warning"
                                                data-testid="fleet-process-protected"
                                                data-kind={process.protected ?? undefined}
                                            >
                                                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                                                {process.protected === 'init' ? t('protectedInit') : t('protectedNode')}
                                            </span>
                                        ) : (
                                            <div className="flex items-center justify-end gap-1">
                                                {stopping ? (
                                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('stopping')}</span>
                                                ) : null}
                                                {offerKill ? (
                                                    <span className="text-xs text-warning" data-testid="fleet-process-still-running">
                                                        {t('stillRunning')}
                                                    </span>
                                                ) : null}
                                                {!stopping && !offerKill ? (
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="secondary"
                                                        disabled={!allowed || busy}
                                                        onClick={() => signal(process, 'TERM')}
                                                        data-testid="fleet-process-stop"
                                                    >
                                                        {t('stop')}
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant={offerKill ? 'danger' : 'ghost'}
                                                    disabled={!allowed || busy}
                                                    onClick={() => signal(process, 'KILL')}
                                                    data-testid="fleet-process-kill"
                                                >
                                                    {t('kill')}
                                                </Button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="sr-only" aria-live="polite">
                {t('stillRunningHint', { seconds: STILL_RUNNING_AFTER_MS / 1000 })}
            </p>
            <ConfirmActionDialog
                model={machineAction.dialog}
                actionLabel={machineAction.actionLabel}
                pending={machineAction.isPending}
                onConfirm={machineAction.confirm}
                onCancel={machineAction.cancel}
            />
            <RootRequiredDialog model={machineAction.root} machine={node.name} onClose={machineAction.closeRoot} />
        </section>
    );
}
