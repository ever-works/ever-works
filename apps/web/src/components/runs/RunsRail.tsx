'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { RunLedgerGranularity, RunLedgerStatus, RunWindowStats } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { formatCents, formatRunDuration, formatTokens } from './runs.shared';

/**
 * Runs ledger (AW-09) — the window's headline numbers, computed server-side
 * for exactly the window and filters the list shows. The heading states the
 * scope in words so a number is never mistaken for an all-time total, and
 * the outcome figures are filter shortcuts rather than links away.
 *
 * Loads and fails independently of the list: a failing rail shows its own
 * retry and leaves the list alone.
 */
export function RunsRail({
    stats,
    granularity,
    error,
    loading,
    onRetry,
    onFilterStatus,
}: {
    stats: RunWindowStats | null;
    granularity: RunLedgerGranularity;
    error: boolean;
    loading: boolean;
    onRetry: () => void;
    onFilterStatus: (status: RunLedgerStatus | null) => void;
}) {
    const t = useTranslations('dashboard.runsPage');
    const locale = useLocale();
    const heading =
        granularity === 'week'
            ? t('rail.headingWeek')
            : granularity === 'month'
              ? t('rail.headingMonth')
              : t('rail.headingDay');

    return (
        <aside
            className={cn(
                'rounded-lg border border-border/60 dark:border-border-dark/60 p-4 space-y-3',
                loading && 'opacity-60',
            )}
            aria-busy={loading}
            data-testid="runs-rail"
        >
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {heading}
            </h2>
            {error ? (
                <div className="space-y-2" data-testid="runs-rail-error">
                    <p className="text-xs text-text-secondary">{t('errors.loadRail')}</p>
                    <Button variant="secondary" size="sm" onClick={onRetry}>
                        {t('errors.retry')}
                    </Button>
                </div>
            ) : stats ? (
                <dl className="space-y-2 text-xs">
                    <Metric
                        label={t('rail.runs')}
                        value={String(stats.total)}
                        onClick={() => onFilterStatus(null)}
                        hint={t('rail.filterHint')}
                        testId="runs-rail-runs"
                    />
                    <Metric
                        label={t('rail.succeeded')}
                        value={
                            stats.successRate == null
                                ? '—'
                                : `${stats.successRate.toLocaleString(locale, {
                                      minimumFractionDigits: 1,
                                      maximumFractionDigits: 1,
                                  })} %`
                        }
                        title={stats.successRate == null ? t('rail.notEnoughData') : undefined}
                        onClick={() => onFilterStatus('completed')}
                        hint={t('rail.filterHint')}
                        testId="runs-rail-succeeded"
                    />
                    <Metric
                        label={t('rail.errors')}
                        value={String(stats.errorCount)}
                        onClick={() => onFilterStatus('failed')}
                        hint={t('rail.filterHint')}
                        testId="runs-rail-errors"
                    />
                    <Metric
                        label={t('rail.agentTime')}
                        value={formatRunDuration(stats.totalDurationMs) ?? '—'}
                        testId="runs-rail-agent-time"
                    />
                    <Metric
                        label={t('rail.spend')}
                        value={formatCents(stats.costCents, locale) ?? '—'}
                        title={stats.costCents == null ? t('rail.notMeasured') : undefined}
                        testId="runs-rail-spend"
                    />
                    {stats.costCents != null && stats.unsettledRuns > 0 && (
                        <p className="text-[10px] text-text-muted">
                            {t('rail.unsettled', { count: stats.unsettledRuns })}
                        </p>
                    )}
                    <Metric
                        label={t('rail.tokens')}
                        value={formatTokens(stats.tokens.total, locale) ?? '—'}
                        title={stats.tokens.total == null ? t('rail.notMeasured') : undefined}
                        testId="runs-rail-tokens"
                    />
                </dl>
            ) : (
                <p className="text-xs text-text-muted" role="status">
                    {t(`loading.${granularity}`)}
                </p>
            )}
        </aside>
    );
}

function Metric({
    label,
    value,
    title,
    hint,
    onClick,
    testId,
}: {
    label: string;
    value: string;
    title?: string;
    hint?: string;
    onClick?: () => void;
    testId: string;
}) {
    return (
        <div className="flex items-baseline justify-between gap-3" data-testid={testId}>
            <dt className="text-text-secondary dark:text-text-secondary-dark">{label}</dt>
            <dd className="tabular-nums font-medium text-text dark:text-text-dark" title={title}>
                {onClick ? (
                    <button
                        type="button"
                        onClick={onClick}
                        className="hover:underline"
                        aria-label={`${label}: ${value}. ${hint ?? ''}`.trim()}
                    >
                        {value}
                    </button>
                ) : (
                    value
                )}
            </dd>
        </div>
    );
}
