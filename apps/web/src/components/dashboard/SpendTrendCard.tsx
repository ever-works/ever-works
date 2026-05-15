'use client';

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils/cn';
import { Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { DailySpendBucket } from '@/lib/api/types-only';

interface SpendTrendCardProps {
    buckets: DailySpendBucket[];
    currency: string;
    periodLabel: string;
}

function formatCents(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

export function SpendTrendCard({ buckets, currency, periodLabel }: SpendTrendCardProps) {
    const t = useTranslations('dashboard.budgets');
    const chartData = buckets.map((b) => ({
        day: b.day.slice(5),
        costCents: b.costCents,
        costLabel: formatCents(b.costCents, currency),
    }));

    return (
        <div
            className={cn(
                'relative rounded-md p-1 overflow-hidden',
                'border border-card-border dark:border-border-dark',
            )}
        >
            <div
                className={cn(
                    'rounded-sm p-5 overflow-hidden',
                    'bg-card dark:bg-surface-secondary-dark',
                    'border border-card-border dark:border-border-dark',
                )}
            >
                <div className="flex items-center space-x-2">
                    <div className="rounded-md w-8 h-8 flex items-center justify-center bg-surface dark:bg-white/6">
                        <Activity className="w-4.5 h-4.5 text-emerald-500" strokeWidth={1.3} />
                    </div>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('trendTitle', { period: periodLabel })}
                    </p>
                </div>

                {chartData.length === 0 ? (
                    <p className="mt-4 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('trendEmpty')}
                    </p>
                ) : (
                    <div className="mt-4 h-32 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                                data={chartData}
                                margin={{ top: 0, right: 0, left: -10, bottom: 0 }}
                            >
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 10 }}
                                    interval="preserveStartEnd"
                                    axisLine={false}
                                    tickLine={false}
                                />
                                <YAxis
                                    tick={{ fontSize: 10 }}
                                    width={32}
                                    axisLine={false}
                                    tickLine={false}
                                    tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`}
                                />
                                <Tooltip
                                    formatter={(value: number) => formatCents(value, currency)}
                                    labelFormatter={(label) => t('trendDayLabel', { day: label })}
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
                )}
            </div>
        </div>
    );
}
