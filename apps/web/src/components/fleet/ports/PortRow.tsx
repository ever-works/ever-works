'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, Hourglass, MoreHorizontal, X } from 'lucide-react';
import type {
    FleetListeningPort,
    FleetPortOpenTarget,
    FleetPortOpenTargetState,
    FleetPortsListResponse,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { portAddress, programLine, reasonKey, tunnelFor } from './ports.shared';
import { TunnelRowState } from './TunnelRowState';

/**
 * Servers and ports (FL-10, spec §5.1) — one row of the Ports tab:
 *
 * `● :3000 "Acme — Checkout" 200 node (pid 4812) · ~/code/api [Open ▾] […]`
 *
 * `Open ▾` holds **Open on the desktop** and **Open in the preview browser**,
 * each disabled with the sentence that says why (spec U2, U4, U8, U10); the
 * row's own button opens with the default target. `…` holds Copy address,
 * Show in Processes and Show in Docker (when a container is behind it).
 * A waiting row (`⏳ :4000 waiting for a server…`) has only its ✕.
 */
export function PortRow({
    port,
    list,
    nodeName,
    nodeId,
    opening,
    selected,
    onOpen,
    onRemoveWatch,
    onTunnelChange,
    onWatch,
}: {
    port: FleetListeningPort;
    list: FleetPortsListResponse;
    nodeName: string;
    nodeId: string;
    opening: boolean;
    selected?: boolean;
    onOpen: (port: FleetListeningPort, target: FleetPortOpenTarget) => void;
    onRemoveWatch?: (port: number) => void;
    /** Phase 2: a preview tunnel opened or closed — re-read the list. */
    onTunnelChange?: () => void;
    /** Phase 3: watch this server — say so when it stops. */
    onWatch?: (port: number) => void;
}) {
    const t = useTranslations('fleet.ports');

    if (port.kind === 'waiting') {
        return (
            <li
                className="flex items-center gap-3 px-3 py-2 text-sm text-text-muted dark:text-text-muted-dark"
                data-testid={`fleet-port-waiting-${port.port}`}
            >
                <Hourglass className="h-4 w-4 shrink-0" aria-hidden />
                <span className="font-mono">:{port.port}</span>
                <span>{t('waiting')}</span>
                {onRemoveWatch && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto"
                        aria-label={t('removeWatch', { port: port.port })}
                        onClick={() => onRemoveWatch(port.port)}
                    >
                        <X className="h-4 w-4" aria-hidden />
                    </Button>
                )}
            </li>
        );
    }

    const program = programLine(port);
    const defaultTarget = list.defaultTarget;
    const reasonText = (state: FleetPortOpenTargetState) =>
        t(`reasons.${reasonKey(state.reason)}` as Parameters<typeof t>[0], { name: nodeName, command: state.command ?? '' });
    const isWeb = port.kind === 'web' && !port.stopped;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(portAddress(port));
            toast.success(t('copied'));
        } catch {
            toast.error(portAddress(port));
        }
    };

    return (
        <li
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${
                selected ? 'bg-info/10' : ''
            } ${port.stopped ? 'opacity-60' : ''}`}
            data-testid={`fleet-port-${port.port}`}
        >
            <span
                className={`h-2 w-2 shrink-0 rounded-full ${port.stopped ? 'bg-text-muted' : isWeb ? 'bg-success' : 'bg-text-muted'}`}
                aria-hidden
            />
            <span className="font-mono font-medium">:{port.port}</span>
            {port.kind === 'web' && (
                <span className="min-w-0 max-w-[24rem] truncate">
                    {port.web?.title ? `"${port.web.title}"` : t('noTitle')}
                </span>
            )}
            {port.web?.scheme === 'https' && (
                <span className="rounded bg-surface-secondary px-1.5 text-xs dark:bg-surface-secondary-dark">{t('https')}</span>
            )}
            {port.web && <span className="font-mono text-xs">{port.web.status}</span>}
            {port.kind !== 'web' && port.wellKnown && <span>{port.wellKnown}</span>}
            {port.noHttpAnswer && (
                <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('noHttpAnswer')}</span>
            )}
            {program && (
                <span className="min-w-0 truncate text-text-muted dark:text-text-muted-dark">
                    {port.container ? (
                        <Link
                            href={`${ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'docker')}&container=${encodeURIComponent(port.container.id)}`}
                            className="hover:underline"
                        >
                            {program}
                        </Link>
                    ) : (
                        program
                    )}
                </span>
            )}
            {port.localOnly && (
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('localOnly', { name: nodeName })}
                </span>
            )}
            {port.stopped && <span className="text-xs font-medium">{t('stopped')}</span>}

            <span className="ml-auto flex items-center gap-1">
                {isWeb && list.tunnel?.available && (
                    <TunnelRowState
                        nodeId={nodeId}
                        port={port}
                        tunnel={tunnelFor(list, port.port)}
                        onChange={() => onTunnelChange?.()}
                    />
                )}
                {isWeb && list.canOpen && (
                    <>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={opening || defaultTarget === null}
                            onClick={() => defaultTarget && onOpen(port, defaultTarget)}
                            title={
                                defaultTarget === null
                                    ? reasonText(list.targets['preview-profile'])
                                    : undefined
                            }
                            data-testid={`fleet-port-open-${port.port}`}
                        >
                            {t('open')}
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger aria-label={t('openMenu', { port: port.port })}>
                                <ChevronDown className="h-4 w-4" aria-hidden />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    disabled={!list.targets.desktop.available || opening}
                                    onClick={() => onOpen(port, 'desktop')}
                                >
                                    <span className="flex flex-col">
                                        <span>{t('openOnDesktop')}</span>
                                        {!list.targets.desktop.available && (
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {reasonText(list.targets.desktop)}
                                            </span>
                                        )}
                                    </span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    disabled={!list.targets['preview-profile'].available || opening}
                                    onClick={() => onOpen(port, 'preview-profile')}
                                >
                                    <span className="flex flex-col">
                                        <span>{t('openInPreview')}</span>
                                        {!list.targets['preview-profile'].available && (
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {reasonText(list.targets['preview-profile'])}
                                            </span>
                                        )}
                                    </span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger aria-label={t('rowMenu', { port: port.port })}>
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void copy()}>{t('copyAddress')}</DropdownMenuItem>
                        {onWatch && !port.stopped && (
                            <DropdownMenuItem onClick={() => onWatch(port.port)}>{t('watch')}</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link href={ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'processes')}>
                                {t('showInProcesses')}
                            </Link>
                        </DropdownMenuItem>
                        {port.container && (
                            <DropdownMenuItem asChild>
                                <Link href={ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'docker')}>
                                    {t('showInDocker')}
                                </Link>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </span>
        </li>
    );
}
