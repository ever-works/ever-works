'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Cpu, Laptop, RefreshCw, Server } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/lib/constants';
import { Link } from '@/i18n/navigation';
import { useRunnerStatusPolling } from '@/lib/hooks/use-runner-status-polling';
import type { FleetRunnerStatusView } from '@/lib/api/fleet';
import {
    formatBytes,
    relativeTimeParts,
    runnerDotClass,
    runnerRowState,
    summarizeRunnerStatus,
} from './runner-status.shared';

/**
 * Literal message keys for the relative-time units.
 *
 * A lookup table rather than a template literal because these keys take
 * an INTERPOLATED value: `next-intl` types `t()` so that a key it cannot
 * narrow also cannot accept parameters, and the usual `as never` escape
 * hatch (fine for the parameterless keys elsewhere in this file) makes
 * the values argument unassignable. Naming the four keys explicitly
 * keeps them type-checked and greppable.
 */
const RELATIVE_KEYS = {
    second: 'relative.second',
    minute: 'relative.minute',
    hour: 'relative.hour',
    day: 'relative.day',
} as const;

interface RunnerStatusPillProps {
    /** Collapsed sidebar shows the dot + count only. */
    isCollapsed?: boolean;
    /** Server-rendered first payload, when the caller has one. */
    initialStatus?: FleetRunnerStatusView | null;
    onInteraction?: () => void;
}

/**
 * Runner status pill — the always-visible "Runner · Running" indicator
 * in the sidebar footer.
 *
 * ## Why it renders nothing without runners
 *
 * The pill is ADDITIVE: an account with no enrolled machine sees exactly
 * the sidebar it saw before. Fleet is an opt-in capability, and a
 * permanent "0 runners" chip would be an advertisement occupying the
 * footer of every page for every user who will never enroll one. The
 * moment a first node is enrolled, the pill appears on its own.
 *
 * ## What the popover answers
 *
 * The collapsed pill answers "is my work going to run?" (N of M online).
 * The popover answers "why not, and which machine?" — per node: status,
 * how long since it last checked in, the daemon version, the AGENT-CLI
 * version, and free disk. Those last three are the three ways a runner
 * that looks healthy silently is not: an old daemon, an old (or absent)
 * CLI, or a full volume.
 *
 * The refresh cadence comes from the payload, so the caption cannot
 * claim 30s while the poller does something else.
 */
