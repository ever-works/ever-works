'use client';

import { AlertOctagon, BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { OwnerBudgetSummary } from '@/lib/api/missions';

/**
 * Phase 7 PR V — shared budget summary card. Renders the
 * `OwnerBudgetSummary` envelope returned by the PR U endpoints
 * (`GET /me/missions/:id/budget` + `GET /me/work-proposals/:id/budget`),
 * so the Mission detail Spend section and the (future) Idea
 * progress view + Work Agent settings page can all render the
 * same surface.
 *
 * Shape:
 *   - Header line with period label ("May 2026" derived from
 *     periodStart).
 *   - Current spend, formatted as a money string in the budget's
 *     currency.
 *   - When `capCents` is set: a progress bar + cap label + percent
 *     used + a danger pill if `blocked` is true.
 *   - When `capCents` is null: a "No cap set" inline hint plus
 *     spend-only display so the surface still carries useful info.
 *
 * Pure presentational — the parent owns fetching + error handling.
 */
export interface BudgetSummaryCardProps {
    summary: OwnerBudgetSummary;
    /**
     * Optional fallback rendered when `summary` is `null` (the
     * page-level fetch failed). Defaults to a friendly empty
     * surface so the section still occupies its slot.
     */
    fallbackEmpty?: boolean;
}

function formatMoney(cents: number, currency: string): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
        }).format(cents / 100);
    } catch {
        // Unknown currency code — fall back to plain cents → dollars.
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
    const barTone = summary.blocked
        ? 'bg-danger'
        : percent >= 90
          ? 'bg-warning'
          : 'bg-primary';

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-text-muted dark:text-text-muted-dark">
                <BarChart3 className="w-3.5 h-3.5" />
                <span>{t('period', { period: formatPeriod(summary.periodStart) })}</span>
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                    <div className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('currentSpend')}
                    </div>
                    <div className="text-xl font-semibold text-text dark:text-text-dark">
                        {formatMoney(summary.currentSpendCents, summary.currency)}
                    </div>
                </div>
                {hasCap ? (
                    <div className="text-right">
                        <div className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('cap')}
                        </div>
                        <div className="text-sm font-medium text-text-secondary dark:text-text-secondary-dark">
                            {formatMoney(summary.capCents ?? 0, summary.currency)}
                        </div>
                    </div>
                ) : (
                    <div className="text-right">
                        <div className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('cap')}
                        </div>
                        <div className="text-sm italic text-text-muted dark:text-text-muted-dark">
                            {t('noCap')}
                        </div>
                    </div>
                )}
            </div>

            {hasCap && (
                <>
                    <div className="h-2 rounded-full bg-surface-secondary dark:bg-surface-secondary-dark overflow-hidden">
                        <div
                            className={cn('h-full transition-all', barTone)}
                            style={{ width: `${clampedPercent}%` }}
                        />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('percentUsed', { percent: percent.toFixed(1) })}
                        </span>
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
                </>
            )}
        </div>
    );
}
