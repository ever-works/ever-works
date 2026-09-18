'use client';

import { useTranslations } from 'next-intl';
import type { ScheduleSourceType } from '@/lib/api/schedules';
import { SOURCE_META, SOURCE_ORDER } from './SchedulesList';
import { type SchedulesFilterState } from './schedules-filters.shared';

/**
 * The source picker for the Schedules list: `All`, then one chip per source
 * the workspace actually has, each carrying its count — plus the "Active only"
 * switch that sits with them.
 *
 * The counts come from the page's PRE-FILTER breakdown
 * (`unfilteredCountsBySourceType`), not the filtered one. That distinction is
 * the whole point: the filtered counts are taken after `sourceType` has been
 * applied, so picking "Data sync" would zero every other chip and leave no way
 * back or sideways. The pre-filter numbers answer the question a picker is
 * actually asking — "how much of each kind do I have?" — and stay stable while
 * the other filters narrow the list underneath.
 *
 * Only sources with at least one schedule are offered, so a workspace with two
 * kinds of schedule does not show five empty chips. `All` always is, and
 * carries the unfiltered total.
 */
export function ScheduleSourceChips({
    value,
    counts,
    total,
    onSourceChange,
    onActiveOnlyChange,
}: {
    value: SchedulesFilterState;
    /** Pre-filter counts per source; `undefined` on an older API replica. */
    counts: Record<ScheduleSourceType, number> | undefined;
    /** Pre-filter total, for the `All` chip. */
    total: number;
    onSourceChange: (source: ScheduleSourceType | '') => void;
    onActiveOnlyChange: (activeOnly: boolean) => void;
}) {
    const t = useTranslations('dashboard.schedules');
    const available = SOURCE_ORDER.filter((source) => (counts?.[source] ?? 0) > 0);

    return (
        <div className="flex flex-wrap items-center gap-2" data-testid="schedules-source-chips">
            <Chip
                active={value.source === ''}
                onClick={() => onSourceChange('')}
                label={t('filters.all')}
                count={total}
                testId="schedules-source-chip-all"
            />
            {available.map((source) => (
                <Chip
                    key={source}
                    active={value.source === source}
                    onClick={() => onSourceChange(source)}
                    label={t(`sourceTypes.${SOURCE_META[source].labelKey}`)}
                    count={counts?.[source] ?? 0}
                    testId={`schedules-source-chip-${source}`}
                />
            ))}
            <label className="ml-auto inline-flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                <input
                    type="checkbox"
                    checked={value.activeOnly}
                    onChange={(event) => onActiveOnlyChange(event.target.checked)}
                    data-testid="schedules-filter-active-only"
                    className="rounded border-border dark:border-border-dark"
                />
                {t('filters.activeOnly')}
            </label>
        </div>
    );
}

function Chip({
    active,
    onClick,
    label,
    count,
    testId,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    count: number;
    testId: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            data-testid={testId}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border text-text-secondary hover:bg-surface-secondary dark:border-border-dark dark:text-text-secondary-dark dark:hover:bg-surface-secondary-dark'
            }`}
        >
            <span>{label}</span>
            <span className="tabular-nums opacity-70">{count}</span>
        </button>
    );
}
