'use client';

import { AlertOctagon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { OwnerBudgetSummary } from '@/lib/api/missions';

export interface BudgetSummaryCardProps {
    summary: OwnerBudgetSummary;
    fallbackEmpty?: boolean;
}

function formatMoney(cents: number, currency: string): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
        }).format(cents / 100);
    } catch {
        return `$${(cents / 100).toFixed(2)}`;
    }
}

function formatPeriod(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function BudgetSummaryCard({ summary }: BudgetSummaryCardProps) {
    const t = useTranslations('dashboard.budgetSummary');
    const hasCap = summary.capCents !== null;
    const percent = summary.percentUsed ?? 0;
    const clampedPercent = Math.max(0, Math.min(100, percent));
    const overCap = hasCap && percent > 100;
    const barTone = summary.blocked ? 'bg-danger' : percent >= 90 ? 'bg-warning' : 'bg-info';

    return (
        <div className="space-y-4">
            {/* Period label */}
            <p className="text-[11px] font-medium text-text-muted dark:text-text-muted-dark uppercase tracking-wide">
                {formatPeriod(summary.periodStart)}
            </p>

            {/* Spend + Cap stats */}
            <div className="flex items-stretch divide-x divide-border/60 dark:divide-border-dark/60">
                <div className="flex-1 pr-4 min-w-0">
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-1">
                        {t('currentSpend')}
                    </p>
                    <p className="text-xl font-semibold text-text dark:text-text-dark tabular-nums truncate">
                        {formatMoney(summary.currentSpendCents, summary.currency)}
                    </p>
                </div>
                <div className="flex-1 pl-4 min-w-0">
                    <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-1">
                        {t('cap')}
                    </p>
                    {hasCap ? (
                        <p className="text-xl font-semibold text-text dark:text-text-dark tabular-nums truncate">
                            {formatMoney(summary.capCents ?? 0, summary.currency)}
                        </p>
                    ) : (
                        <p className="text-sm italic text-text-muted dark:text-text-muted-dark">
                            {t('noCap')}
                        </p>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            {hasCap && (
                <div className="space-y-2">
                    <div className="h-0.5 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden">
                        <div
                            className={cn('h-full rounded-full transition-all duration-500', barTone)}
                            style={{ width: `${clampedPercent}%` }}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
                            {t('percentUsed', { percent: percent.toFixed(1) })}
                        </span>
                        <div className="flex items-center gap-1.5">
                            {summary.blocked && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                                    <AlertOctagon className="w-3 h-3" />
                                    {t('blocked')}
                                </span>
                            )}
                            {overCap && !summary.blocked && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                                    {t('overCap')}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
