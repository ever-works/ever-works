'use client';

import { useId, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
    hasFleetNodeHealthReading,
    isFleetNodeHealthStale,
    type ComputerStateResolution,
    type FleetNodeView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import { ComputerStateLine } from '../ComputerStateLine';
import type { ClearModelThrottle } from '../FixAction';
import { HEALTH_STALE_AFTER_MS } from '../HealthCells';
import { formatBinaryBytes, formatMiB, uptimeCopy } from '../computer-state.shared';
import { useNow } from '../use-now';

export type HealthMetricsStatus = 'ready' | 'loading' | 'error';

export interface HealthMetricsProps {
    node: FleetNodeView;
    status?: HealthMetricsStatus;
    /** Whether the deployment keeps history; unknown (undefined) shows no footprint line. */
    historyEnabled?: boolean;
    now?: number;
    staleAfterMs?: number;
    /**
     * The server's own judgement (the health read's `stale`, made with the
     * deployment's configured offline threshold). `true` dims the block
     * whatever the local clock says; absent, the block judges by
     * `staleAfterMs`.
     */
    stale?: boolean;
    /** The server's state for this computer (the health read's `state`); see `ComputerStateLine`. */
    resolution?: ComputerStateResolution | null;
    onRetry?: () => void;
    /** Where "Change limits" leads. */
    limitsHref?: string;
    onActionDone?: () => void;
    clearModelThrottle?: ClearModelThrottle;
}

function MetricCard({
    label,
    value,
    detail,
    missing,
}: {
    label: string;
    value: string;
    detail?: ReactNode;
    missing?: string;
}) {
    return (
        <div
            className="min-w-0 rounded-lg border border-border p-3 dark:border-border-dark"
            data-testid="fleet-health-card"
        >
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{label}</p>
            <p
                className="mt-1 text-lg font-semibold tabular-nums text-text dark:text-text-dark"
                title={missing}
            >
                {value}
            </p>
            {detail ? (
                <div className="mt-1 space-y-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {detail}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Computer health (FL-03, spec S2 / §5.2) — the Overview tab's metric block:
 * six cards (CPU, memory used / total, disk free and the node's own floor,
 * GPU or "No GPU", load with its core count, failed services), the
 * pending-reboot line, when it was checked, Refresh now, and one line on what
 * the history keeps (FR-29).
 *
 * Every value is the node's own; one it did not report is "—" with a hint,
 * never a zero. A snapshot older than the offline threshold — and every
 * snapshot of an offline computer — is dimmed and labelled stale (FR-5, FR-30,
 * U1). A node version that reports no health says so (ACC-FL03-02).
 *
 * Refresh now is disabled with its reason until the node link lands (FL-03's
 * reach phase, CONTRACTS R-31); the next automatic check is at most a minute
 * away.
 */
export function HealthMetrics({
    node,
    status = 'ready',
    historyEnabled,
    now: nowProp,
    staleAfterMs = HEALTH_STALE_AFTER_MS,
    stale: staleProp,
    resolution,
    onRetry,
    limitsHref,
    onActionDone,
    clearModelThrottle,
}: HealthMetricsProps) {
    const t = useTranslations('fleet.health');
    const locale = useLocale();
    const refreshReasonId = useId();
    const ticking = useNow();
    const now = nowProp ?? ticking;
    // A row holding only the platform's disk-low marker is not a reading.
    const health = hasFleetNodeHealthReading(node.health) ? (node.health ?? null) : null;
    const dash = t('notReported');
    const missing = t('notReportedHint');

    const header = (
        <ComputerStateLine
            node={node}
            now={now}
            resolution={resolution}
            limitsHref={limitsHref}
            onActionDone={onActionDone}
            clearModelThrottle={clearModelThrottle}
        />
    );

    if (status === 'loading') {
        return (
            <section
                aria-label={t('regionLabel', { name: node.name })}
                aria-busy="true"
                className="space-y-3"
            >
                {header}
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-health-loading"
                >
                    {t('loading')}
                </p>
            </section>
        );
    }

    if (status === 'error') {
        return (
            <section aria-label={t('regionLabel', { name: node.name })} className="space-y-3">
                {header}
                <p className="text-sm text-danger" role="alert" data-testid="fleet-health-error">
                    {t('error')}
                </p>
                {onRetry ? (
                    <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
                        {t('tryAgain')}
                    </Button>
                ) : null}
            </section>
        );
    }

    const offline = node.status === 'offline';
    const stale =
        offline || staleProp === true || isFleetNodeHealthStale(health, now, staleAfterMs);
    const percent = (value: number | undefined) =>
        typeof value === 'number' ? t('percentValue', { value: Math.round(value) }) : dash;
    const relative = health ? relativeTimeParts(health.at, now) : null;
    const ago = relative ? t(`relative.${relative.unit}`, { value: relative.value }) : dash;
    const checkedTime = health
        ? new Intl.DateTimeFormat(locale, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
          }).format(new Date(health.at))
        : null;

    const gpus = health?.gpu;
    const firstGpu = Array.isArray(gpus) && gpus.length > 0 ? gpus[0] : null;
    const uptime = uptimeCopy(health?.uptimeSec);
    const floor = formatBinaryBytes(node.minFreeDiskBytes ?? null);

    const refreshReason = offline
        ? t('refreshOffline', { name: node.name })
        : t('refreshUnavailable');

    return (
        <section
            aria-label={t('regionLabel', { name: node.name })}
            className="space-y-3"
            data-testid="fleet-health-metrics"
        >
            {header}

            {!health ? (
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-health-no-snapshot"
                >
                    {t('noSnapshot')}
                </p>
            ) : (
                <div
                    className={cn(
                        'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6',
                        stale && 'opacity-60',
                    )}
                    data-stale={stale ? 'true' : 'false'}
                >
                    <MetricCard
                        label={t('cpu')}
                        value={percent(health.cpuPercent)}
                        missing={health.cpuPercent === undefined ? missing : undefined}
                    />
                    <MetricCard
                        label={t('memory')}
                        value={percent(health.memPercent)}
                        missing={health.memPercent === undefined ? missing : undefined}
                        detail={
                            formatMiB(health.memUsedMiB) && formatMiB(health.memTotalMiB) ? (
                                <p>
                                    {t('memoryUsed', {
                                        used: formatMiB(health.memUsedMiB) ?? '',
                                        total: formatMiB(health.memTotalMiB) ?? '',
                                    })}
                                </p>
                            ) : null
                        }
                    />
                    <MetricCard
                        label={t('disk')}
                        value={percent(health.diskPercent)}
                        missing={health.diskPercent === undefined ? missing : undefined}
                        detail={
                            <>
                                {formatMiB(health.diskFreeMiB) ? (
                                    <p>
                                        {t('diskFree', {
                                            free: formatMiB(health.diskFreeMiB) ?? '',
                                        })}
                                    </p>
                                ) : null}
                                <p>{floor ? t('diskFloor', { floor }) : t('diskNoFloor')}</p>
                            </>
                        }
                    />
                    <MetricCard
                        label={t('gpu')}
                        value={
                            gpus === null
                                ? t('gpuNone')
                                : firstGpu
                                  ? (firstGpu.name ?? firstGpu.vendor)
                                  : dash
                        }
                        missing={gpus === undefined ? missing : undefined}
                        detail={
                            firstGpu ? (
                                <>
                                    {typeof firstGpu.utilPercent === 'number' ? (
                                        <p>
                                            {t('gpuUsage', {
                                                util: Math.round(firstGpu.utilPercent),
                                            })}
                                        </p>
                                    ) : null}
                                    {formatMiB(firstGpu.memUsedMiB) &&
                                    formatMiB(firstGpu.memTotalMiB) ? (
                                        <p>
                                            {t('gpuMemory', {
                                                used: formatMiB(firstGpu.memUsedMiB) ?? '',
                                                total: formatMiB(firstGpu.memTotalMiB) ?? '',
                                            })}
                                        </p>
                                    ) : null}
                                    {gpus && gpus.length > 1 ? (
                                        <p>{t('gpuMore', { count: gpus.length - 1 })}</p>
                                    ) : null}
                                </>
                            ) : null
                        }
                    />
                    <MetricCard
                        label={t('load')}
                        value={
                            typeof health.loadAvg1 === 'number' ? health.loadAvg1.toFixed(2) : dash
                        }
                        missing={health.loadAvg1 === undefined ? missing : undefined}
                        detail={
                            typeof health.cpuCores === 'number' ? (
                                <p>{t('loadCores', { count: health.cpuCores })}</p>
                            ) : null
                        }
                    />
                    <MetricCard
                        label={t('services')}
                        value={
                            typeof health.failedServices === 'number'
                                ? t('servicesFailed', { count: health.failedServices })
                                : dash
                        }
                        missing={health.failedServices === undefined ? missing : undefined}
                    />
                </div>
            )}

            {health ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                    <span data-testid="fleet-health-pending-reboot">
                        {t('pendingReboot', {
                            answer:
                                typeof health.pendingReboot === 'boolean'
                                    ? health.pendingReboot
                                        ? t('yes')
                                        : t('no')
                                    : dash,
                        })}
                    </span>
                    {uptime ? (
                        <span>
                            {t('uptime', { duration: t(`duration.${uptime.key}`, uptime.values) })}
                        </span>
                    ) : null}
                    <time dateTime={health.at} data-testid="fleet-health-checked">
                        {stale
                            ? t('stale', { relative: ago })
                            : t('checked', { time: checkedTime ?? dash, relative: ago })}
                    </time>
                </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled
                    aria-describedby={refreshReasonId}
                >
                    {t('refreshNow')}
                </Button>
                <span
                    id={refreshReasonId}
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {refreshReason}
                </span>
            </div>

            {historyEnabled === undefined ? null : (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-health-footprint"
                >
                    {historyEnabled ? t('footprint') : t('historyOff')}
                </p>
            )}
        </section>
    );
}
