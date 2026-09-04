'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, Download } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { UsageByDayChart } from '@/components/settings/usage/UsageByDayChart';
import { UsageBreakdownChart } from '@/components/settings/usage/UsageBreakdownChart';
import {
    type CreditsPricing,
    buildUsageExportQuery,
    buildUsageSummaryQuery,
    currentUsageMonth,
    formatCents,
    formatCreditsAsDollars,
    formatUsageMonthLabel,
    isUsageMonthPeriod,
    parseUsagePeriod,
    recentUsageMonths,
    USAGE_ROLLING_PERIODS,
    type UsagePeriod,
    type UsageSummaryGrouped,
    type UsageSummaryTotals,
} from '@/lib/api/credits.shared';
import type { AccountWideUsage } from '@/lib/api/usage';

/** Everything the page renders for ONE period. */
interface UsageSnapshot {
    totals: UsageSummaryTotals | null;
    byDay: UsageSummaryGrouped | null;
    byModel: UsageSummaryGrouped | null;
    byAgent: UsageSummaryGrouped | null;
    byWork: UsageSummaryGrouped | null;
}

interface UsageCreditsSettingsProps {
    /** Period the server rendered the initial snapshot with (B20). */
    initialPeriod: UsagePeriod;
    initialTotals: UsageSummaryTotals | null;
    initialByDay: UsageSummaryGrouped | null;
    initialByModel: UsageSummaryGrouped | null;
    initialByAgent: UsageSummaryGrouped | null;
    initialByWork: UsageSummaryGrouped | null;
    accountWide: AccountWideUsage | null;
    /** How a credit is priced (billing spec FR-13); null when the API call failed. */
    pricing?: CreditsPricing | null;
}

/** How many calendar months the month picker offers (B20). */
const MONTH_OPTION_COUNT = 12;

