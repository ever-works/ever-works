'use client';

import { formatCents } from '@/lib/api/credits.shared';
import { formatSharePercent, shareBarWidth, type CostsByModelRow } from '@/lib/api/costs.shared';

interface CostsByModelListProps {
    rows: CostsByModelRow[];
    /** Window total — the denominator every share is computed against. */
    totalCostCents: number;
    emptyLabel: string;
    /** Localized label for rows whose capability never used a model. */
    noModelLabel: string;
    /** `(units) => localized string`, e.g. `1,204 units`. */
    formatUnits: (units: number) => string;
    /** `(total) => localized string` for the panel footer. */
    formatTotal: (total: string) => string;
}

/**
 * Per-model spend with a share bar (Costs tab).
 *
 * A list with CSS bars rather than a recharts chart: the panel needs the
 * model id, the amount AND the share on one line, which a bar chart's
 * category axis truncates. Model ids are long and arbitrary, so they get
 * the full row width and the bar sits underneath.
 */
export function CostsByModelList({
    rows,
    totalCostCents,
    emptyLabel,
    noModelLabel,
    formatUnits,
    formatTotal,
}: CostsByModelListProps) {
    if (rows.length === 0) {
        return (
            <p
                className="py-10 text-center text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="costs-by-model-empty"
            >
                {emptyLabel}
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <ul className="space-y-3" data-testid="costs-by-model-list">
                {rows.map((row) => (
                    <li
                        key={row.modelId ?? '__none__'}
                        data-testid="costs-by-model-row"
                        className="space-y-1.5"
                    >
                        <div className="flex items-baseline justify-between gap-3">
                            <span
                                className="truncate text-sm text-text dark:text-text-dark"
                                title={row.modelId ?? noModelLabel}
                            >
                                {row.modelId ?? noModelLabel}
                            </span>
                            <span className="shrink-0 text-sm font-medium text-text dark:text-text-dark tabular-nums">
                                {formatCents(row.costCents)}
                                <span className="ml-2 text-xs font-normal text-text-muted dark:text-text-muted-dark">
                                    {formatSharePercent(row.sharePercent)}
                                </span>
                            </span>
                        </div>
                        <div
                            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover dark:bg-surface-hover-dark"
                            role="presentation"
                        >
                            <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: shareBarWidth(row.sharePercent) }}
                            />
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark tabular-nums">
                            {formatUnits(row.units)}
                        </p>
                    </li>
                ))}
            </ul>
            {/* The denominator, stated: shares only add up against it. */}
            <p
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="costs-by-model-total"
            >
                {formatTotal(formatCents(totalCostCents))}
            </p>
        </div>
    );
}
