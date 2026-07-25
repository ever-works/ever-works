'use client';

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCents, type UsageSummaryGroupRow } from '@/lib/api/credits.shared';

interface UsageBreakdownChartProps {
    rows: UsageSummaryGroupRow[];
    emptyLabel: string;
    /** Localized label for `key === null` (unattributed) rows. */
    unattributedLabel: string;
    testId: string;
    /** Cap the number of bars so one noisy dimension stays readable. */
    maxRows?: number;
}

/**
 * Wave 13 (PRD §4.3) — horizontal $ BarChart shared by the by-model /
 * by-agent / by-Work charts (`UsageByModelChart` / `UsageByAgentChart`
 * / `UsageByWorkChart` render through this with their own data +
 * testid). Same recharts building blocks as SpendTrendCard, rotated to
 * a category axis so long model/Agent/Work names stay legible.
 */
export function UsageBreakdownChart({
    rows,
    emptyLabel,
    unattributedLabel,
    testId,
    maxRows = 8,
}: UsageBreakdownChartProps) {
    const chartData = rows.slice(0, maxRows).map((row) => ({
        label: row.key === null ? unattributedLabel : row.label,
        costCents: row.costCents,
    }));

    if (chartData.length === 0) {
        return (
            <p
                className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                data-testid={`${testId}-empty`}
            >
                {emptyLabel}
            </p>
        );
    }

    // Height scales with the row count so short lists don't stretch.
    const height = Math.max(120, chartData.length * 36);

    return (
        <div className="w-full" style={{ height }} data-testid={testId}>
            <ResponsiveContainer width="100%" height="100%">
                <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ top: 0, right: 8, left: 8, bottom: 0 }}
                >
                    <XAxis
                        type="number"
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                    />
                    <YAxis
                        type="category"
                        dataKey="label"
                        width={140}
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
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
                    <Bar dataKey="costCents" fill="#3b82f6" radius={[0, 2, 2, 0]} barSize={18} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
