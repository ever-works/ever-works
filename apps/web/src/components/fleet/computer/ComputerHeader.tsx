'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ChevronDown, Monitor, Star, TerminalSquare, Users } from 'lucide-react';
import type { FleetNodeView } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import { Tooltip } from '@/components/ui/tooltip';
import {
    FLEET_TONE_DOT_CLASS,
    absoluteTime,
    computerStateKey,
    computerStateTone,
    relativeTime,
} from '../fleet-hub.shared';
import { osKeyOf } from '../fleet-os.shared';
import '../modules';
import {
    getComputerActions,
    type FleetComputerActionRegistration,
    type FleetFeatureFlags,
} from '../registry';
import { RegisteredComponent } from '../RegisteredComponent';

const ACTION =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium h-8 px-3 text-xs border border-border dark:border-border-dark text-text dark:text-text-dark disabled:opacity-50 disabled:cursor-not-allowed';

/** Seconds of uptime as "3 d" / "5 h" / "12 min", or null when unknown. */
export function formatUptime(seconds: unknown): string | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d`;
    if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)} h`;
    return `${Math.max(1, Math.floor(seconds / 60))} min`;
}

/**
 * Fleet hub (FL-01, FR-16, FR-21, spec §5.8) — one computer's header:
 * `← Fleet  ★ build-01  ● Online · Linux · checked 09:41 · up 3 d` and the
 * actions New session ▾, Desktop and ⋯. The state is always a word beside the
 * dot. New session and Desktop stay disabled, naming the epic that brings
 * them, until FL-04 and FL-07 register their actions; uptime shows once a
 * health snapshot (FL-03) carries it. Header actions other epics register
 * (`registerComputerAction` with `placement: 'header'`) take the place of the
 * placeholder they `replace`, or sit after it. `menu` is the ⋯ menu.
 */
export function ComputerHeader({
    node,
    flags = {},
    menu,
}: {
    node: FleetNodeView;
    flags?: FleetFeatureFlags;
    menu?: ReactNode;
}) {
    const t = useTranslations('fleet');
    const locale = useLocale();
    // The tooltip is the reader's time zone, so it waits for the browser; the
    // relative words re-render after hydration.
    const mounted = useMounted();
    const now = new Date();
    const state = computerStateKey(node);
    const checked = relativeTime(node.lastHeartbeatAt, now, locale);
    const os = osKeyOf(node.platform);
    const uptime = formatUptime(
        (node as FleetNodeView & { health?: { uptimeSec?: unknown } }).health?.uptimeSec,
    );
    const shared = node.viewerRole !== undefined && node.viewerRole !== 'owner';
    const stateWord =
        state === 'offline' && checked
            ? t('states.offlineSince', { time: checked })
            : t(`states.${state}`);
    const headerActions = getComputerActions('header', flags);
    const renderAction = (action: FleetComputerActionRegistration) => (
        <RegisteredComponent
            key={action.id}
            id={`action:${action.id}`}
            load={action.load}
            props={{ node, flags }}
            loading={null}
            failed={null}
        />
    );

    return (
        <header className="mb-4 space-y-3" data-testid="fleet-computer-header">
            <Link
                href={ROUTES.DASHBOARD_FLEET}
                className="inline-flex items-center gap-1 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                data-testid="fleet-computer-back"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {t('nav.label')}
            </Link>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <h1 className="flex items-center gap-2 text-xl font-semibold text-text dark:text-text-dark">
                        {node.isFavorite && (
                            <Star
                                className="w-5 h-5 shrink-0 fill-warning text-warning"
                                aria-label={t('overview.computers.favourite')}
                                data-testid="fleet-computer-favourite"
                            />
                        )}
                        <span className="truncate" data-testid="fleet-computer-name">
                            {node.name}
                        </span>
                        {shared && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                                <Users className="w-3 h-3" aria-hidden="true" />
                                {t('overview.computers.sharedWithYou')}
                            </span>
                        )}
                    </h1>
                    <p
                        className="flex flex-wrap items-center gap-x-2 text-sm text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-computer-facts"
                    >
                        <span className="inline-flex items-center gap-1.5 font-medium text-text dark:text-text-dark">
                            <span
                                className={cn(
                                    'w-2 h-2 rounded-full',
                                    FLEET_TONE_DOT_CLASS[computerStateTone(state)],
                                )}
                                aria-hidden="true"
                            />
                            <span data-testid="fleet-computer-state" suppressHydrationWarning>
                                {stateWord}
                            </span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                            {os === 'other'
                                ? t('os.other', { platform: node.platform ?? '' })
                                : t(`os.${os}`)}
                        </span>
                        {checked && state !== 'offline' && (
                            <>
                                <span aria-hidden="true">·</span>
                                <span
                                    title={
                                        mounted
                                            ? (absoluteTime(node.lastHeartbeatAt, locale) ??
                                              undefined)
                                            : undefined
                                    }
                                    suppressHydrationWarning
                                >
                                    {t('overview.computers.checked', { time: checked })}
                                </span>
                            </>
                        )}
                        {uptime && (
                            <>
                                <span aria-hidden="true">·</span>
                                <span>{t('computer.header.uptime', { duration: uptime })}</span>
                            </>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-2" data-testid="fleet-computer-actions">
                    {replacement(headerActions, 'new-session') ? (
                        renderAction(replacement(headerActions, 'new-session')!)
                    ) : (
                        <Tooltip
                            content={t('computer.header.newSessionArrives', { epic: 'FL-04' })}
                        >
                            <button
                                type="button"
                                className={ACTION}
                                disabled
                                data-testid="fleet-computer-new-session"
                            >
                                <TerminalSquare className="w-3.5 h-3.5" aria-hidden="true" />
                                {t('computer.header.newSession')}
                                <span className="sr-only">
                                    {` — ${t('computer.header.newSessionArrives', { epic: 'FL-04' })}`}
                                </span>
                                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        </Tooltip>
                    )}
                    {replacement(headerActions, 'desktop') ? (
                        renderAction(replacement(headerActions, 'desktop')!)
                    ) : (
                        <Tooltip content={t('computer.header.desktopArrives', { epic: 'FL-07' })}>
                            <button
                                type="button"
                                className={ACTION}
                                disabled
                                data-testid="fleet-computer-desktop"
                            >
                                <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
                                {t('computer.header.desktop')}
                                <span className="sr-only">
                                    {` — ${t('computer.header.desktopArrives', { epic: 'FL-07' })}`}
                                </span>
                            </button>
                        </Tooltip>
                    )}
                    {headerActions.filter((action) => !action.replaces).map(renderAction)}
                    {menu}
                </div>
            </div>
        </header>
    );
}

/** The registered header action that takes the place of one FL-01 placeholder, if any. */
function replacement(
    actions: readonly FleetComputerActionRegistration[],
    slot: NonNullable<FleetComputerActionRegistration['replaces']>,
): FleetComputerActionRegistration | undefined {
    return actions.find((action) => action.replaces === slot);
}
