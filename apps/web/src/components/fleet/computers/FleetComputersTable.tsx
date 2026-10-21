'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, Info, Laptop, Pause, Pencil, Play, Server, Trash2 } from 'lucide-react';
import { describeFleetModelProvider } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import type { FleetNodeKind, FleetNodeView } from '@/lib/api/fleet';
import { formatBytes } from '@/components/dashboard/runner-status.shared';

/**
 * The machine table — the enrolled computers with their state, CLI, billing
 * identity, disk, load, capability tags and last check, and the row acts
 * (details, rename, disable / enable, remove).
 *
 * Extracted VERBATIM from Settings → Fleet (`FleetSettings.tsx`) for the Fleet
 * hub's Computers tab (FL-01, T-11): same markup, same test ids, same i18n
 * keys (`dashboard.settings.fleet`), so Settings renders it byte for byte as
 * before. The one addition is the optional `favorites` column the hub passes
 * (a star per row, spec §5.6); without it the table is exactly the old one.
 */

export interface FleetComputersTableFavorites {
    /** Screen-reader label of the star column. */
    columnLabel: string;
    /** The star toggle for one row. */
    renderToggle: (node: FleetNodeView) => ReactNode;
    /** The name cell, when the hub links it to the computer's page. */
    renderName?: (node: FleetNodeView) => ReactNode;
    /** An "Open page" action beside Details (spec §5.6). */
    renderOpen?: (node: FleetNodeView) => ReactNode;
}

interface FleetComputersTableProps {
    nodes: FleetNodeView[];
    isPending: boolean;
    onDetails: (node: FleetNodeView) => void;
    onRename: (node: FleetNodeView) => void;
    onToggleDisabled: (node: FleetNodeView) => void;
    onRemove: (node: FleetNodeView) => void;
    favorites?: FleetComputersTableFavorites;
}