async function fetchUsage<T>(query: string): Promise<T> {
    // eslint-disable-next-line no-restricted-syntax -- EW-790 ok
    const response = await fetch(`/api/credits/usage-summary${query}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

function StatTile({ label, value, testId }: { label: string; value: string; testId: string }) {
    // Monochrome KPI tiles per the house UI pattern — status colour
    // belongs on table rows, never on the summary grid.
    return (
        <div
            data-testid={testId}
            className="rounded-lg border border-border dark:border-border-dark p-4"
        >
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{label}</p>
            <p className="mt-1 text-xl font-semibold text-text dark:text-text-dark">{value}</p>
        </div>
    );
}

function ChartCard({
    title,
    action,
    children,
}: {
    title: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-lg border border-border dark:border-border-dark p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h3>
                {action}
            </div>
            {children}
        </div>
    );
}

export function UsageCreditsSettings({
    initialPeriod,
    initialTotals,
    initialByDay,
    initialByModel,
    initialByAgent,
    initialByWork,
    accountWide,
    pricing = null,
}: UsageCreditsSettingsProps) {
    const t = useTranslations('dashboard.settings.usage');

    const initialSnapshot = useMemo<UsageSnapshot>(
        () => ({
            totals: initialTotals,
            byDay: initialByDay,
            byModel: initialByModel,
            byAgent: initialByAgent,
            byWork: initialByWork,
        }),
        [initialTotals, initialByDay, initialByModel, initialByAgent, initialByWork],
    );

    // B20 — one period drives the WHOLE page (tiles + all four charts),
    // and it accepts a `YYYY-MM` month as well as the rolling ranges.
    // Each period's snapshot is cached so flipping back is instant.
    const [period, setPeriod] = useState<UsagePeriod>(initialPeriod);
    const [snapshot, setSnapshot] = useState<UsageSnapshot>(initialSnapshot);
    const [cache, setCache] = useState<Record<string, UsageSnapshot>>({
        [initialPeriod]: initialSnapshot,
    });
    const [loading, setLoading] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    // Newest-first month options; the server-rendered period is included
    // even when it predates the window (a `?period=` deep link).
    const monthOptions = useMemo(() => {
        const months = recentUsageMonths(MONTH_OPTION_COUNT);
        if (isUsageMonthPeriod(initialPeriod) && !months.includes(initialPeriod)) {
            months.push(initialPeriod);
        }
        return months;
    }, [initialPeriod]);

    const handlePeriodChange = async (next: UsagePeriod) => {
        if (next === period) {
            return;
        }
        setPeriod(next);
        setLoadFailed(false);

        const cached = cache[next];
        if (cached) {
            setSnapshot(cached);
            return;
        }

        setLoading(true);
        try {
            const [totals, byDay, byModel, byAgent, byWork] = await Promise.all([
                fetchUsage<UsageSummaryTotals>(buildUsageSummaryQuery({ period: next })),
                fetchUsage<UsageSummaryGrouped>(
                    buildUsageSummaryQuery({ groupBy: 'day', period: next }),
                ),
                fetchUsage<UsageSummaryGrouped>(
                    buildUsageSummaryQuery({ groupBy: 'model', period: next }),
                ),
                fetchUsage<UsageSummaryGrouped>(
                    buildUsageSummaryQuery({ groupBy: 'agent', period: next }),
                ),
                fetchUsage<UsageSummaryGrouped>(
                    buildUsageSummaryQuery({ groupBy: 'work', period: next }),
                ),
            ]);
            const fresh: UsageSnapshot = { totals, byDay, byModel, byAgent, byWork };
            setCache((current) => ({ ...current, [next]: fresh }));
            setSnapshot(fresh);
        } catch {
            setLoadFailed(true);
        } finally {
            setLoading(false);
        }
    };

    const selectedMonth = isUsageMonthPeriod(period) ? period : '';
    const exportHref = `/api/credits/usage/export${buildUsageExportQuery({ period })}`;
    const periodLabel = isUsageMonthPeriod(period) ? formatUsageMonthLabel(period) : period;

    // `accountWide` is the CURRENT month's account-wide spend; it must not
    // stand in for the tile once the user selects another period.
    const currentMonth = useMemo(() => currentUsageMonth(), []);
    const showsCurrentMonth = period === currentMonth;

    const { totals, byDay, byModel, byAgent, byWork } = snapshot;
    const dataUnavailable = !totals && !byDay && !byModel && !byAgent && !byWork;

    return (
        <div className="space-y-8" data-testid="usage-credits-settings">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h2>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>

                {/* ── B20 period selector + B21 CSV export ─────────── */}
                <div
                    role="group"
                    aria-label={t('period.label')}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="usage-period-bar"
                >
                    {USAGE_ROLLING_PERIODS.map((range) => (
                        <Button
                            key={range}
                            variant={period === range ? 'primary' : 'secondary'}
                            className={cn('text-xs px-3 py-1')}
                            data-testid={`usage-range-${range}`}
                            onClick={() => handlePeriodChange(range)}
                        >
                            {t(`charts.range${range}`)}
                        </Button>
                    ))}
                    <select
                        aria-label={t('period.monthLabel')}
                        data-testid="usage-period-month"
                        value={selectedMonth}
                        onChange={(event) => {
                            const next = parseUsagePeriod(event.target.value);
                            if (next) {
                                void handlePeriodChange(next);
                            }
                        }}
                        className="rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1 text-xs text-text dark:text-text-dark"
                    >
                        <option value="">{t('period.monthPlaceholder')}</option>
                        {monthOptions.map((month) => (
                            <option key={month} value={month}>
                                {formatUsageMonthLabel(month)}
                            </option>
                        ))}
                    </select>
                    <a
                        href={exportHref}
                        download
                        data-testid="usage-export-csv"
                        title={t('export.csvHint', { period: periodLabel })}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                    >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('export.csv')}
                    </a>
                </div>
            </div>

            {dataUnavailable || loadFailed ? (
                <div
                    data-testid="usage-load-error"
                    className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                    {t('loadError')}
                </div>
            ) : null}

            {/* ── §4.1/§4.2 — period summary tiles ─────────────────── */}
            {totals ? (
                <div
                    className="grid grid-cols-2 gap-4 sm:grid-cols-3 @5xl/main:grid-cols-7"
                    data-testid="usage-summary-tiles"
                >
                    <StatTile
                        label={t('tiles.balance')}
                        value={formatCreditsAsDollars(totals.balanceCredits)}
                        testId="usage-tile-balance"
                    />
                    <StatTile
                        label={t('tiles.consumed')}
                        value={formatCreditsAsDollars(totals.creditsConsumed)}
                        testId="usage-tile-consumed"
                    />
                    <StatTile
                        label={t('tiles.added')}
                        value={formatCreditsAsDollars(totals.creditsAdded)}
                        testId="usage-tile-added"
                    />
                    {(totals.creditsExpired ?? 0) > 0 ? (
                        <StatTile
                            label={t('tiles.expired')}
                            value={formatCreditsAsDollars(totals.creditsExpired ?? 0)}
                            testId="usage-tile-expired"
                        />
                    ) : null}
                    <StatTile
                        label={t('tiles.spend')}
                        value={formatCents(
                            showsCurrentMonth
                                ? (accountWide?.currentSpendCents ?? totals.spendCents)
                                : totals.spendCents,
                        )}
                        testId="usage-tile-spend"
                    />
                    <StatTile
                        label={t('tiles.tasksCompleted')}
                        value={String(totals.tasksCompleted)}
                        testId="usage-tile-tasks"
                    />
                    <StatTile
                        label={t('tiles.worksActive')}
                        value={String(totals.worksActive)}
                        testId="usage-tile-works"
                    />
                    <StatTile
                        label={t('tiles.agentRuns')}
                        value={String(totals.agentRuns)}
                        testId="usage-tile-runs"
                    />
                </div>
            ) : null}
            {totals ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark -mt-4">
                    {t('tiles.periodNote', { period: totals.period })}
                </p>
            ) : null}
            {pricing ? (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark -mt-2"
                    data-testid="usage-pricing-note"
                >
                    {pricing.marginPercent > 0
                        ? t('tiles.pricingNoteWithMargin', {
                              perDollar: pricing.creditsPerDollar,
                              margin: pricing.marginPercent,
                          })
                        : t('tiles.pricingNote', { perDollar: pricing.creditsPerDollar })}
                </p>
            ) : null}

            {/* ── §4.3 — usage per day ─────────────────────────────── */}
            <ChartCard title={t('charts.byDay')}>
                {loading ? (
                    <p
                        className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="usage-by-day-loading"
                    >
                        {t('charts.loading')}
                    </p>
                ) : loadFailed ? (
                    <p
                        className="py-10 text-center text-xs text-danger"
                        data-testid="usage-by-day-error"
                    >
                        {t('charts.error')}
                    </p>
                ) : (
                    <UsageByDayChart rows={byDay?.rows ?? []} emptyLabel={t('charts.empty')} />
                )}
            </ChartCard>

            {/* ── §4.3 — by model / by agent / by Work ─────────────── */}
            <div className="grid gap-4 @3xl/main:grid-cols-2">
                <ChartCard title={t('charts.byModel')}>
                    <UsageBreakdownChart
                        rows={byModel?.rows ?? []}
                        emptyLabel={t('charts.empty')}
                        unattributedLabel={t('charts.unattributed')}
                        testId="usage-by-model-chart"
                    />
                </ChartCard>
                <ChartCard title={t('charts.byAgent')}>
                    <UsageBreakdownChart
                        rows={byAgent?.rows ?? []}
                        emptyLabel={t('charts.empty')}
                        unattributedLabel={t('charts.unattributed')}
                        testId="usage-by-agent-chart"
                    />
                </ChartCard>
            </div>
            <ChartCard title={t('charts.byWork')}>
                <UsageBreakdownChart
                    rows={byWork?.rows ?? []}
                    emptyLabel={t('charts.empty')}
                    unattributedLabel={t('charts.unattributed')}
                    testId="usage-by-work-chart"
                />
            </ChartCard>
        </div>
    );
}
