'use client';

import { cn } from '@/lib/utils/cn';
import { Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { GlobalBudgetSummary } from '@/lib/api/types-only';

interface BudgetOverviewCardProps {
    totalSpendCents: number;
    currency: string;
    periodLabel: string;
    globalBudget: GlobalBudgetSummary | null;
}

function formatCents(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

function progressColor(percent: number): string {
    if (percent >= 100) return 'bg-red-500';
    if (percent >= 90) return 'bg-amber-500';
    if (percent >= 75) return 'bg-yellow-500';
    return 'bg-blue-500';
}

export function BudgetOverviewCard({
    totalSpendCents,
    currency,
    periodLabel,
    globalBudget,
}: BudgetOverviewCardProps) {
    const t = useTranslations('dashboard.budgets');
    const cap = globalBudget?.monthlyCapCents ?? 0;
    const percent = globalBudget && cap > 0 ? Math.min(150, globalBudget.percentUsed) : 0;
    const visibleWidth = Math.min(100, percent);

    return (
        <div
            className={cn(
                'relative rounded-md p-1 transition-shadow duration-200 overflow-hidden',
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
                    <div
                        className={cn(
                            'rounded-md w-8 h-8 flex items-center justify-center',
                            'bg-surface dark:bg-white/6',
                        )}
                    >
                        <Wallet className="w-4.5 h-4.5 text-blue-500" strokeWidth={1.3} />
                    </div>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('overviewTitle', { period: periodLabel })}
                    </p>
                </div>

                <p className="mt-3 text-3xl text-text dark:text-text-dark truncate">
                    {formatCents(totalSpendCents, currency)}
                </p>

                {globalBudget ? (
                    <>
                        <div className="mt-4 h-2 w-full rounded-full bg-surface dark:bg-white/6 overflow-hidden">
                            <div
                                className={cn('h-full rounded-full transition-all', progressColor(percent))}
                                style={{ width: `${visibleWidth}%` }}
                            />
                        </div>
                        <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('overviewProgressLabel', {
                                percent,
                                cap: formatCents(cap, currency),
                            })}
                            {globalBudget.allowOverage ? t('overviewOverageSuffix') : ''}
                        </p>
                    </>
                ) : (
                    <p className="mt-4 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('overviewEmpty')}
                    </p>
                )}
            </div>
        </div>
    );
}
