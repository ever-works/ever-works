'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, MoreHorizontal, RefreshCw } from 'lucide-react';
import type {
    FleetLinkError,
    FleetOperationRef,
    FleetServiceAction,
    FleetServiceActionResult,
    FleetServiceView,
} from '@ever-works/contracts';
import { fleetServiceAction, listFleetServicesAction } from '@/app/actions/fleet/machine';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { computerActionAllowed, type FleetComputerTabProps } from '../registry';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { MachineTabNotice } from '../machine/MachineTabNotice';
import { RootRequiredDialog } from '../machine/RootRequiredDialog';
import { dialogForRow, formatBytes, formatPercent, formatSince } from '../machine/machine-actions.shared';
import { useMachineAction } from '../machine/use-machine-action';
import { useMachineList } from '../machine/use-machine-list';
import {
    atBootAction,
    primaryActions,
    riskMarker,
    serviceCounts,
    stateGlyph,
    visibleServices,
} from './services.shared';
import { openLogsForSource } from '../logs/logs-tab.registry';

/** The list refreshes every 30 s while the tab is visible (FR-6). */
const REFRESH_MS = 30_000;

/**
 * Services on computers (FL-09 P1, spec §5.1) — the Services tab of a
 * computer page: failed first, then running (with CPU and memory), then the
 * rest; a find field; Start / Restart / Stop on the row and At boot, Log and
 * Copy name under ⋯. Every act opens the confirm dialog its class needs (a
 * red "… anyway" with the node's sentence for a blast radius), a root act the
 * machine will not run without a password opens the root dialog with the
 * exact command, and the node's own service has a marker and no buttons.
 */
