'use client';

import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCents } from '@/lib/api/credits.shared';
import {
    costsSeriesColor,
    formatCostsDayTick,
    COSTS_OTHER_SERIES_KEY,
    COSTS_UNATTRIBUTED_SERIES_KEY,
    type CostsDailyBucket,
    type CostsDailySeries,
} from '@/lib/api/costs.shared';

interface CostsDailyStackedChartProps {
    series: CostsDailySeries[];
    days: CostsDailyBucket[];
    emptyLabel: string;
    /** Localized copy for the two sentinel series keys. */
    otherLabel: string;
    unattributedLabel: string;
    /** Localized fallback for an Agent whose row no longer resolves. */
    unknownAgentLabel: string;
}

/**
 * Daily spend, stacked by Agent (Costs tab).
 *
 * Same recharts building blocks as `UsageByDayChart` — the app's
 * existing chart approach, so no new dependency — with one `<Bar>` per
 * series sharing a `stackId`. Series order comes from the API (spend
 * descending), so the biggest spender is the base of every stack and the
 * legend reads top-down in the same order.
 */
export function CostsDailyStackedChart({
    series,
    days,
    emptyLabel,
    otherLabel,
    unattributedLabel,
    unknownAgentLabel,
}: CostsDailyStackedChartProps) {
    const labelFor = (entry: CostsDailySeries): string => {
        if (entry.key === COSTS_OTHER_SERIES_KEY) {
            return otherLabel;
        }
        if (entry.key === COSTS_UNATTRIBUTED_SERIES_KEY) {
            return unattributedLabel;
        }
        return entry.label ?? unknownAgentLabel;
    };

    // A window with no spend still returns a dense day axis, so "no data"
    // is the absence of SERIES, not the absence of days.
    if (series.length === 0 || days.length === 0) {
        return (
            <p
                className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="costs-daily-chart-empty"
            >
                {emptyLabel}
            </p>
        );
    }

    // Recharts reads each series off a flat key on the row, so the
    // per-day `costs` map is spread out here. Missing keys become 0 so a
    // gap day does not break the stack.
    const chartData = days.map((bucket) => {
        const row: Record<string, number | string> = { day: formatCostsDayTick(bucket.day) };
        for (const entry of series) {
            row[entry.key] = bucket.costs[entry.key] ?? 0;
        }
        return row;
    });

    return (
        <div className="h-64 w-full" data-testid="costs-daily-chart">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
                    <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10 }}
                        interval="preserveStartEnd"
                        axisLine={false}
                        tickLine={false}
                    />
                    <YAxis
                        tick={{ fontSize: 10 }}
                        width={36}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(value: number) => `$${(value / 100).toFixed(0)}`}
                    />
                    <Tooltip
                        formatter={(value: number) => formatCents(value)}
                        contentStyle={{
                            background: 'rgba(15, 23, 42, 0.9)',
                            border: '1px solid rgba(148, 163, 184, 0.2)',
                            borderRadius: 6,
                            fontSize: 12,
                        }}
                        labelStyle={{ color: '#cbd5e1' }}
                        itemStyle={{ color: '#f1f5f9' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {series.map((entry, index) => (
                        <Bar
                            key={entry.key}
                            dataKey={entry.key}
                            name={labelFor(entry)}
                            stackId="cost"
                            fill={costsSeriesColor(entry.key, index)}
                            // Only the topmost segment gets a rounded cap;
                            // rounding every segment leaves visible seams
                            // through the stack.
                            radius={index === series.length - 1 ? [2, 2, 0, 0] : undefined}
                        />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
