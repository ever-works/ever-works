'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Laptop, Server, Star, Users } from 'lucide-react';
import type { FleetNodeView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import {
    FLEET_TONE_DOT_CLASS,
    absoluteTime,
    computerStateKey,
    computerStateTone,
    groupComputersByHost,
    isComputerOnline,
    readHealthCells,
    relativeTime,
    type FleetComputerGroup,
} from '../fleet-hub.shared';
import { osKeyOf } from '../fleet-os.shared';

interface ComputerCardsProps {
    nodes: FleetNodeView[];
}

/**
 * Fleet hub (FL-01, FR-7 – FR-9, spec §5.2) — one card per computer the viewer
 * may see: favourites first, then online computers by most recent check, then
 * the rest; a VM or Container indented under its host with a connector and
 * "VM on build-01". Each card says its state in words beside the dot (the dot
 * is never the only signal), the OS, the health cells — "—" until a health
 * snapshot exists, marked when older than the last check, never invented —
 * and when it last checked in, relative with the absolute time as a tooltip.
 * A computer someone else owns says "Shared with you".
 */
export function ComputerCards({ nodes }: ComputerCardsProps) {
    const t = useTranslations('fleet.overview.computers');
    const persisted = nodes.filter((node) => node.persisted);
    const groups = groupComputersByHost(persisted);
    const online = persisted.filter(isComputerOnline).length;

    return (
        <section
            aria-labelledby="fleet-computers-heading"
            className="space-y-2"
            data-testid="fleet-computer-cards"
        >
            <div className="flex items-center justify-between gap-2">
                <h2
                    id="fleet-computers-heading"
                    className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('heading')}{' '}
                    <span className="normal-case font-normal" data-testid="fleet-computer-count">
                        ({t('count', { total: persisted.length, online })})
                    </span>
                </h2>
                <span
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-spends-nothing"
                >
                    {t('spendsNothing')}
                </span>
            </div>
            <ul aria-label={t('listLabel')} className="space-y-2">
                {groups.map((group) => (
                    <ComputerCardGroup key={group.node.id} group={group} />
                ))}
            </ul>
        </section>
    );
}

function ComputerCardGroup({ group }: { group: FleetComputerGroup }) {
    return (
        <li>
            <ComputerCard node={group.node} hostName={group.hostName ?? undefined} />
            {group.children.length > 0 && (
                <ul className="mt-2 ml-6 space-y-2 border-l border-border dark:border-border-dark pl-3">
                    {group.children.map((child) => (
                        <li key={child.id} className="relative">
                            <span
                                aria-hidden="true"
                                className="absolute -left-3 top-1/2 w-3 border-t border-border dark:border-border-dark"
                            />
                            <ComputerCard node={child} hostName={group.node.name} />
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

function ComputerCard({ node, hostName }: { node: FleetNodeView; hostName?: string }) {
    const t = useTranslations('fleet');
    const locale = useLocale();
    // The absolute tooltips are the reader's time zone, so they wait for the
    // browser; the relative words re-render after hydration.
    const mounted = useMounted();
    const now = new Date();
    const state = computerStateKey(node);
    const tone = computerStateTone(state);
    const health = readHealthCells(node as FleetNodeView & { health?: unknown });
    const checked = relativeTime(node.lastHeartbeatAt, now, locale);
    const checkedAbsolute = mounted
        ? (absoluteTime(node.lastHeartbeatAt, locale) ?? undefined)
        : undefined;
    const os = osKeyOf(node.platform);
    const shared = node.viewerRole !== undefined && node.viewerRole !== 'owner';
    const stateWord =
        state === 'offline' && checked
            ? t('states.offlineSince', { time: checked })
            : t(`states.${state}`);

    const cell = (label: string, value: number | null | undefined) => (
        <span className="whitespace-nowrap">
            <span className="text-text-muted dark:text-text-muted-dark">{label}</span>{' '}
            <span
                className={cn(
                    'tabular-nums',
                    health?.stale && 'text-text-muted dark:text-text-muted-dark',
                )}
            >
                {value === null || value === undefined
                    ? t('overview.computers.noValue')
                    : `${value}%`}
            </span>
        </span>
    );

    return (
        <Link
            href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id)}
            className="block rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark px-4 py-3 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-colors"
            data-testid={`fleet-computer-card-${node.id}`}
            data-state={state}
        >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="flex items-center gap-2 min-w-0 font-medium text-text dark:text-text-dark">
                    {node.isFavorite ? (
                        <Star
                            className="w-4 h-4 shrink-0 fill-warning text-warning"
                            aria-label={t('overview.computers.favourite')}
                            data-testid="fleet-computer-card-favourite"
                        />
                    ) : (
                        <span className="w-4 shrink-0" aria-hidden="true" />
                    )}
                    {node.kind === 'desktop-node' ? (
                        <Laptop
                            className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                            aria-hidden="true"
                        />
                    ) : (
                        <Server
                            className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                            aria-hidden="true"
                        />
                    )}
                    <span className="truncate">{node.name}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-medium text-text dark:text-text-dark">
                    <span
                        className={cn('w-1.5 h-1.5 rounded-full', FLEET_TONE_DOT_CLASS[tone])}
                        aria-hidden="true"
                    />
                    <span data-testid="fleet-computer-card-state" suppressHydrationWarning>
                        {stateWord}
                    </span>
                </span>
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {os === 'other'
                        ? t('os.other', { platform: node.platform ?? '' })
                        : t(`os.${os}`)}
                </span>
                {shared && (
                    <span
                        className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info"
                        data-testid="fleet-computer-card-shared"
                    >
                        <Users className="w-3 h-3" aria-hidden="true" />
                        {t('overview.computers.sharedWithYou')}
                    </span>
                )}
                <span
                    className="flex items-center gap-3 text-xs"
                    data-testid="fleet-computer-card-health"
                    title={
                        health
                            ? health.stale
                                ? t('overview.computers.staleHealth', {
                                      time:
                                          (mounted ? absoluteTime(health.at, locale) : null) ??
                                          t('overview.computers.noValue'),
                                  })
                                : undefined
                            : t('overview.computers.healthUnavailable')
                    }
                >
                    {cell(t('overview.computers.cpu'), health?.cpuPercent)}
                    {cell(t('overview.computers.memory'), health?.memPercent)}
                    {cell(t('overview.computers.disk'), health?.diskPercent)}
                </span>
                <span
                    className="ml-auto text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap"
                    title={checkedAbsolute}
                    suppressHydrationWarning
                >
                    {checked
                        ? state === 'offline'
                            ? t('overview.computers.lastSeen', { time: checked })
                            : t('overview.computers.checked', { time: checked })
                        : t('overview.computers.neverChecked')}
                </span>
            </div>
            {hostName && (
                <p
                    className="mt-1 ml-6 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-computer-card-host"
                >
                    {node.virtualKind === 'container'
                        ? t('overview.computers.nestedContainer', { host: hostName })
                        : t('overview.computers.nestedVm', { host: hostName })}
                </p>
            )}
        </Link>
    );
}
