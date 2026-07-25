'use client';

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCents, type UsageSummaryGroupRow } from '@/lib/api/credits.shared';

interface UsageByDayChartProps {
    rows: UsageSummaryGroupRow[];
    emptyLabel: string;
}

/**
 * Wave 13 (PRD §4.3) — daily $ BarChart for the Usage & Credits page.
 * Cloned from `components/dashboard/SpendTrendCard.tsx` (recharts
 * ResponsiveContainer + cents→$ tick formatter + dark tooltip).
 */
export function UsageByDayChart({ rows, emptyLabel }: UsageByDayChartProps) {
    const chartData = rows.map((row) => ({
        day: row.label.slice(5), // YYYY-MM-DD → MM-DD
        costCents: row.costCents,
    }));

    if (chartData.length === 0) {
        return (
            <p
                className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="usage-by-day-empty"
            >
                {emptyLabel}
            </p>
        );
    }

    return (
        <div className="h-48 w-full" data-testid="usage-by-day-chart">
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
                        tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
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
                    <Bar dataKey="costCents" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
