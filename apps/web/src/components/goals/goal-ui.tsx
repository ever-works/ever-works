'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import type { GoalComparator, GoalOutcome } from '@/lib/api/goals';

/**
 * Goals & Metrics — PR-8. Shared presentational helpers for the Goals
 * surface (list card + detail page), so the comparator glyph, value
 * formatting, and outcome badge render identically everywhere.
 */

/** Comparator direction rendered as a math glyph (≥ grow / ≤ shrink). */
export const COMPARATOR_GLYPH: Record<GoalComparator, string> = {
    gte: '≥',
    lte: '≤',
};

const OUTCOME_STYLES: Record<GoalOutcome, string> = {
    achieved: 'bg-success/10 text-success border-success/20',
    missed: 'bg-danger/10 text-danger border-danger/20',
    abandoned:
        'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted border-border/70 dark:border-border-dark/70',
};

/**
 * Format an ISO timestamp for display. Locale/timezone formatting
 * differs between the server and client render, so callers wrap the
 * output in an element with `suppressHydrationWarning`.
 */
export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/**
 * Format a metric observation for display: compact thousands
 * grouping, at most two decimals with trailing zeros trimmed, unit
 * suffix. `null`/non-finite renders an em dash.
 */
export function formatMetricValue(value: number | null | undefined, unit?: string): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '—';
    }
    const rounded = Math.round(value * 100) / 100;
    const formatted = rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return unit ? `${formatted} ${unit}` : formatted;
}

/**
 * Terminal-outcome pill (achieved / missed / abandoned). Labels come
 * from the `dashboard.goalsPage.outcomes` namespace so both surfaces
 * share one source of truth.
 */
export function OutcomeBadge({ outcome, className }: { outcome: GoalOutcome; className?: string }) {
    const t = useTranslations('dashboard.goalsPage');
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                OUTCOME_STYLES[outcome],
                className,
            )}
        >
            {t(`outcomes.${outcome}`)}
        </span>
    );
}