export default function ServicesTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.services');
    const tActions = useTranslations('fleet.actions');
    const [find, setFind] = useState('');
    const allowed = computerActionAllowed(node, 'services');
    const load = useCallback(() => listFleetServicesAction(node.id), [node.id]);
    const list = useMachineList(load, REFRESH_MS);
    const machineAction = useMachineAction<FleetServiceActionResult | FleetOperationRef>();

    const rows = useMemo(() => visibleServices(list.data?.services ?? [], find), [list.data, find]);
    const counts = serviceCounts(list.data?.services ?? []);

    const actionLabel = (action: FleetServiceAction): string => t(`act.${action}`);

    const onError = (error: FleetLinkError) => {
        toast.error(error.hint ? t('actionFailedWith', { hint: error.hint }) : t('actionFailed'));
    };

    const act = (service: FleetServiceView, action: FleetServiceAction) => {
        const title =
            action === 'enable'
                ? t('dialog.enableTitle', { name: service.name, machine: node.name })
                : action === 'disable'
                  ? t('dialog.disableTitle', { name: service.name, machine: node.name })
                  : t('dialog.title', { action: actionLabel(action), name: service.name, machine: node.name });
        const body =
            action === 'restart'
                ? t('dialog.restartBody', { name: service.name })
                : action === 'stop'
                  ? t('dialog.stopBody', { name: service.name })
                  : undefined;
        const warned = action === 'stop' || action === 'restart' || action === 'disable' ? service.blastRadius : null;
        machineAction.request({
            key: `${service.id}:${action}`,
            dialog: dialogForRow({ class: service.confirmation[action], title, body, blastRadius: warned }),
            actionLabel: actionLabel(action),
            run: (fields) =>
                fleetServiceAction(node.id, {
                    name: service.name,
                    action,
                    scope: service.scope,
                    manager: service.manager,
                    fields,
                }),
            onDone: (result) => {
                if ('operationId' in result) toast.message(t('stillWorking', { name: service.name }));
                else toast.success(t('done', { action: actionLabel(action), name: service.name, state: t(`states.${result.state}`) }));
                void list.refresh();
            },
            onError,
        });
    };

    const copyName = async (name: string) => {
        try {
            await navigator.clipboard.writeText(name);
            toast.success(t('copied', { name }));
        } catch {
            toast.error(t('copyFailed'));
        }
    };

    if (!list.data && list.loading) {
        return (
            <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-services-loading">
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
                testId="fleet-services-notice"
            />
        );
    }
    const data = list.data;
    if (!data) return null;
    if (data.managers.length === 0) {
        return (
            <p role="status" className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 text-center text-sm" data-testid="fleet-services-no-manager">
                {t('noManager', { name: node.name })}
            </p>
        );
    }

    return (
        <section className="space-y-3" data-testid="fleet-services-tab" aria-label={t('title')}>
            {list.error ? (
                <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm" data-testid="fleet-services-stale">
                    {list.error.code === 'kill_switch' ? tActions('states.killSwitchLastKnown') : tActions('states.lastKnown', { name: node.name })}
                </p>
            ) : null}
            {data.errors?.map((error) => (
                <p key={`${error.manager}:${error.scope}`} role="status" className="text-sm text-danger">
                    {t('listError', { manager: error.manager, name: node.name, message: error.message })}
                </p>
            ))}
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-text dark:text-text-dark">
                    {t('heading', { count: counts.total })}
                </h2>
                <input
                    type="search"
                    value={find}
                    onChange={(event) => setFind(event.target.value)}
                    placeholder={t('find')}
                    aria-label={t('find')}
                    className="h-8 w-56 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm"
                    data-testid="fleet-services-find"
                />
                <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('order')}</span>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void list.refresh()}
                    aria-label={t('refresh')}
                    className="ml-auto"
                >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    <span className="ml-1 text-xs">{t('every30s')}</span>
                </Button>
            </div>
            {!allowed ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark" data-testid="fleet-services-read-only">
                    {t('ownerOnly', { name: node.name })}
                </p>
            ) : null}
            {rows.length === 0 ? (
                <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark">
                    {find ? t('noMatch') : t('empty', { name: node.name })}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border dark:border-border-dark">
                    <table className="w-full text-sm" data-testid="fleet-services-table">
                        <thead className="text-left text-xs uppercase text-text-muted dark:text-text-muted-dark">
                            <tr>
                                <th className="px-3 py-2">{t('columns.name')}</th>
                                <th className="px-3 py-2">{t('columns.state')}</th>
                                <th className="px-3 py-2">{t('columns.since')}</th>
                                <th className="px-3 py-2 text-right">{t('columns.cpu')}</th>
                                <th className="px-3 py-2 text-right">{t('columns.memory')}</th>
                                <th className="px-3 py-2">
                                    <span className="sr-only">{t('columns.actions')}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((service) => {
                                const marker = riskMarker(service);
                                const boot = atBootAction(service);
                                const busy = machineAction.busyKey?.startsWith(`${service.id}:`) ?? false;
                                const since = formatSince(service.since);
                                return (
                                    <tr
                                        key={service.id}
                                        className="border-t border-border dark:border-border-dark"
                                        data-testid="fleet-service-row"
                                        data-name={service.name}
                                        data-state={service.state}
                                    >
                                        <td className="px-3 py-2">
                                            <span
                                                aria-hidden
                                                className={service.state === 'failed' ? 'text-danger' : service.state === 'running' ? 'text-success' : 'text-text-muted dark:text-text-muted-dark'}
                                            >
                                                {stateGlyph(service)}
                                            </span>{' '}
                                            <span className="font-medium">{service.name}</span>
                                            {service.scope === 'user' ? (
                                                <span className="ml-1 text-xs text-text-muted dark:text-text-muted-dark">{t('userScope')}</span>
                                            ) : null}
                                            {service.description ? (
                                                <span className="block truncate text-xs text-text-muted dark:text-text-muted-dark">{service.description}</span>
                                            ) : null}
                                        </td>
                                        <td className="px-3 py-2">
                                            {busy ? t('working') : t(`states.${service.state}`)}
                                            {service.state === 'failed' && service.exitCode !== null ? (
                                                <span className="ml-1 text-xs text-text-muted dark:text-text-muted-dark">{t('exited', { code: service.exitCode })}</span>
                                            ) : null}
                                        </td>
                                        <td className="px-3 py-2 text-xs">
                                            {since ?? '—'}
                                            {' · '}
                                            {service.atBoot === null ? '—' : service.atBoot ? (service.scope === 'user' ? t('atLogin') : t('atBoot')) : t('manual')}
                                        </td>
                                        <td className="px-3 py-2 text-right tabular-nums">{formatPercent(service.cpuPercent)}</td>
                                        <td className="px-3 py-2 text-right tabular-nums">{formatBytes(service.memBytes)}</td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1">
                                                {marker ? (
                                                    <span
                                                        className="inline-flex items-center gap-1 text-xs text-warning"
                                                        title={marker === 'node' ? t('thisNodeTooltip') : t('riskTooltip', { name: node.name })}
                                                        data-testid="fleet-service-risk"
                                                        data-kind={marker}
                                                    >
                                                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                                                        {t(`risk.${marker}`)}
                                                    </span>
                                                ) : null}
                                                {primaryActions(service).map((action) => (
                                                    <Button
                                                        key={action}
                                                        type="button"
                                                        size="sm"
                                                        variant={action === 'start' ? 'primary' : 'secondary'}
                                                        disabled={!allowed || busy}
                                                        title={!allowed ? t('ownerOnly', { name: node.name }) : undefined}
                                                        onClick={() => act(service, action)}
                                                        data-testid={`fleet-service-${action}`}
                                                    >
                                                        {actionLabel(action)}
                                                    </Button>
                                                ))}
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button type="button" variant="ghost" size="sm" aria-label={t('more', { name: service.name })}>
                                                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent align="end">
                                                        {boot ? (
                                                            <DropdownMenuItem disabled={!allowed || busy} onClick={() => act(service, boot)}>
                                                                {boot === 'enable' ? t('enableAtBoot') : t('disableAtBoot')}
                                                            </DropdownMenuItem>
                                                        ) : null}
                                                        <DropdownMenuItem asChild>
                                                            <Link
                                                                href={
                                                                    // FL-08 P3 (FR-39): a failed service opens its log at the failure time.
                                                                    service.state === 'failed'
                                                                        ? openLogsForSource(node.id, `service:${service.name}`, { at: service.since })
                                                                        : `${ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'logs')}&source=service&unit=${encodeURIComponent(service.name)}`
                                                                }
                                                            >
                                                                {t('log')}
                                                            </Link>
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem onClick={() => void copyName(service.name)}>{t('copyName')}</DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
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