export function RunnerStatusPill({
    isCollapsed = false,
    initialStatus = null,
    onInteraction,
}: RunnerStatusPillProps) {
    const t = useTranslations('dashboard.runner');
    const { status, error, refresh } = useRunnerStatusPolling(initialStatus);
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Dismiss on outside click / Escape. A footer popover that traps the
    // pointer is worse than no popover.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    // Nothing to show until the first payload proves a runner exists.
    // `status === null` covers the pre-first-response window too, so the
    // footer never flickers a chip in and back out on page load.
    if (!status || status.total <= 0) return null;

    const summary = summarizeRunnerStatus(status);
    const summaryDotClass =
        summary === 'online'
            ? 'bg-success'
            : summary === 'busy'
              ? 'bg-info'
              : 'bg-text-muted dark:bg-text-muted-dark';

    return (
        <div className="relative" ref={containerRef} data-testid="runner-status">
            <button
                type="button"
                onClick={() => {
                    onInteraction?.();
                    setOpen((prev) => !prev);
                }}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label={t('ariaLabel', { online: status.online, total: status.total })}
                data-testid="runner-status-pill"
                className={cn(
                    'w-full flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors cursor-pointer',
                    'hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-border',
                    isCollapsed && 'justify-center',
                )}
            >
                <span className="relative flex items-center justify-center shrink-0">
                    <Cpu
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                        strokeWidth={1.5}
                    />
                    <span
                        className={cn(
                            'absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full',
                            summaryDotClass,
                        )}
                    />
                </span>
                {!isCollapsed && (
                    <span className="flex-1 min-w-0 text-left">
                        <span className="block text-xs font-medium text-text dark:text-text-dark truncate">
                            {t('label')}
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {' · '}
                                {t(`summary.${summary}` as never)}
                            </span>
                        </span>
                        <span
                            className="block text-[11px] text-text-muted dark:text-text-muted-dark truncate"
                            data-testid="runner-status-count"
                        >
                            {t('count', { online: status.online, total: status.total })}
                        </span>
                    </span>
                )}
            </button>

            {open && (
                <div
                    role="dialog"
                    aria-label={t('popoverTitle')}
                    data-testid="runner-status-popover"
                    className={cn(
                        'absolute bottom-full mb-2 z-50 w-72 max-h-96 overflow-y-auto',
                        'rounded-lg border border-border dark:border-border-dark',
                        'bg-surface dark:bg-surface-dark shadow-lg p-3 space-y-3',
                        isCollapsed ? 'left-0' : 'left-0 right-0',
                    )}
                >
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-text dark:text-text-dark">
                            {t('popoverTitle')}
                        </p>
                        <button
                            type="button"
                            onClick={refresh}
                            title={t('refreshNow')}
                            aria-label={t('refreshNow')}
                            data-testid="runner-status-refresh"
                            className="p-1 rounded hover:bg-surface-tertiary/50 dark:hover:bg-card-primary-dark cursor-pointer"
                        >
                            <RefreshCw
                                className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark"
                                strokeWidth={1.5}
                            />
                        </button>
                    </div>

                    {error && (
                        <p
                            className="text-[11px] text-warning"
                            data-testid="runner-status-error"
                            role="status"
                        >
                            {t('staleWarning')}
                        </p>
                    )}
                    {status.loadUnavailable && (
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {t('loadUnavailable')}
                        </p>
                    )}

                    <ul className="space-y-2.5">
                        {status.nodes.map((node) => {
                            const state = runnerRowState(node);
                            const seen = relativeTimeParts(node.lastHeartbeatAt);
                            const disk = formatBytes(node.diskFreeBytes);
                            return (
                                <li
                                    key={node.id}
                                    className="space-y-1"
                                    data-testid={`runner-status-node-${node.id}`}
                                >
                                    <div className="flex items-center gap-2">
                                        {node.kind === 'desktop-node' ? (
                                            <Laptop className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark shrink-0" />
                                        ) : (
                                            <Server className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark shrink-0" />
                                        )}
                                        <span className="flex-1 min-w-0 text-xs font-medium text-text dark:text-text-dark truncate">
                                            {node.name}
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-[11px] text-text-muted dark:text-text-muted-dark shrink-0">
                                            <span
                                                className={cn(
                                                    'w-1.5 h-1.5 rounded-full',
                                                    runnerDotClass(state),
                                                )}
                                            />
                                            {t(`nodeState.${state}` as never)}
                                        </span>
                                    </div>
                                    <dl className="pl-5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] text-text-muted dark:text-text-muted-dark">
                                        <dt className="truncate">{t('fields.lastSeen')}</dt>
                                        <dd className="text-right truncate">
                                            {seen
                                                ? t(RELATIVE_KEYS[seen.unit], { value: seen.value })
                                                : '-'}
                                        </dd>
                                        <dt className="truncate">{t('fields.daemonVersion')}</dt>
                                        <dd className="text-right truncate">
                                            {node.daemonVersion ?? '-'}
                                        </dd>
                                        <dt className="truncate">{t('fields.cliVersion')}</dt>
                                        <dd className="text-right truncate">
                                            {node.cliVersion ?? t('fields.notInstalled')}
                                        </dd>
                                        <dt className="truncate">{t('fields.diskFree')}</dt>
                                        <dd className="text-right truncate">{disk ?? '-'}</dd>
                                    </dl>
                                </li>
                            );
                        })}
                    </ul>

                    <div className="pt-1 border-t border-border dark:border-border-dark space-y-1">
                        <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {t('refreshCaption', { seconds: status.refreshIntervalSec })}
                        </p>
                        <Link
                            href={ROUTES.DASHBOARD_SETTINGS_FLEET}
                            onClick={() => {
                                onInteraction?.();
                                setOpen(false);
                            }}
                            className="text-[11px] text-info hover:underline"
                            data-testid="runner-status-manage"
                        >
                            {t('manage')}
                        </Link>
                    </div>
                </div>
            )}
        </div>
    );
}
