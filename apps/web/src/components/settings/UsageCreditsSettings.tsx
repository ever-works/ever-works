'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { UsageByDayChart } from '@/components/settings/usage/UsageByDayChart';
import { UsageBreakdownChart } from '@/components/settings/usage/UsageBreakdownChart';
import {
    formatCents,
    formatCreditsAsDollars,
    type UsageSummaryGrouped,
    type UsageSummaryTotals,
} from '@/lib/api/credits.shared';
import type { AccountWideUsage } from '@/lib/api/usage';

interface UsageCreditsSettingsProps {
    initialTotals: UsageSummaryTotals | null;
    initialByDay: UsageSummaryGrouped | null;
    initialByModel: UsageSummaryGrouped | null;
    initialByAgent: UsageSummaryGrouped | null;
    initialByWork: UsageSummaryGrouped | null;
    accountWide: AccountWideUsage | null;
}

type DayRange = '7d' | '30d';

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
    initialTotals,
    initialByDay,
    initialByModel,
    initialByAgent,
    initialByWork,
    accountWide,
}: UsageCreditsSettingsProps) {
    const t = useTranslations('dashboard.settings.usage');

    // 7d/30d toggle for the by-day chart: refetch through the web
    // proxy, cache each range so flipping back is instant.
    const [dayRange, setDayRange] = useState<DayRange>('30d');
    const [byDayCache, setByDayCache] = useState<Record<DayRange, UsageSummaryGrouped | null>>({
        '30d': initialByDay,
        '7d': null,
    });
    const [dayLoading, setDayLoading] = useState(false);
    const [dayError, setDayError] = useState(false);

    const handleRangeChange = async (range: DayRange) => {
        setDayRange(range);
        if (byDayCache[range]) {
            return;
        }
        setDayLoading(true);
        setDayError(false);
        try {
            const response = await fetch(`/api/credits/usage-summary?groupBy=day&period=${range}`, {
                method: 'GET',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = (await response.json()) as UsageSummaryGrouped;
            setByDayCache((cache) => ({ ...cache, [range]: data }));
        } catch {
            setDayError(true);
        } finally {
            setDayLoading(false);
        }
    };

    const byDay = byDayCache[dayRange];
    const dataUnavailable =
        !initialTotals && !initialByDay && !initialByModel && !initialByAgent && !initialByWork;

    return (
        <div className="space-y-8" data-testid="usage-credits-settings">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {dataUnavailable ? (
                <div
                    data-testid="usage-load-error"
                    className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                    {t('loadError')}
                </div>
            ) : null}

            {/* ── §4.1/§4.2 — period summary tiles ─────────────────── */}
            {initialTotals ? (
                <div
                    className="grid grid-cols-2 gap-4 sm:grid-cols-3 @5xl/main:grid-cols-7"
                    data-testid="usage-summary-tiles"
                >
                    <StatTile
                        label={t('tiles.balance')}
                        value={formatCreditsAsDollars(initialTotals.balanceCredits)}
                        testId="usage-tile-balance"
                    />
                    <StatTile
                        label={t('tiles.consumed')}
                        value={formatCreditsAsDollars(initialTotals.creditsConsumed)}
                        testId="usage-tile-consumed"
                    />
                    <StatTile
                        label={t('tiles.added')}
                        value={formatCreditsAsDollars(initialTotals.creditsAdded)}
                        testId="usage-tile-added"
                    />
                    <StatTile
                        label={t('tiles.spend')}
                        value={formatCents(
                            accountWide?.currentSpendCents ?? initialTotals.spendCents,
                        )}
                        testId="usage-tile-spend"
                    />
                    <StatTile
                        label={t('tiles.tasksCompleted')}
                        value={String(initialTotals.tasksCompleted)}
                        testId="usage-tile-tasks"
                    />
                    <StatTile
                        label={t('tiles.worksActive')}
                        value={String(initialTotals.worksActive)}
                        testId="usage-tile-works"
                    />
                    <StatTile
                        label={t('tiles.agentRuns')}
                        value={String(initialTotals.agentRuns)}
                        testId="usage-tile-runs"
                    />
                </div>
            ) : null}
            {initialTotals ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark -mt-4">
                    {t('tiles.periodNote', { period: initialTotals.period })}
                </p>
            ) : null}

            {/* ── §4.3 — usage per day (7d/30d toggle) ─────────────── */}
            <ChartCard
                title={t('charts.byDay')}
                action={
                    <div className="flex gap-1">
                        {(['7d', '30d'] as const).map((range) => (
                            <Button
                                key={range}
                                variant={dayRange === range ? 'primary' : 'secondary'}
                                className={cn('text-xs px-3 py-1')}
                                data-testid={`usage-range-${range}`}
                                onClick={() => handleRangeChange(range)}
                            >
                                {t(`charts.range${range}`)}
                            </Button>
                        ))}
                    </div>
                }
            >
                {dayLoading ? (
                    <p
                        className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="usage-by-day-loading"
                    >
                        {t('charts.loading')}
                    </p>
                ) : dayError ? (
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
                        rows={initialByModel?.rows ?? []}
                        emptyLabel={t('charts.empty')}
                        unattributedLabel={t('charts.unattributed')}
                        testId="usage-by-model-chart"
                    />
                </ChartCard>
                <ChartCard title={t('charts.byAgent')}>
                    <UsageBreakdownChart
                        rows={initialByAgent?.rows ?? []}
                        emptyLabel={t('charts.empty')}
                        unattributedLabel={t('charts.unattributed')}
                        testId="usage-by-agent-chart"
                    />
                </ChartCard>
            </div>
            <ChartCard title={t('charts.byWork')}>
                <UsageBreakdownChart
                    rows={initialByWork?.rows ?? []}
                    emptyLabel={t('charts.empty')}
                    unattributedLabel={t('charts.unattributed')}
                    testId="usage-by-work-chart"
                />
            </ChartCard>
        </div>
    );
}
