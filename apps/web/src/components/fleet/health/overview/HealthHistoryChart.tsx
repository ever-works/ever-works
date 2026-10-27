'use client';

import { useId, useMemo, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import {
    FLEET_NODE_HEALTH_RANGES,
    summarizeFleetHealthHistory,
    type FleetNodeHealthHistory,
    type FleetNodeHealthHistoryPoint,
    type FleetNodeHealthRange,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

export type HealthHistoryMetric = 'cpu' | 'mem' | 'disk';

export const HEALTH_HISTORY_METRICS: readonly HealthHistoryMetric[] = ['cpu', 'mem', 'disk'];

/** One colour per line, readable on both themes; the legend names each line in words too. */
const METRIC_COLOUR: Record<HealthHistoryMetric, string> = {
    cpu: '#3b82f6',
    mem: '#a855f7',
    disk: '#f59e0b',
};

export type HealthHistoryStatus = 'loading' | 'ready' | 'error';

export interface HealthHistoryChartProps {
    nodeName: string;
    range: FleetNodeHealthRange;
    onRangeChange: (range: FleetNodeHealthRange) => void;
    visible: Readonly<Record<HealthHistoryMetric, boolean>>;
    onToggle: (metric: HealthHistoryMetric) => void;
    status: HealthHistoryStatus;
    history: FleetNodeHealthHistory | null;
    onRetry?: () => void;
}

function formatTick(at: string, range: FleetNodeHealthRange, locale: string): string {
    const date = new Date(at);
    if (range === '1h' || range === '24h') {
        return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
    }
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

function formatFull(at: string, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(at));
}

/**
 * Computer health, second phase (FL-03, spec S6, §5.7, FR-21, FR-22) — the
 * history chart on a computer's Overview tab: range buttons `1 h · 24 h · 7 d ·
 * 90 d`, one toggle per line (CPU, memory, disk), the sample's time and values
 * on hover, and — for assistive technology and anyone who prefers words — a
 * text summary per line ("CPU averaged 31% over the last hour, peak 78% at
 * 09:12", spec §5.8).
 *
 * An offline stretch is a BREAK in the line, never a dive to zero: the history
 * read carries an all-null point there and the lines do not connect across it.
 * With history switched off on the deployment it says so; with no samples yet
 * it says when the first one lands. Presentational: `HealthHistoryBlock` reads.
 */
export function HealthHistoryChart({
    nodeName,
    range,
    onRangeChange,
    visible,
    onToggle,
    status,
    history,
    onRetry,
}: HealthHistoryChartProps) {
    const t = useTranslations('fleet.history');
    const locale = useLocale();
    const headingId = useId();
    const summaryId = useId();

    const points: FleetNodeHealthHistoryPoint[] = useMemo(
        () => (history && !history.disabled ? history.points : []),
        [history],
    );
    const hasValues = points.some(
        (point) => point.cpu !== null || point.mem !== null || point.disk !== null,
    );
    const rangeWord = t(`rangeWords.${range}`);

    const summaries = HEALTH_HISTORY_METRICS.map((metric) => {
        const label = t(`metrics.${metric}`);
        const { mean, peak, peakAt } = summarizeFleetHealthHistory(points, metric);
        if (mean === null) return t('summaryNone', { metric: label, range: rangeWord });
        if (peak === null || peakAt === null) {
            return t('summaryNoPeak', { metric: label, mean: Math.round(mean), range: rangeWord });
        }
        return t('summary', {
            metric: label,
            mean: Math.round(mean),
            peak: Math.round(peak),
            time: formatFull(peakAt, locale),
            range: rangeWord,
        });
    });

    let body: ReactNode;
    if (history?.disabled) {
        body = (
            <p
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-history-off"
            >
                {t('off')}
            </p>
        );
    } else if (status === 'loading' && !history) {
        body = (
            <p
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-history-loading"
            >
                {t('loading')}
            </p>
        );
    } else if (status === 'error') {
        body = (
            <div className="space-y-2">
                <p className="text-sm text-danger" role="alert" data-testid="fleet-history-error">
                    {t('error')}
                </p>
                {onRetry ? (
                    <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
                        {t('tryAgain')}
                    </Button>
                ) : null}
            </div>
        );
    } else if (!hasValues) {
        body = (
            <p
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-history-empty"
            >
                {t('empty')}
            </p>
        );
    } else {
        body = (
            <>
                <div className="h-48 w-full" aria-hidden="true" data-testid="fleet-history-plot">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                            data={points}
                            margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                            <XAxis
                                dataKey="at"
                                tick={{ fontSize: 10 }}
                                interval="preserveStartEnd"
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(at: string) => formatTick(at, range, locale)}
                            />
                            <YAxis
                                domain={[0, 100]}
                                tick={{ fontSize: 10 }}
                                width={36}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(value: number) => t('valuePercent', { value })}
                            />
                            <Tooltip
                                labelFormatter={(at) =>
                                    typeof at === 'string' ? formatFull(at, locale) : ''
                                }
                                formatter={(value: number, name: string) => [
                                    t('valuePercent', { value: Math.round(value) }),
                                    t(`metrics.${name as HealthHistoryMetric}`),
                                ]}
                                contentStyle={{
                                    background: 'rgba(15, 23, 42, 0.9)',
                                    border: '1px solid rgba(148, 163, 184, 0.2)',
                                    borderRadius: 6,
                                    fontSize: 12,
                                }}
                                labelStyle={{ color: '#cbd5e1' }}
                                itemStyle={{ color: '#f1f5f9' }}
                            />
                            {HEALTH_HISTORY_METRICS.filter((metric) => visible[metric]).map(
                                (metric) => (
                                    <Line
                                        key={metric}
                                        type="monotone"
                                        dataKey={metric}
                                        name={metric}
                                        stroke={METRIC_COLOUR[metric]}
                                        strokeWidth={1.5}
                                        dot={false}
                                        isAnimationActive={false}
                                        // An offline stretch is a break, never a line through it.
                                        connectNulls={false}
                                    />
                                ),
                            )}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('gapNote')}</p>
            </>
        );
    }

    return (
        <section
            aria-labelledby={headingId}
            aria-describedby={hasValues ? summaryId : undefined}
            aria-busy={status === 'loading' ? 'true' : undefined}
            className="space-y-3"
            data-testid="fleet-health-history"
            data-range={range}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={headingId} className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('heading')}
                    <span className="sr-only"> — {t('regionLabel', { name: nodeName })}</span>
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                    <div role="group" aria-label={t('rangeLabel')} className="flex gap-1">
                        {FLEET_NODE_HEALTH_RANGES.map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={option === range}
                                onClick={() => onRangeChange(option)}
                                disabled={history?.disabled === true}
                                className={cn(
                                    'rounded px-2 py-0.5 text-xs font-medium',
                                    option === range
                                        ? 'bg-primary/10 text-primary'
                                        : 'text-text-muted hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark',
                                )}
                                data-testid={`fleet-history-range-${option}`}
                            >
                                {t(`ranges.${option}`)}
                            </button>
                        ))}
                    </div>
                    <div role="group" aria-label={t('metricsLabel')} className="flex gap-2">
                        {HEALTH_HISTORY_METRICS.map((metric) => (
                            <label
                                key={metric}
                                className="flex items-center gap-1 text-xs text-text dark:text-text-dark"
                            >
                                <input
                                    type="checkbox"
                                    checked={visible[metric]}
                                    onChange={() => onToggle(metric)}
                                    disabled={history?.disabled === true}
                                    data-testid={`fleet-history-toggle-${metric}`}
                                />
                                <span
                                    className="inline-block h-0.5 w-3"
                                    style={{ backgroundColor: METRIC_COLOUR[metric] }}
                                    aria-hidden="true"
                                />
                                {t(`metrics.${metric}`)}
                            </label>
                        ))}
                    </div>
                </div>
            </div>
            {body}
            {hasValues ? (
                <ul
                    id={summaryId}
                    className="space-y-0.5 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-history-summary"
                >
                    {summaries.map((summary, index) => (
                        <li key={HEALTH_HISTORY_METRICS[index]}>{summary}</li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