export function formatFleetLastSeen(value: string | null): string {
    if (!value) return '-';
    try {
        return new Date(value).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

export function fleetStatusDotClass(status: FleetNodeView['status']): string {
    switch (status) {
        case 'online':
            return 'bg-success';
        case 'enrolling':
            return 'bg-warning';
        case 'disabled':
            return 'bg-danger';
        default:
            return 'bg-text-muted dark:bg-text-muted-dark';
    }
}

export function FleetComputersTable({
    nodes,
    isPending,
    onDetails,
    onRename,
    onToggleDisabled,
    onRemove,
    favorites,
}: FleetComputersTableProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const kindLabel = (kind: FleetNodeKind): string => t(`kinds.${kind}` as never);
    const statusDotClass = fleetStatusDotClass;
    const formatLastSeen = formatFleetLastSeen;

    return (
        <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
            <table className="w-full text-sm" data-testid="fleet-nodes-table">
                <thead>
                    <tr className="border-b border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-left">
                        {favorites && (
                            <th className="pl-4 pr-0 py-2.5 w-8 font-medium text-text-muted dark:text-text-muted-dark">
                                <span className="sr-only">{favorites.columnLabel}</span>
                            </th>
                        )}
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.name')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.kind')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.status')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.platform')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.cliVersion')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.billingIdentity')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.diskFree')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.load')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.capabilities')}
                        </th>
                        <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                            {t('table.lastSeen')}
                        </th>
                        <th className="px-4 py-2.5" />
                    </tr>
                </thead>
                <tbody>
                    {nodes.map((node) => (
                        <tr
                            key={node.id}
                            className="border-b last:border-b-0 border-border dark:border-border-dark"
                            data-testid={`fleet-node-row-${node.id}`}
                        >
                            {favorites && (
                                <td className="pl-4 pr-0 py-3">{favorites.renderToggle(node)}</td>
                            )}
                            <td className="px-4 py-3 font-medium text-text dark:text-text-dark">
                                {favorites?.renderName ? favorites.renderName(node) : node.name}
                            </td>
                            <td className="px-4 py-3">
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark">
                                    {node.kind === 'desktop-node' ? (
                                        <Laptop className="w-3 h-3" />
                                    ) : (
                                        <Server className="w-3 h-3" />
                                    )}
                                    {kindLabel(node.kind)}
                                </span>
                            </td>
                            <td className="px-4 py-3">
                                <span
                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-text dark:text-text-dark"
                                    data-testid={`fleet-node-status-${node.id}`}
                                >
                                    <span
                                        className={`w-1.5 h-1.5 rounded-full ${statusDotClass(node.status)}`}
                                    />
                                    {t(`statuses.${node.status}` as never)}
                                </span>
                                {/* Fleet usage limits: "online" alone hid a
                                    machine whose model CLI is out of quota. */}
                                {(node.modelThrottles ?? []).map((throttle) => (
                                    <span
                                        key={throttle.provider}
                                        className="mt-1 flex w-fit items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-warning/10 text-warning whitespace-nowrap"
                                        title={throttle.reason}
                                        data-testid={`fleet-node-throttle-${node.id}-${throttle.provider}`}
                                    >
                                        {t('modelThrottles.entry', {
                                            cli: describeFleetModelProvider(throttle.provider),
                                            window: t(
                                                `modelThrottles.windows.${throttle.window}` as never,
                                            ),
                                            until: new Date(throttle.until).toLocaleString(),
                                        })}
                                    </span>
                                ))}
                            </td>
                            <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                {node.platform ?? '-'}
                            </td>
                            {/* Same two telemetry fields the sidebar
                                runner popover shows, so the pill and
                                this table can never tell different
                                stories about the same machine. */}
                            <td
                                className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap"
                                data-testid={`fleet-node-cli-${node.id}`}
                            >
                                {node.cliVersion ?? t('table.cliNotInstalled')}
                            </td>
                            {/* Fleet cost accounting (EW-777): which
                                seat this machine's spend is billed
                                to — observed and shown here; which
                                seat it SHOULD be is the founder's
                                call, not the table's. */}
                            <td
                                className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap"
                                data-testid={`fleet-node-identity-${node.id}`}
                                title={node.modelIdentity ?? undefined}
                            >
                                {node.modelIdentity ?? t('table.identityUnknown')}
                            </td>
                            <td
                                className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap"
                                data-testid={`fleet-node-disk-${node.id}`}
                            >
                                {formatBytes(node.diskFreeBytes) ?? '-'}
                            </td>
                            <td className="px-4 py-3">
                                {(() => {
                                    const activeJobs = node.load?.activeJobCount ?? 0;
                                    return (
                                        <span
                                            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                                                activeJobs > 0
                                                    ? 'text-info'
                                                    : 'text-text-muted dark:text-text-muted-dark'
                                            }`}
                                            data-testid={`fleet-node-load-${node.id}`}
                                            title={
                                                node.load?.currentJobKind
                                                    ? t('load.currentJob', {
                                                          kind: node.load.currentJobKind,
                                                      })
                                                    : undefined
                                            }
                                        >
                                            {activeJobs > 0 ? (
                                                <>
                                                    <Activity className="w-3 h-3" />
                                                    {t('load.busy', { count: activeJobs })}
                                                </>
                                            ) : (
                                                t('load.idle')
                                            )}
                                        </span>
                                    );
                                })()}
                            </td>
                            <td className="px-4 py-3">
                                <div className="flex flex-wrap gap-1">
                                    {node.capabilities.length === 0 ? (
                                        <span className="text-text-muted dark:text-text-muted-dark">
                                            -
                                        </span>
                                    ) : (
                                        node.capabilities.map((capability) => (
                                            <span
                                                key={capability}
                                                className="px-1.5 py-0.5 rounded text-xs bg-info/10 text-info"
                                            >
                                                {capability}
                                            </span>
                                        ))
                                    )}
                                </div>
                            </td>
                            <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                {formatLastSeen(node.lastHeartbeatAt)}
                            </td>
                            <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1">
                                    {favorites?.renderOpen?.(node)}
                                    <Button
                                        variant="ghost"
                                        onClick={() => onDetails(node)}
                                        disabled={isPending}
                                        data-testid={`fleet-node-details-${node.id}`}
                                        title={t('actions.details')}
                                    >
                                        <Info className="w-4 h-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        onClick={() => onRename(node)}
                                        disabled={isPending}
                                        data-testid={`fleet-node-rename-${node.id}`}
                                        title={t('actions.rename')}
                                    >
                                        <Pencil className="w-4 h-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        onClick={() => onToggleDisabled(node)}
                                        disabled={isPending}
                                        data-testid={`fleet-node-disable-${node.id}`}
                                        title={
                                            node.status === 'disabled'
                                                ? t('actions.enable')
                                                : t('actions.disable')
                                        }
                                    >
                                        {node.status === 'disabled' ? (
                                            <Play className="w-4 h-4" />
                                        ) : (
                                            <Pause className="w-4 h-4" />
                                        )}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        onClick={() => onRemove(node)}
                                        disabled={isPending}
                                        data-testid={`fleet-node-remove-${node.id}`}
                                        title={t('actions.remove')}
                                    >
                                        <Trash2 className="w-4 h-4 text-danger" />
                                    </Button>
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
